import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import {
  aggregatePendingChangeSources,
  api,
  compareDeploymentBuilds,
  currentTeamCityBranch,
  extractVenioVersion,
  filterTeamCityBuildsForBranch,
  getServerStatus,
  normalizeTeamCityDate,
  normalizeTeamCityBranch,
  normalizeReleaseCheck,
  offlineServerStatus,
  parseDeployedBuildsPage,
  parseTeamCityDiskStatuses,
  parseTeamCityServiceStatuses,
  readInventory,
  scheduledJobManager,
  summarizeTeamCityAgentStatus,
  teamCityBuildPayload,
  validateInventory,
  validateRuntimeConfig,
} from './index.mjs'

test('extracts the machine release version and maps it to a TeamCity branch', () => {
  assert.equal(extractVenioVersion({ venioVersion: '11.8.5.0' }), '11.8.5.0')
  assert.equal(extractVenioVersion({ d: '{"venioVersion":{"Version":"11.8.4.0"}}' }), '11.8.4.0')
  assert.equal(normalizeTeamCityBranch('11.8.5.0'), 'v11.8.5.0')
  assert.equal(normalizeTeamCityBranch('v11.8.4'), 'v11.8.4.0')
  assert.equal(normalizeTeamCityBranch('not-a-version'), undefined)
  assert.equal(normalizeReleaseCheck('11.8.5.0'), 'v11.8.5.0')
  assert.equal(normalizeReleaseCheck('v11.8.6'), 'v11.8.6.0')
  assert.equal(normalizeReleaseCheck('release/11.8.5'), undefined)
})

test('uses CURRENT_RELEASE as the exact TeamCity activity branch', () => {
  const previousRelease = process.env.CURRENT_RELEASE
  try {
    process.env.CURRENT_RELEASE = 'release/11.8.5-hotfix'
    assert.equal(currentTeamCityBranch(), 'release/11.8.5-hotfix')
  } finally {
    if (previousRelease === undefined) delete process.env.CURRENT_RELEASE
    else process.env.CURRENT_RELEASE = previousRelease
  }
})

test('keeps active TeamCity status isolated to the selected branch', () => {
  const builds = [
    { id: 1, branch: 'v11.8.4.0', state: 'running' },
    { id: 2, branch: 'v11.8.5.0', state: 'running' },
    { id: 3, state: 'queued' },
  ]
  assert.deepEqual(filterTeamCityBuildsForBranch(builds, 'v11.8.4.0'), [builds[0], builds[2]])
})

test('offline test machines skip dependent status data and controls', async () => {
  const server = {
    name: 'Offline-QC',
    ip: '192.0.2.10',
    group: 'Test machines',
    environment: 'QA',
    location: 'Test',
    services: [{ name: 'Search' }, { name: 'Export' }],
    deploymentBuildTypeId: 'Deploy_Offline_QC',
  }
  assert.deepEqual(offlineServerStatus(server), {
    ...server,
    status: 'offline',
    services: [{ name: 'Search', status: 'unknown' }, { name: 'Export', status: 'unknown' }],
    diskSpace: { status: 'unknown', volumes: [], reason: 'Machine is offline; disk check was skipped' },
  })
  const teamCitySource = { then: () => assert.fail('TeamCity status must not be awaited for an offline machine') }
  assert.deepEqual(await getServerStatus(server, teamCitySource, new Map(), undefined, false), offlineServerStatus(server))
})

test('builds the TeamCity Console payload with the release version properties', () => {
  assert.deepEqual(teamCityBuildPayload(
    'MainRepository_Venio_VenioFRPWixSetup_Default',
    [
      { name: 'reverse.dep.*.system.Version', value: '11.8.5.0' },
      { name: 'system.Version', value: '11.8.5.0' },
    ],
    '',
    { branchName: 'v11.8.5.0' },
  ), {
    buildType: { id: 'MainRepository_Venio_VenioFRPWixSetup_Default' },
    comment: { text: '' },
    branchName: 'v11.8.5.0',
    properties: {
      property: [
        { name: 'reverse.dep.*.system.Version', value: '11.8.5.0' },
        { name: 'system.Version', value: '11.8.5.0' },
      ],
    },
  })
})

test('parses deployed component builds from build.html', () => {
  const html = `<!doctype html><h2>Console :4348</h2><h2>OnDemand :5035</h2><h2>Web :6026</h2><h2>Venio-Next: 34972</h2>`
  assert.deepEqual(parseDeployedBuildsPage(html), {
    Console: '4348',
    OnDemand: '5035',
    Web: '6026',
    'Venio-Next': '34972',
  })
  assert.equal(parseDeployedBuildsPage('<h1>No build numbers</h1>'), undefined)
})

test('compares deployed builds with latest successful TeamCity builds', () => {
  const deployed = { Console: '4348', OnDemand: '5034', Web: '6026' }
  const latest = {
    Console: { number: '4348', webUrl: 'https://teamcity.example/console/4348' },
    OnDemand: { number: '5035', webUrl: 'https://teamcity.example/ondemand/5035' },
    Web: { number: '6026', webUrl: 'https://teamcity.example/web/6026' },
  }
  assert.deepEqual(compareDeploymentBuilds(deployed, latest), {
    status: 'available',
    changedComponents: ['OnDemand'],
    comparisons: [
      { name: 'Console', deployed: '4348', available: '4348', status: 'current', webUrl: 'https://teamcity.example/console/4348' },
      { name: 'OnDemand', deployed: '5034', available: '5035', status: 'available', webUrl: 'https://teamcity.example/ondemand/5035' },
      { name: 'Web', deployed: '6026', available: '6026', status: 'current', webUrl: 'https://teamcity.example/web/6026' },
    ],
  })
  const qc03Comparison = compareDeploymentBuilds(
    { Console: '4337', OnDemand: '5027', Web: '6007', 'Venio-Next': '34768' },
    { Console: { number: '4337' }, OnDemand: { number: '5027' }, Web: { number: '6013' } },
  )
  assert.equal(qc03Comparison.status, 'available')
  assert.deepEqual(qc03Comparison.changedComponents, ['Web'])
  assert.equal(compareDeploymentBuilds(deployed, {}).status, 'unknown')
})

test('normalizes TeamCity timestamps', () => {
  assert.equal(normalizeTeamCityDate('20260903T101530+0545'), '2026-09-03T04:30:30.000Z')
  assert.equal(normalizeTeamCityDate('not-a-date'), undefined)
})

test('deduplicates Console pending changes across dependency configurations', () => {
  assert.deepEqual(aggregatePendingChangeSources([
    {
      buildTypeId: 'Console_Desktop',
      name: 'VenioDesktop',
      changes: [{ id: 101 }, { id: 102 }],
      pendingChanges: 2,
    },
    {
      buildTypeId: 'Console_Search',
      name: 'SearchServer',
      changes: [{ id: 102 }, { id: 103 }],
      pendingChanges: 2,
    },
    {
      buildTypeId: 'Console_Setup',
      name: 'VenioFPRWixSetup',
      changes: [],
      pendingChanges: 0,
    },
  ]), {
    pendingChanges: 3,
    pendingSources: [
      { buildTypeId: 'Console_Desktop', name: 'VenioDesktop', pendingChanges: 2, webUrl: undefined },
      { buildTypeId: 'Console_Search', name: 'SearchServer', pendingChanges: 2, webUrl: undefined },
    ],
    truncated: false,
  })
})

test('derives TeamCity agent availability from connected instances and running builds', () => {
  const inventory = {
    status: 'available',
    agents: [
      { id: 7, ip: '172.31.76.142', connected: true, build: { id: 163561, state: 'running', buildTypeId: 'Api_Setup' } },
      { id: 8, ip: '172.31.76.142', connected: true },
      { id: 9, ip: '172.31.1.10', connected: false },
    ],
  }
  assert.deepEqual(summarizeTeamCityAgentStatus('172.31.76.142', inventory), {
    status: 'online',
    instances: 2,
    connectedInstances: 2,
    runningBuilds: [{
      agentId: 7,
      agentName: undefined,
      id: 163561,
      number: undefined,
      state: 'running',
      status: undefined,
      webUrl: undefined,
      buildTypeId: 'Api_Setup',
    }],
  })
  assert.equal(summarizeTeamCityAgentStatus('172.31.1.10', inventory).status, 'offline')
  assert.equal(summarizeTeamCityAgentStatus('172.31.99.99', inventory).status, 'unknown')
})

test('parses only supported service status markers', () => {
  const statuses = parseTeamCityServiceStatuses([
    'PULSEBOARD_SERVICE_STATUS|Dev-QC01|Search|Running',
    'PULSEBOARD_SERVICE_STATUS&#124;Dev-QC01&#124;Export&#124;Stopped',
    'PULSEBOARD_SERVICE_STATUS|Dev-QC01|Other|Invalid',
  ].join('\n'))

  assert.equal(statuses.get('dev-qc01:search'), 'running')
  assert.equal(statuses.get('dev-qc01:export'), 'stopped')
  assert.equal(statuses.has('dev-qc01:other'), false)
})

test('parses disk markers and classifies free-space thresholds', () => {
  const disks = parseTeamCityDiskStatuses([
    'PULSEBOARD_DISK_STATUS|Dev-QC01|C:|1000|500',
    'PULSEBOARD_DISK_STATUS&#124;Dev-QC01&#124;D:&#124;1000&#124;150',
    'PULSEBOARD_DISK_STATUS|Dev-QC01|E:|1000|50',
  ].join('\n')).get('dev-qc01')

  assert.deepEqual(disks, [
    { name: 'C:', totalBytes: 1000, freeBytes: 500, freePercent: 50, status: 'healthy' },
    { name: 'D:', totalBytes: 1000, freeBytes: 150, freePercent: 15, status: 'warning' },
    { name: 'E:', totalBytes: 1000, freeBytes: 50, freePercent: 5, status: 'critical' },
  ])
})

test('validates the configured inventory and rejects duplicate names', async () => {
  const inventory = await readInventory()
  assert.equal(inventory.length, 6)
  const byName = Object.fromEntries(inventory.map((server) => [server.name, server]))
  assert.equal(byName['Dev-QC01'].deploymentBuildTypeId, 'VenioUS_DeployInQC01_NewDeploy')
  assert.equal(byName['Dev-QC02'].deploymentBuildTypeId, 'VenioUS_DeployInCS3_Deploy')
  assert.equal(byName['Dev-QC03'].deploymentBuildTypeId, 'VenioUS_DeployInQc03_Deploy')
  assert.equal(byName['Dev-QC04'].deploymentBuildTypeId, undefined)
  assert.equal(byName['TeamCity Agent'].teamCityAgent, true)
  assert.throws(() => validateInventory([
    { name: 'duplicate', ip: '127.0.0.1', group: 'Infrastructure', environment: 'test', location: 'local' },
    { name: 'Duplicate', ip: '127.0.0.2', group: 'Infrastructure', environment: 'test', location: 'local' },
  ]), /Duplicate server name/)
  assert.throws(() => validateInventory([
    { name: 'machine', ip: '127.0.0.1', group: 'Test machines', environment: 'test', location: 'local', releaseBranch: '11.8.5' },
  ]), /releaseBranch must use the form/)
})

test('fails closed when production authentication is disabled', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousAuthMode = process.env.AUTH_MODE
  try {
    process.env.NODE_ENV = 'production'
    process.env.AUTH_MODE = 'none'
    assert.throws(() => validateRuntimeConfig(), /not allowed/)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = previousAuthMode
  }
})

test('serves health checks and protects API routes', async (context) => {
  const previous = {
    authMode: process.env.AUTH_MODE,
    username: process.env.DASHBOARD_USERNAME,
    password: process.env.DASHBOARD_PASSWORD,
    refresh: process.env.AUTO_REFRESH_SECONDS,
    statusTimeout: process.env.TEAMCITY_SERVICE_STATUS_TIMEOUT_MS,
  }
  process.env.AUTH_MODE = 'basic'
  process.env.DASHBOARD_USERNAME = 'operator'
  process.env.DASHBOARD_PASSWORD = 'a-long-test-password'
  process.env.AUTO_REFRESH_SECONDS = '45'
  process.env.TEAMCITY_SERVICE_STATUS_TIMEOUT_MS = '180000'
  validateRuntimeConfig()
  const listJobs = context.mock.method(scheduledJobManager, 'list', async () => [])
  const getJob = context.mock.method(scheduledJobManager, 'get', async () => ({ id: 'job-1', scriptContent: 'print(1)' }))
  const createJob = context.mock.method(scheduledJobManager, 'create', async (input) => ({ id: 'job-1', ...input, status: 'scheduled' }))
  const updateJob = context.mock.method(scheduledJobManager, 'update', async (id, input) => ({ id, ...input, status: 'scheduled' }))
  const runJob = context.mock.method(scheduledJobManager, 'runNow', async () => ({ id: 'job-1', status: 'running' }))
  const removeJob = context.mock.method(scheduledJobManager, 'remove', async () => ({ id: 'job-1' }))
  assert.equal(api.headersTimeout, 70000)
  assert.equal(api.keepAliveTimeout, 65000)

  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const address = api.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const authorization = `Basic ${Buffer.from('operator:a-long-test-password').toString('base64')}`

  context.after(async () => {
    await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()))
    for (const [name, value] of [
      ['AUTH_MODE', previous.authMode],
      ['DASHBOARD_USERNAME', previous.username],
      ['DASHBOARD_PASSWORD', previous.password],
      ['AUTO_REFRESH_SECONDS', previous.refresh],
      ['TEAMCITY_SERVICE_STATUS_TIMEOUT_MS', previous.statusTimeout],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const health = await fetch(`${baseUrl}/healthz`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff')

  const ready = await fetch(`${baseUrl}/readyz`)
  assert.equal(ready.status, 200)
  assert.deepEqual(await ready.json(), { status: 'ready' })

  const unauthorized = await fetch(`${baseUrl}/api/config`)
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('www-authenticate') || '', /^Basic /)
  assert.equal(unauthorized.headers.has('access-control-allow-origin'), false)

  assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs`)).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs`, { method: 'POST', headers: { Authorization: authorization } })).status, 403)
  const jobList = await fetch(`${baseUrl}/api/scheduled-jobs`, { headers: { Authorization: authorization } })
  assert.equal(jobList.status, 200)
  const jobListBody = await jobList.json()
  assert.deepEqual(jobListBody.jobs, [])
  assert.equal(typeof jobListBody.timeZone, 'string')
  assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs/job-1`, { headers: { Authorization: authorization } })).status, 200)
  const createdJob = await fetch(`${baseUrl}/api/scheduled-jobs`, {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
    body: JSON.stringify({ name: 'Test', language: 'python', sourceMode: 'inline', scriptContent: 'print(1)', schedule: { type: 'daily', time: '09:00' } }),
  })
  assert.equal(createdJob.status, 201)
  const updatedJob = await fetch(`${baseUrl}/api/scheduled-jobs/job-1`, {
    method: 'PUT', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
    body: JSON.stringify({ name: 'Edited', language: 'python', sourceMode: 'inline', scriptContent: 'print(2)', schedule: { type: 'weekdays', time: '17:30' } }),
  })
  assert.equal(updatedJob.status, 200)
  assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs/job-1/run`, { method: 'POST', headers: { Authorization: authorization, 'X-Pulseboard-Request': '1' } })).status, 202)
  assert.equal((await fetch(`${baseUrl}/api/scheduled-jobs/job-1`, { method: 'DELETE', headers: { Authorization: authorization, 'X-Pulseboard-Request': '1' } })).status, 200)
  assert.equal(listJobs.mock.callCount(), 1)
  assert.equal(getJob.mock.callCount(), 1)
  assert.equal(createJob.mock.callCount(), 1)
  assert.equal(updateJob.mock.callCount(), 1)
  assert.equal(runJob.mock.callCount(), 1)
  assert.equal(removeJob.mock.callCount(), 1)

  const configuration = await fetch(`${baseUrl}/api/config`, { headers: { Authorization: authorization } })
  assert.equal(configuration.status, 200)
  assert.deepEqual(await configuration.json(), { autoRefreshSeconds: 45, statusRequestTimeoutMs: 240000 })

  const invalidReleaseCheck = await fetch(`${baseUrl}/api/integrations?release=release%2F11.8.5`, { headers: { Authorization: authorization } })
  assert.equal(invalidReleaseCheck.status, 400)

  const invalidBuild = await fetch(`${baseUrl}/api/teamcity/builds/not-a-number`, { headers: { Authorization: authorization } })
  assert.equal(invalidBuild.status, 400)

  const unverifiedAction = await fetch(`${baseUrl}/api/servers/Dev-QC01/services/VenioSearchService/stop`, {
    method: 'POST',
    headers: { Authorization: authorization },
  })
  assert.equal(unverifiedAction.status, 403)

  const unverifiedIisRestart = await fetch(`${baseUrl}/api/servers/Dev-QC01/iis/restart`, {
    method: 'POST',
    headers: { Authorization: authorization },
  })
  assert.equal(unverifiedIisRestart.status, 403)

  const unverifiedDeployment = await fetch(`${baseUrl}/api/servers/Dev-QC01/deploy`, {
    method: 'POST',
    headers: { Authorization: authorization },
  })
  assert.equal(unverifiedDeployment.status, 403)

  const unverifiedComponentBuild = await fetch(`${baseUrl}/api/teamcity/components/api/trigger`, {
    method: 'POST',
    headers: { Authorization: authorization },
  })
  assert.equal(unverifiedComponentBuild.status, 403)

  const invalidCustomComponentBuild = await fetch(`${baseUrl}/api/teamcity/components/api/trigger`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
    body: JSON.stringify({ release: 'release/11.8.5' }),
  })
  assert.equal(invalidCustomComponentBuild.status, 400)

  const unknownComponentBuild = await fetch(`${baseUrl}/api/teamcity/components/database/trigger`, {
    method: 'POST',
    headers: { Authorization: authorization, 'X-Pulseboard-Request': '1' },
  })
  assert.equal(unknownComponentBuild.status, 404)

  const privateInventory = await fetch(`${baseUrl}/servers.json`)
  assert.equal(privateInventory.status, 404)
})
