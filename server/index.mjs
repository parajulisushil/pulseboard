import 'dotenv/config'
import { execFile } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { approveGitLabMergeRequest, getGitLabApprovalSummary, GitLabApprovalError, listGitLabApprovals, readApprovalRequest } from './gitlab-approvals.mjs'
import { adPasswords, AdPasswordError, readAdResetRequest } from './ad-passwords.mjs'
import { createDeploymentScheduler, DeploymentScheduleError, readScheduleRequest } from './deployment-schedules.mjs'
import { createScheduledJobManager, readScheduledJobRequest, ScheduledJobError } from './scheduled-jobs.mjs'
import { readRecentSqlError, sqlErrorChecksEnabled } from './sql-errors.mjs'
import { createInfrastructureMonitor, readInfrastructureInventory } from './infrastructure-status.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(root, '..')
const inventoryPath = process.env.INVENTORY_PATH
  ? path.resolve(projectRoot, process.env.INVENTORY_PATH)
  : path.join(projectRoot, 'config', 'servers.json')
const infrastructureInventoryPath = process.env.INFRASTRUCTURE_INVENTORY_PATH
  ? path.resolve(projectRoot, process.env.INFRASTRUCTURE_INVENTORY_PATH)
  : path.join(projectRoot, 'config', 'infrastructure-servers.json')
const distPath = path.join(root, '..', 'dist')
const port = Number.parseInt(process.env.API_PORT || '3001', 10)
const host = process.env.API_HOST || '0.0.0.0'
const powershellCommand = process.env.POWERSHELL_BIN || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')
const serviceActionLocks = new Map()
const deploymentActionLocks = new Map()
const componentBuildActionLocks = new Map()
const teamCityDependencyCache = new Map()
let shuttingDown = false

const infrastructureMonitor = createInfrastructureMonitor({ inventoryPath: infrastructureInventoryPath })

const deploymentScheduler = createDeploymentScheduler({
  filePath: () => path.resolve(projectRoot, process.env.DEPLOYMENT_SCHEDULE_PATH || 'data/deployment-schedules.json'),
  getServer: async (name) => (await readInventory()).find((server) => server.name === name),
  getBuild: getTeamCityBuildProgress,
  isDeploymentBusy: isTeamCityDeploymentBusy,
  queueDeployment: async (server, schedule) => {
    const result = await queueTeamCityDeployment(server, schedule.id)
    if (result.status === 'queued') deploymentActionLocks.set(serverStatusCacheKey(server.name), { buildId: result.buildId, startedAt: Date.now() })
    return result
  },
  teamCityUrl: () => integrationConfigured('TEAMCITY') ? process.env.TEAMCITY_URL.replace(/\/$/, '') : undefined,
  audit: (message, details) => log('info', message, details),
})

const scheduledJobManager = createScheduledJobManager({
  filePath: () => path.resolve(projectRoot, process.env.SCHEDULED_JOBS_PATH || 'data/scheduled-jobs.json'),
  timeZone: () => process.env.SCHEDULED_JOB_TIME_ZONE || process.env.TZ || 'Asia/Kathmandu',
  powershellCommand: () => process.env.POWERSHELL_BIN || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh'),
  pythonCommand: () => process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python.exe' : 'python3'),
  timeoutMs: () => Number.parseInt(process.env.SCHEDULED_JOB_TIMEOUT_MS || '900000', 10),
  audit: (message, details) => log(details?.status === 'failed' || message.endsWith('_failed') ? 'warn' : 'info', message, details),
})

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function log(level, message, details = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...details })
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  target(entry)
}

function configuredValue(name) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

function authenticationMode() {
  return (configuredValue('AUTH_MODE') || (process.env.NODE_ENV === 'production' ? 'basic' : 'none')).toLowerCase()
}

function autoRefreshSeconds() {
  return Number.parseInt(process.env.AUTO_REFRESH_SECONDS || '30', 10)
}

function teamCityServiceStatusTimeoutMs() {
  return Number.parseInt(process.env.TEAMCITY_SERVICE_STATUS_TIMEOUT_MS || '180000', 10)
}

function diskWarningPercentFree() {
  return Number.parseInt(process.env.DISK_WARNING_PERCENT_FREE || '20', 10)
}

function diskCriticalPercentFree() {
  return Number.parseInt(process.env.DISK_CRITICAL_PERCENT_FREE || '10', 10)
}

function validateRuntimeConfig() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be an integer between 1 and 65535')
  if (!Number.isInteger(autoRefreshSeconds()) || autoRefreshSeconds() < 10 || autoRefreshSeconds() > 3600) {
    throw new Error('AUTO_REFRESH_SECONDS must be an integer between 10 and 3600')
  }
  if (!Number.isInteger(teamCityServiceStatusTimeoutMs()) || teamCityServiceStatusTimeoutMs() < 10000 || teamCityServiceStatusTimeoutMs() > 900000) {
    throw new Error('TEAMCITY_SERVICE_STATUS_TIMEOUT_MS must be an integer between 10000 and 900000')
  }
  const scheduledJobTimeoutMs = Number.parseInt(process.env.SCHEDULED_JOB_TIMEOUT_MS || '900000', 10)
  if (!Number.isInteger(scheduledJobTimeoutMs) || scheduledJobTimeoutMs < 1000 || scheduledJobTimeoutMs > 86400000) {
    throw new Error('SCHEDULED_JOB_TIMEOUT_MS must be an integer between 1000 and 86400000')
  }
  if (!Number.isInteger(diskCriticalPercentFree()) || !Number.isInteger(diskWarningPercentFree())
    || diskCriticalPercentFree() < 1 || diskWarningPercentFree() > 99
    || diskCriticalPercentFree() >= diskWarningPercentFree()) {
    throw new Error('Disk thresholds must be integers with 1 <= DISK_CRITICAL_PERCENT_FREE < DISK_WARNING_PERCENT_FREE <= 99')
  }
  if (!['none', 'basic'].includes(authenticationMode())) throw new Error('AUTH_MODE must be either "basic" or "none"')
  if (authenticationMode() === 'basic' && (!configuredValue('DASHBOARD_USERNAME') || !configuredValue('DASHBOARD_PASSWORD'))) {
    throw new Error('DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required when AUTH_MODE=basic')
  }
  if (authenticationMode() === 'basic' && (configuredValue('DASHBOARD_PASSWORD').length < 16 || /^replace-with/i.test(configuredValue('DASHBOARD_PASSWORD')))) {
    throw new Error('DASHBOARD_PASSWORD must be at least 16 characters and must not be a placeholder')
  }
  if (process.env.NODE_ENV === 'production' && authenticationMode() === 'none') {
    throw new Error('AUTH_MODE=none is not allowed when NODE_ENV=production')
  }
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual))
  const expectedBuffer = Buffer.from(String(expected))
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function isAuthorized(request) {
  if (authenticationMode() === 'none') return true
  const authorization = request.headers.authorization || ''
  if (!authorization.startsWith('Basic ')) return false
  try {
    const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
    const separator = credentials.indexOf(':')
    if (separator < 0) return false
    return secureEqual(credentials.slice(0, separator), configuredValue('DASHBOARD_USERNAME'))
      && secureEqual(credentials.slice(separator + 1), configuredValue('DASHBOARD_PASSWORD'))
  } catch {
    return false
  }
}

function applySecurityHeaders(request, response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  if (request.socket.encrypted || (process.env.TRUST_PROXY === 'true' && request.headers['x-forwarded-proto'] === 'https')) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

const runPowerShell = (script, args = [], { logErrors = true } = {}) => new Promise((resolve) => {
  const environment = { ...process.env }
  args.forEach((value, index) => { environment[`PULSEBOARD_ARG_${index}`] = String(value) })
  execFile(powershellCommand, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15000, env: environment }, (error, stdout, stderr) => {
    const output = stdout.trim()
    const errorOutput = stderr.trim()
    const details = [error?.message, errorOutput].filter(Boolean).join('\n')
    if (details && logErrors) console.error(`[PowerShell] ${details}`)
    resolve({ ok: !error && !errorOutput, output })
  })
})

const serviceChecksEnabled = () => process.env.SERVICE_CHECKS_ENABLED === 'true'
const credentialsConfigured = () => serviceChecksEnabled() && Boolean(process.env.SERVICE_USERNAME && process.env.SERVICE_PASSWORD)
const integrationConfigured = (name) => Boolean(process.env[`${name}_URL`] && process.env[`${name}_TOKEN`])
const teamCityServiceConfigured = () => integrationConfigured('TEAMCITY') && Boolean(process.env.TEAMCITY_SERVICE_BUILD_TYPE_ID)
const teamCityStatusCache = { entries: new Map(), pending: new Map() }

function getCurrentRelease(override) {
  const defaultValue = configuredValue('CURRENT_RELEASE')
  const value = override || defaultValue
  return {
    provider: 'Environment',
    status: value ? 'configured' : 'unknown',
    value,
    defaultValue,
    isOverride: Boolean(override && override !== defaultValue),
    pipeline: configuredValue('CURRENT_RELEASE_PIPELINE'),
    environment: configuredValue('CURRENT_RELEASE_ENVIRONMENT') || 'QA',
    ...(value ? {} : { reason: 'CURRENT_RELEASE is not configured' }),
  }
}

async function getGitLabPipeline(ref) {
  if (!integrationConfigured('GITLAB') || !process.env.GITLAB_PROJECT_ID) return { provider: 'GitLab', status: 'unknown', reason: 'GitLab is not configured' }
  try {
    const url = new URL(`${process.env.GITLAB_URL.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(process.env.GITLAB_PROJECT_ID)}/pipelines`)
    url.searchParams.set('per_page', '1')
    if (ref) url.searchParams.set('ref', ref)
    const response = await fetch(url, { headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) return { provider: 'GitLab', status: 'unknown', reason: `GitLab returned ${response.status}` }
    const pipelines = await response.json()
    const pipeline = pipelines[0]
    if (!pipeline) return { provider: 'GitLab', status: 'unknown', reason: 'No pipelines found' }
    return { provider: 'GitLab', status: pipeline.status, id: pipeline.id, ref: pipeline.ref, webUrl: pipeline.web_url, updatedAt: pipeline.updated_at }
  } catch {
    return { provider: 'GitLab', status: 'unknown', reason: 'Unable to reach GitLab' }
  }
}

function currentTeamCityBranch() {
  return configuredValue('CURRENT_RELEASE')
}

function teamCityRequestHeaders() {
  return { Accept: 'application/json', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` }
}

async function getTeamCityJson(relativeUrl) {
  const response = await fetch(`${process.env.TEAMCITY_URL.replace(/\/$/, '')}${relativeUrl}`, {
    headers: teamCityRequestHeaders(),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`TeamCity returned ${response.status}`)
  return response.json()
}

function teamCityBuildTypeUrl(buildTypeId, branch) {
  const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
  return `${baseUrl}/buildConfiguration/${encodeURIComponent(buildTypeId)}?branch=${encodeURIComponent(branch)}`
}

function teamCitySourceName(buildType) {
  const pathParts = String(buildType.projectName || '').split(' / ').filter(Boolean)
  return pathParts.at(-1) || buildType.name || buildType.id
}

async function getTeamCityBuildTypeDetails(buildTypeId) {
  const locator = encodeURIComponent(`id:${buildTypeId}`)
  const fields = encodeURIComponent('id,name,projectName,projectId,webUrl,snapshot-dependencies(snapshot-dependency(source-buildType(id,name,projectName,projectId,webUrl)))')
  const data = await getTeamCityJson(`/app/rest/buildTypes/${locator}?fields=${fields}`)
  const dependencies = (data['snapshot-dependencies']?.['snapshot-dependency'] || [])
    .map((dependency) => dependency['source-buildType'])
    .filter((dependency) => dependency?.id)
  return {
    buildTypeId: data.id || buildTypeId,
    name: teamCitySourceName(data),
    projectName: data.projectName,
    webUrl: data.webUrl,
    dependencies,
  }
}

async function getTeamCityDependencyGraph(buildTypeId) {
  const cached = teamCityDependencyCache.get(buildTypeId)
  if (cached?.expiresAt > Date.now()) return cached.sources

  const sources = []
  const visited = new Set()
  let frontier = [buildTypeId]
  while (frontier.length) {
    const batch = [...new Set(frontier.filter((id) => !visited.has(id)))]
    frontier = []
    batch.forEach((id) => visited.add(id))
    const details = await Promise.all(batch.map((id) => getTeamCityBuildTypeDetails(id)))
    sources.push(...details.map(({ dependencies: _dependencies, ...source }) => source))
    for (const detail of details) {
      for (const dependency of detail.dependencies) {
        if (!visited.has(dependency.id)) frontier.push(dependency.id)
      }
    }
    if (visited.size > 50) throw new Error('Console dependency graph is unexpectedly large')
  }

  teamCityDependencyCache.set(buildTypeId, { expiresAt: Date.now() + 5 * 60 * 1000, sources })
  return sources
}

async function getTeamCityPendingChanges(source, branch) {
  const locator = encodeURIComponent(`buildType:(id:${source.buildTypeId}),pending:true,branch:(name:${branch}),count:1000`)
  const fields = encodeURIComponent('count,nextHref,change(id,version,date,username,webUrl)')
  const data = await getTeamCityJson(`/app/rest/changes?locator=${locator}&fields=${fields}`)
  return {
    ...source,
    changes: data.change || [],
    pendingChanges: Number(data.count || 0),
    truncated: Boolean(data.nextHref),
  }
}

function aggregatePendingChangeSources(sources) {
  const uniqueChanges = new Set()
  const pendingSources = []
  let truncated = false
  for (const source of sources) {
    const sourceChanges = new Set()
    for (const change of source.changes || []) {
      const key = change.id === undefined ? change.version : String(change.id)
      if (!key) continue
      sourceChanges.add(key)
      uniqueChanges.add(key)
    }
    const pendingChanges = Math.max(Number(source.pendingChanges || 0), sourceChanges.size)
    if (pendingChanges > 0) {
      pendingSources.push({
        buildTypeId: source.buildTypeId,
        name: source.name,
        pendingChanges,
        webUrl: source.webUrl,
      })
    }
    truncated ||= Boolean(source.truncated)
  }
  return { pendingChanges: uniqueChanges.size, pendingSources, truncated }
}

async function getTeamCityActiveBuilds(configuration, branch) {
  const fields = encodeURIComponent('build(id,number,state,status,webUrl,startDate,queuedDate,buildTypeId,branchName)')
  const results = await Promise.all(['running', 'queued'].map(async (state) => {
    const locator = encodeURIComponent(`buildType:(id:${configuration.buildTypeId}),branch:(name:${branch}),state:${state},personal:false,count:10`)
    const data = await getTeamCityJson(`/app/rest/builds?locator=${locator}&fields=${fields}`)
    return (data.build || []).map((build) => ({
      id: build.id,
      number: build.number,
      state: build.state || state,
      status: build.status,
      webUrl: build.webUrl,
      startDate: build.startDate,
      queuedDate: build.queuedDate,
      buildTypeId: build.buildTypeId || configuration.buildTypeId,
      branch: build.branchName || branch,
    }))
  }))
  return filterTeamCityBuildsForBranch(results.flat(), branch)
}

function filterTeamCityBuildsForBranch(builds, branch) {
  return builds.filter((build) => !build.branch || build.branch === branch)
}

async function getTeamCityComponentActivity(configuration, branch) {
  const fallbackUrl = teamCityBuildTypeUrl(configuration.buildTypeId, branch)
  try {
    const sources = configuration.includeDependencies
      ? await getTeamCityDependencyGraph(configuration.buildTypeId)
      : [{ buildTypeId: configuration.buildTypeId, name: configuration.label, webUrl: fallbackUrl }]
    const [sourceResults, builds] = await Promise.all([
      Promise.all(sources.map((source) => getTeamCityPendingChanges(source, branch))),
      getTeamCityActiveBuilds(configuration, branch),
    ])
    const pending = aggregatePendingChangeSources(sourceResults)
    const activeBuild = builds[0]
    return {
      key: configuration.key,
      label: configuration.label,
      buildTypeId: configuration.buildTypeId,
      webUrl: sources.find((source) => source.buildTypeId === configuration.buildTypeId)?.webUrl || fallbackUrl,
      checkedConfigurations: sources.length,
      ...pending,
      builds,
      activeBuild,
      status: activeBuild?.state || (pending.pendingChanges > 0 ? 'pending' : 'current'),
      canTrigger: pending.pendingChanges > 0 && !activeBuild,
    }
  } catch (error) {
    return {
      key: configuration.key,
      label: configuration.label,
      buildTypeId: configuration.buildTypeId,
      webUrl: fallbackUrl,
      checkedConfigurations: 0,
      pendingChanges: 0,
      pendingSources: [],
      builds: [],
      status: 'unknown',
      canTrigger: false,
      reason: error instanceof Error ? error.message : 'Unable to read TeamCity activity',
    }
  }
}

async function getTeamCityBuild(selectedBranch) {
  if (!integrationConfigured('TEAMCITY')) return { provider: 'TeamCity', status: 'unknown', reason: 'TeamCity is not configured' }
  const branch = selectedBranch || currentTeamCityBranch()
  if (!branch) return { provider: 'TeamCity', status: 'unknown', reason: 'CURRENT_RELEASE is not configured' }

  const components = await Promise.all(teamCityComponentBuildTypes().map((configuration) => getTeamCityComponentActivity(configuration, branch)))
  const builds = components.flatMap((component) => component.builds.map((build) => ({ ...build, component: component.label })))
  const pendingChanges = components.reduce((total, component) => total + component.pendingChanges, 0)
  const failedComponents = components.filter((component) => component.status === 'unknown')
  const status = builds.length ? 'running' : pendingChanges > 0 ? 'pending' : failedComponents.length === components.length ? 'unknown' : 'success'
  const reason = failedComponents.length
    ? `Activity unavailable for ${failedComponents.map((component) => component.label).join(', ')}`
    : pendingChanges > 0
      ? `${pendingChanges} pending ${pendingChanges === 1 ? 'change' : 'changes'}`
      : 'No pending changes'
  return { provider: 'TeamCity', status, reason, branch, pendingChanges, components, builds }
}

async function getTeamCityAgentInventory() {
  if (!integrationConfigured('TEAMCITY')) return { status: 'unknown', reason: 'TeamCity is not configured', agents: [] }
  try {
    const fields = encodeURIComponent('agent(id,name,connected,enabled,authorized,ip,host,webUrl,build(id,number,state,status,webUrl,buildTypeId))')
    const data = await getTeamCityJson(`/app/rest/agents?fields=${fields}`)
    return { status: 'available', agents: data.agent || [] }
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : 'Unable to read TeamCity agents', agents: [] }
  }
}

function summarizeTeamCityAgentStatus(ip, inventory) {
  if (inventory?.status !== 'available') {
    return { status: 'unknown', instances: 0, connectedInstances: 0, runningBuilds: [], reason: inventory?.reason || 'TeamCity agent status is unavailable' }
  }
  const target = String(ip || '').trim().toLowerCase()
  const agents = inventory.agents.filter((agent) => String(agent.ip || '').trim().toLowerCase() === target)
  const connectedInstances = agents.filter((agent) => agent.connected).length
  const runningBuilds = agents
    .filter((agent) => agent.build && (agent.build.state === 'running' || agent.build.status === 'RUNNING'))
    .map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      id: agent.build.id,
      number: agent.build.number,
      state: agent.build.state || 'running',
      status: agent.build.status,
      webUrl: agent.build.webUrl,
      buildTypeId: agent.build.buildTypeId,
    }))
  if (!agents.length) {
    return { status: 'unknown', instances: 0, connectedInstances: 0, runningBuilds, reason: `No TeamCity agent reports IP ${ip}` }
  }
  return {
    status: connectedInstances > 0 || runningBuilds.length > 0 ? 'online' : 'offline',
    instances: agents.length,
    connectedInstances,
    runningBuilds,
  }
}

function teamCityBuildPayload(buildTypeId, properties = [], comment = '', { branchName } = {}) {
  const payload = {
    buildType: { id: buildTypeId },
    comment: { text: comment },
  }
  if (properties.length) payload.properties = { property: properties }
  if (branchName) payload.branchName = branchName
  return payload
}

async function queueTeamCityBuild(buildTypeId, properties = [], comment = '', options = {}) {
  if (!integrationConfigured('TEAMCITY') || !buildTypeId) return { status: 'unknown', reason: 'TeamCity build is not configured' }
  try {
    const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
    const response = await fetch(`${baseUrl}/app/rest/buildQueue`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}`,
      },
      body: JSON.stringify(teamCityBuildPayload(buildTypeId, properties, comment, options)),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return { status: 'unknown', reason: `TeamCity returned ${response.status}` }
    const build = await response.json()
    return { status: 'queued', buildId: build.id, buildNumber: build.number, webUrl: build.webUrl }
  } catch {
    return { status: 'unknown', reason: 'Unable to queue TeamCity build' }
  }
}

async function queueTeamCityServiceAction(server, service, action) {
  const serviceName = service.serviceKey || service.name
  const build = await queueTeamCityBuild(process.env.TEAMCITY_SERVICE_BUILD_TYPE_ID, [
    { name: 'env.PULSEBOARD_TARGET_SERVER', value: server.remoteHost || server.name },
    { name: 'env.PULSEBOARD_SERVER_NAME', value: server.name },
    { name: 'env.PULSEBOARD_SERVICE_NAME', value: serviceName },
    { name: 'env.PULSEBOARD_SERVICE_ACTION', value: action },
  ], `Pulseboard: ${action} ${serviceName} on ${server.name}`)
  return { ...build, action }
}

async function queueTeamCityIisRestart(server) {
  const build = await queueTeamCityBuild(process.env.TEAMCITY_SERVICE_BUILD_TYPE_ID, [
    { name: 'env.PULSEBOARD_TARGET_SERVER', value: server.remoteHost || server.name },
    { name: 'env.PULSEBOARD_SERVER_NAME', value: server.name },
    { name: 'env.PULSEBOARD_SERVICE_NAME', value: 'IIS' },
    { name: 'env.PULSEBOARD_SERVICE_ACTION', value: 'restart_iis' },
  ], `Pulseboard: restart IIS on ${server.name}`)
  return { ...build, action: 'restart_iis' }
}

async function queueTeamCityDeployment(server, scheduleId) {
  const build = await queueTeamCityBuild(
    server.deploymentBuildTypeId,
    [],
    `Pulseboard: deploy latest component builds to ${server.name}${scheduleId ? ` (schedule ${scheduleId})` : ''}`,
  )
  return { ...build, action: 'deploy', server: server.name }
}

async function isTeamCityDeploymentBusy(server) {
  const tracked = deploymentActionLocks.get(serverStatusCacheKey(server.name))
  if (tracked) {
    const progress = tracked.buildId ? await getTeamCityBuildProgress(tracked.buildId) : { status: 'queued' }
    if (['queued', 'running', 'unknown'].includes(progress.status)) return true
  }
  const results = await Promise.all(['queued', 'running'].map(async (state) => {
    const locator = encodeURIComponent(`buildType:(id:${server.deploymentBuildTypeId}),state:${state},defaultFilter:false,count:1`)
    const data = await getTeamCityJson(`/app/rest/builds?locator=${locator}&fields=build(id)`)
    return Boolean(data.build?.length)
  }))
  return results.some(Boolean)
}

function serviceStatusKey(serverName, serviceName) {
  return `${String(serverName).trim().toLowerCase()}:${String(serviceName).trim().toLowerCase()}`
}

function serverStatusCacheKey(serverName) {
  return serverName ? String(serverName).trim().toLowerCase() : '*'
}

function serviceStatusTargets(inventory) {
  return inventory.flatMap((server) => (server.services || []).map((service) => ({
    serverName: server.name,
    target: server.remoteHost || server.name,
    serviceName: service.name,
    serviceKey: service.serviceKey || service.name,
  })))
}

async function waitForTeamCityBuild(queueId) {
  const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
  const headers = { Accept: 'application/json', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` }
  const timeoutMs = teamCityServiceStatusTimeoutMs()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const fields = encodeURIComponent('id,state,status,statusText,webUrl,number')
      const directResponse = await fetch(`${baseUrl}/app/rest/builds/id:${encodeURIComponent(queueId)}?fields=${fields}`, { headers, signal: AbortSignal.timeout(5000) })
      if (directResponse.ok) {
        const currentBuild = await directResponse.json()
        if (String(currentBuild.state).toLowerCase() === 'finished') return currentBuild
      }
      const locator = encodeURIComponent(`id:${queueId}`)
      const queueFields = encodeURIComponent('build(id,state),state')
      const queueResponse = await fetch(`${baseUrl}/app/rest/buildQueue?locator=${locator}&fields=${queueFields}`, { headers, signal: AbortSignal.timeout(5000) })
      if (queueResponse.ok) {
        const data = await queueResponse.json()
        const queueItem = data.build?.[0] || data.build || data
        const build = queueItem?.build || queueItem
        const buildId = build?.id
        if (buildId && String(build?.state).toLowerCase() !== 'queued') {
          const fields = encodeURIComponent('id,state,status,statusText,webUrl,number')
          const buildResponse = await fetch(`${baseUrl}/app/rest/builds/id:${encodeURIComponent(buildId)}?fields=${fields}`, { headers, signal: AbortSignal.timeout(5000) })
          if (buildResponse.ok) {
            const currentBuild = await buildResponse.json()
            if (String(currentBuild.state).toLowerCase() === 'finished') return currentBuild
          }
        }
      }
    } catch {
      // Keep polling until the bounded wait expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return undefined
}

async function getTeamCityBuildLog(buildId) {
  try {
    const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
    const headers = { Accept: 'text/plain', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` }
    const response = await fetch(`${baseUrl}/app/rest/builds/id:${encodeURIComponent(buildId)}/log`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (response.ok) return response.text()

    // This TeamCity installation exposes the plain build log through the
    // download endpoint; its REST /log resource returns 404.
    const downloadResponse = await fetch(`${baseUrl}/downloadBuildLog.html?buildId=${encodeURIComponent(buildId)}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    return downloadResponse.ok ? downloadResponse.text() : ''
  } catch {
    return ''
  }
}

function teamCityBuildStatus(state, status) {
  const normalizedState = String(state || '').toLowerCase()
  const normalizedStatus = String(status || '').toUpperCase()
  if (normalizedState === 'queued') return 'queued'
  if (normalizedState === 'running') return 'running'
  if (normalizedState === 'finished' && normalizedStatus === 'SUCCESS') return 'success'
  if (normalizedState === 'finished' && normalizedStatus === 'FAILURE') return 'failure'
  return 'unknown'
}

async function getTeamCityBuildProgress(buildId) {
  if (!integrationConfigured('TEAMCITY')) return { status: 'unknown', reason: 'TeamCity is not configured' }
  try {
    const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
    const headers = { Accept: 'application/json', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` }
    const fields = encodeURIComponent('id,state,status,statusText,webUrl,number,canceledInfo(text),failedToStart,branchName,buildType(name)')
    const buildResponse = await fetch(`${baseUrl}/app/rest/builds/id:${encodeURIComponent(buildId)}?fields=${fields}`, { headers, signal: AbortSignal.timeout(5000) })
    if (buildResponse.ok) {
      const build = await buildResponse.json()
      return { status: build.canceledInfo ? 'cancelled' : build.failedToStart ? 'failure' : teamCityBuildStatus(build.state, build.status), buildId: build.id, buildNumber: build.number, webUrl: build.webUrl, reason: build.canceledInfo ? 'Build was cancelled.' : build.statusText, buildName: build.buildType?.name, branch: build.branchName }
    }

    const locator = encodeURIComponent(`id:${buildId}`)
    const queueFields = encodeURIComponent('build(id,state,status,number,webUrl,waitReason,buildType(name),branchName),state')
    const queueResponse = await fetch(`${baseUrl}/app/rest/buildQueue?locator=${locator}&fields=${queueFields}`, { headers, signal: AbortSignal.timeout(5000) })
    if (!queueResponse.ok) return { status: 'unknown', reason: `TeamCity build ${buildId} was not found` }
    const data = await queueResponse.json()
    const queueItem = data.build?.[0] || data.build || data
    const queuedBuild = queueItem?.build || queueItem
    const state = queuedBuild?.state || queueItem?.state
    return { status: teamCityBuildStatus(state, queuedBuild?.status), buildId: queuedBuild?.id || buildId, buildNumber: queuedBuild?.number, webUrl: queuedBuild?.webUrl, reason: queuedBuild?.waitReason, buildName: queuedBuild?.buildType?.name, branch: queuedBuild?.branchName }
  } catch {
    return { status: 'unknown', reason: 'Unable to read TeamCity build status' }
  }
}

function decodeTeamCityLog(log) {
  return String(log || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#124;/gi, '|')
    .replace(/&#x([0-9a-f]+);/gi, (entity, value) => {
      const codePoint = Number.parseInt(value, 16)
      return codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/&#(\d+);/g, (entity, value) => {
      const codePoint = Number.parseInt(value, 10)
      return codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity
    })
}

function parseTeamCityServiceStatuses(log) {
  const statuses = new Map()
  const normalizedLog = decodeTeamCityLog(log)
  const marker = /PULSEBOARD_SERVICE_STATUS\s*\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*(Running|Stopped|Unknown)\b/gi
  for (const match of normalizedLog.matchAll(marker)) {
    const status = match[3].toLowerCase()
    statuses.set(serviceStatusKey(match[1], match[2]), status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown')
  }
  return statuses
}

function diskHealthStatus(freePercent) {
  if (freePercent <= diskCriticalPercentFree()) return 'critical'
  if (freePercent <= diskWarningPercentFree()) return 'warning'
  return 'healthy'
}

function parseTeamCityDiskStatuses(log) {
  const volumesByServer = new Map()
  const normalizedLog = decodeTeamCityLog(log)
  const marker = /PULSEBOARD_DISK_STATUS\s*\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*(\d+)\s*\|\s*(\d+)/gi
  for (const match of normalizedLog.matchAll(marker)) {
    const totalBytes = Number.parseInt(match[3], 10)
    const freeBytes = Number.parseInt(match[4], 10)
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(freeBytes) || totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes) continue
    const freePercent = Number(((freeBytes / totalBytes) * 100).toFixed(1))
    const serverKey = serverStatusCacheKey(match[1])
    const volumes = volumesByServer.get(serverKey) || []
    const volume = {
      name: match[2].trim(),
      totalBytes,
      freeBytes,
      freePercent,
      status: diskHealthStatus(freePercent),
    }
    const existingIndex = volumes.findIndex((item) => item.name.toLowerCase() === volume.name.toLowerCase())
    if (existingIndex >= 0) volumes[existingIndex] = volume
    else volumes.push(volume)
    volumesByServer.set(serverKey, volumes)
  }
  return volumesByServer
}

function emptyTeamCityMachineStatus() {
  return { services: new Map(), disks: new Map() }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function getTeamCityMachineStatus(inventory, { force = false, serverName } = {}) {
  if (!teamCityServiceConfigured()) return undefined
  const cacheKey = serverStatusCacheKey(serverName)
  if (force) teamCityStatusCache.entries.delete(cacheKey)
  const cached = teamCityStatusCache.entries.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.data
  const pending = teamCityStatusCache.pending.get(cacheKey)
  if (pending) return pending

  const statusRequest = (async () => {
    const targetInventory = serverName
      ? inventory.filter((server) => server.name.trim().toLowerCase() === serverName.trim().toLowerCase())
      : inventory
    const targets = serviceStatusTargets(targetInventory)
    const build = await queueTeamCityBuild(process.env.TEAMCITY_SERVICE_BUILD_TYPE_ID, [
      { name: 'env.PULSEBOARD_SERVICE_ACTION', value: 'status' },
      { name: 'env.PULSEBOARD_SERVICE_INVENTORY', value: JSON.stringify(targets) },
    ], serverName ? `Pulseboard: query ${serverName} service status` : 'Pulseboard: query Dev server service status')
    if (build.status !== 'queued' || !build.buildId) return emptyTeamCityMachineStatus()
    const finishedBuild = await waitForTeamCityBuild(build.buildId)
    if (!finishedBuild) {
      console.error('[TeamCity] Service status build timed out', {
        buildId: build.buildId,
        timeoutMs: teamCityServiceStatusTimeoutMs(),
      })
      return emptyTeamCityMachineStatus()
    }
    if (String(finishedBuild.status).toUpperCase() !== 'SUCCESS') {
      console.error('[TeamCity] Service status build did not finish successfully', { buildId: build.buildId, state: finishedBuild.state, status: finishedBuild.status })
      return emptyTeamCityMachineStatus()
    }
    let buildLog = await getTeamCityBuildLog(finishedBuild.id)
    let statuses = parseTeamCityServiceStatuses(buildLog)
    let disks = parseTeamCityDiskStatuses(buildLog)
    // TeamCity can report a build as finished a moment before its console log is
    // available through REST. Give the log endpoint a short bounded retry.
    for (let attempt = 0; attempt < 2 && statuses.size === 0; attempt += 1) {
      await delay(250)
      buildLog = await getTeamCityBuildLog(finishedBuild.id)
      statuses = parseTeamCityServiceStatuses(buildLog)
      disks = parseTeamCityDiskStatuses(buildLog)
    }
    if (statuses.size === 0) {
      console.error('[TeamCity] Service status build contained no Pulseboard status markers', { buildId: finishedBuild.id })
      return emptyTeamCityMachineStatus()
    }
    const targetKeys = new Set(targets.map((target) => serviceStatusKey(target.serverName, target.serviceName)))
    const parsedKeys = new Set(statuses.keys())
    const rejectedKeys = [...parsedKeys].filter((key) => !targetKeys.has(key))
    statuses = new Map([...statuses].filter(([key]) => targetKeys.has(key)))
    const targetServerKeys = new Set(targetInventory.map((server) => serverStatusCacheKey(server.name)))
    disks = new Map([...disks].filter(([key]) => targetServerKeys.has(key)))
    const missingKeys = [...targetKeys].filter((key) => !statuses.has(key))
    if (rejectedKeys.length || missingKeys.length) {
      log('warn', 'teamcity_service_markers_incomplete', {
        buildId: finishedBuild.id,
        expectedCount: targetKeys.size,
        matchedCount: statuses.size,
        rejectedKeys,
        missingKeys,
      })
    }
    const data = { services: statuses, disks }
    teamCityStatusCache.entries.set(cacheKey, { expiresAt: Date.now() + 30000, data })
    return data
  })().catch((error) => {
    console.error('[TeamCity] Service status query failed', error.message)
    return emptyTeamCityMachineStatus()
  })
  teamCityStatusCache.pending.set(cacheKey, statusRequest)

  try {
    return await statusRequest
  } finally {
    if (teamCityStatusCache.pending.get(cacheKey) === statusRequest) teamCityStatusCache.pending.delete(cacheKey)
  }
}

function normalizeTeamCityDate(value) {
  if (!value) return undefined
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{4}|Z)?$/)
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}${compact[7] && compact[7] !== 'Z' ? `${compact[7].slice(0, 3)}:${compact[7].slice(3)}` : 'Z'}`
    : value
  const timestamp = Date.parse(normalized)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

function teamCityComponentBuildTypes() {
  return [
    {
      key: 'console',
      name: 'Console',
      label: 'Console',
      buildTypeId: configuredValue('TEAMCITY_CONSOLE_BUILD_TYPE_ID') || 'MainRepository_Venio_VenioFRPWixSetup_Default',
      includeDependencies: true,
    },
    {
      key: 'api',
      name: 'OnDemand',
      label: 'API',
      buildTypeId: configuredValue('TEAMCITY_ONDEMAND_BUILD_TYPE_ID') || 'MainRepository_VenioWeb_VenioOnDemandAPI_Setup',
    },
    {
      key: 'web',
      name: 'Web',
      label: 'Web',
      buildTypeId: configuredValue('TEAMCITY_WEB_BUILD_TYPE_ID') || 'MainRepository_VenioWeb_VenioWebWixSetup_Default',
    },
  ]
}

async function getLatestTeamCityComponentBuilds(branch) {
  const configurations = teamCityComponentBuildTypes()
  if (!branch) {
    return { builds: {}, missingComponents: configurations.map((configuration) => configuration.name), reason: 'Machine release version is unavailable' }
  }
  if (!integrationConfigured('TEAMCITY')) {
    return { branch, builds: {}, missingComponents: configurations.map((configuration) => configuration.name), reason: 'TeamCity is not configured' }
  }

  const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
  const headers = { Accept: 'application/json', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` }
  const results = await Promise.all(configurations.map(async (configuration) => {
    try {
      const locator = encodeURIComponent(`buildType:(id:${configuration.buildTypeId}),branch:${branch},state:finished,status:SUCCESS,personal:false,history:false,defaultFilter:false,count:1`)
      const fields = encodeURIComponent('build(id,number,status,finishDate,webUrl,buildTypeId,branchName)')
      const response = await fetch(`${baseUrl}/app/rest/builds?locator=${locator}&fields=${fields}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return { ...configuration, reason: `TeamCity returned ${response.status}` }
      const data = await response.json()
      const build = data.build?.[0]
      if (!build?.number) return { ...configuration, reason: 'No successful builds found' }
      return {
        ...configuration,
        build: {
          id: build.id,
          number: String(build.number),
          finishedAt: normalizeTeamCityDate(build.finishDate),
          webUrl: build.webUrl,
          buildTypeId: build.buildTypeId || configuration.buildTypeId,
          branch: build.branchName || branch,
        },
      }
    } catch {
      return { ...configuration, reason: 'Unable to reach TeamCity' }
    }
  }))

  const builds = Object.fromEntries(results.filter((result) => result.build).map((result) => [result.name, result.build]))
  const missingComponents = results.filter((result) => !result.build).map((result) => result.name)
  return {
    branch,
    builds,
    missingComponents,
    ...(missingComponents.length ? { reason: `Latest TeamCity build unavailable for ${missingComponents.join(', ')}` } : {}),
  }
}

async function getLatestDeploymentRun(server) {
  const buildTypeId = server.deploymentBuildTypeId
  if (!buildTypeId || !integrationConfigured('TEAMCITY')) return undefined
  try {
    const baseUrl = process.env.TEAMCITY_URL.replace(/\/$/, '')
    const locator = encodeURIComponent(`buildType:(id:${buildTypeId}),state:finished,status:SUCCESS,personal:false,history:false,defaultFilter:false,count:1`)
    const fields = encodeURIComponent('build(id,number,status,finishDate,webUrl,buildTypeId)')
    const response = await fetch(`${baseUrl}/app/rest/builds?locator=${locator}&fields=${fields}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${process.env.TEAMCITY_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const data = await response.json()
    const build = data.build?.[0]
    if (!build) return undefined
    return { id: build.id, number: build.number, finishedAt: normalizeTeamCityDate(build.finishDate), webUrl: build.webUrl }
  } catch {
    return undefined
  }
}

function compareDeploymentBuilds(deployedBuilds, latestBuilds, expectedComponents = ['Console', 'OnDemand', 'Web']) {
  const comparisons = expectedComponents.map((name) => {
    const deployed = deployedBuilds?.[name]
    const available = latestBuilds?.[name]?.number
    return {
      name,
      deployed,
      available,
      status: !deployed || !available ? 'unknown' : String(deployed).trim() === String(available).trim() ? 'current' : 'available',
      ...(latestBuilds?.[name]?.webUrl ? { webUrl: latestBuilds[name].webUrl } : {}),
    }
  })
  const changedComponents = comparisons.filter((comparison) => comparison.status === 'available').map((comparison) => comparison.name)
  const status = changedComponents.length
    ? 'available'
    : comparisons.length && comparisons.every((comparison) => comparison.status === 'current')
      ? 'current'
      : 'unknown'
  return { status, changedComponents, comparisons }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
}

function validateInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error('Inventory must be a non-empty array')
  const serverNames = new Set()
  inventory.forEach((server, serverIndex) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error(`Server ${serverIndex} must be an object`)
    requireString(server.name, `Server ${serverIndex} name`)
    requireString(server.ip, `${server.name} ip`)
    requireString(server.group, `${server.name} group`)
    requireString(server.environment, `${server.name} environment`)
    requireString(server.location, `${server.name} location`)
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(server.name)) throw new Error(`${server.name} contains unsupported characters`)
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/.test(server.ip)) throw new Error(`${server.name} ip contains unsupported characters`)
    if (!['Test machines', 'Infrastructure'].includes(server.group)) throw new Error(`${server.name} has an unsupported group`)
    const normalizedName = server.name.trim().toLowerCase()
    if (serverNames.has(normalizedName)) throw new Error(`Duplicate server name: ${server.name}`)
    serverNames.add(normalizedName)
    if (server.checkPort !== undefined && (!Number.isInteger(server.checkPort) || server.checkPort < 1 || server.checkPort > 65535)) {
      throw new Error(`${server.name} checkPort must be an integer between 1 and 65535`)
    }
    if (server.teamCityAgent !== undefined && typeof server.teamCityAgent !== 'boolean') throw new Error(`${server.name} teamCityAgent must be a boolean`)
    for (const field of ['remoteHost', 'deploymentBuildTypeId', 'releaseBranch']) {
      if (server[field] !== undefined) requireString(server[field], `${server.name} ${field}`)
    }
    if (server.remoteHost && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(server.remoteHost)) throw new Error(`${server.name} remoteHost contains unsupported characters`)
    if (server.deploymentBuildTypeId && !/^[A-Za-z0-9_.-]{1,256}$/.test(server.deploymentBuildTypeId)) throw new Error(`${server.name} deploymentBuildTypeId contains unsupported characters`)
    if (server.releaseBranch && !/^v\d+\.\d+\.\d+\.\d+$/.test(server.releaseBranch)) throw new Error(`${server.name} releaseBranch must use the form v11.8.5.0`)
    if (server.loginUrl !== undefined) {
      requireString(server.loginUrl, `${server.name} loginUrl`)
      const loginUrl = new URL(server.loginUrl)
      if (!['http:', 'https:'].includes(loginUrl.protocol) || loginUrl.username || loginUrl.password) throw new Error(`${server.name} loginUrl must be an HTTP(S) URL without credentials`)
    }
    if (server.services !== undefined) {
      if (!Array.isArray(server.services)) throw new Error(`${server.name} services must be an array`)
      const serviceNames = new Set()
      server.services.forEach((service, serviceIndex) => {
        if (!service || typeof service !== 'object' || Array.isArray(service)) throw new Error(`${server.name} service ${serviceIndex} must be an object`)
        requireString(service.name, `${server.name} service ${serviceIndex} name`)
        if (service.serviceKey !== undefined) requireString(service.serviceKey, `${server.name} ${service.name} serviceKey`)
        if (/[|\r\n]/.test(service.name) || service.name.length > 256) throw new Error(`${server.name} service ${service.name} contains unsupported characters`)
        if (service.serviceKey && (/[|\r\n]/.test(service.serviceKey) || service.serviceKey.length > 256)) throw new Error(`${server.name} ${service.name} serviceKey contains unsupported characters`)
        const normalizedServiceName = service.name.trim().toLowerCase()
        if (serviceNames.has(normalizedServiceName)) throw new Error(`Duplicate service name on ${server.name}: ${service.name}`)
        serviceNames.add(normalizedServiceName)
      })
    }
  })
  return inventory
}

async function readInventory() {
  return validateInventory(JSON.parse(await readFile(inventoryPath, 'utf8')))
}

function buildDeployedBuildsUrl(server) {
  const host = server.name.trim().replace(/\s+/g, '-').toLowerCase()
  return `https://${host}.veniosystems.com/venioweb/build.html`
}

function buildBootstrapSettingsUrl(server) {
  const host = server.name.trim().replace(/\s+/g, '-').toLowerCase()
  return `https://${host}.veniosystems.com/VenioWeb/OnDemand/BootstrapService.asmx/GetBaseSettings`
}

function extractVenioVersion(responseBody) {
  const settings = typeof responseBody?.d === 'string' ? JSON.parse(responseBody.d) : responseBody?.d || responseBody
  const candidate = settings?.venioVersion ?? settings?.Version ?? settings?.version
  const value = candidate && typeof candidate === 'object' ? candidate.Version ?? candidate.version : candidate
  if (!['string', 'number'].includes(typeof value)) return undefined
  return String(value).trim() || undefined
}

function normalizeTeamCityBranch(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/i)
  if (!match) return undefined
  return `v${match[1]}.${match[2]}.${match[3]}.${match[4] || '0'}`
}

function normalizeReleaseCheck(value) {
  if (typeof value !== 'string' || value.length > 50) return undefined
  return normalizeTeamCityBranch(value)
}

async function readComponentBuildRelease(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  if (!size) return undefined
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new Error('Content-Type must be application/json')
  let input
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Request body must contain valid JSON') }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Request body must be a JSON object')
  const release = normalizeReleaseCheck(input.release)
  if (!release) throw new Error('Version must use the form 11.8.5.0 or v11.8.5.0')
  return release
}

async function getDeployedVersion(server) {
  if (!server.services) return undefined
  try {
    const response = await fetch(buildBootstrapSettingsUrl(server), {
      headers: { Accept: 'application/json', __RequestVerificationToken: 'kdfdk-eirouye' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    return extractVenioVersion(await response.json())
  } catch {
    return undefined
  }
}

function canonicalBuildComponent(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === 'console') return 'Console'
  if (normalized === 'ondemand') return 'OnDemand'
  if (normalized === 'web') return 'Web'
  if (normalized === 'venionext') return 'Venio-Next'
  return undefined
}

function parseDeployedBuildsPage(html) {
  const builds = {}
  for (const match of String(html || '').matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)) {
    const text = decodeTeamCityLog(match[1].replace(/<[^>]*>/g, ' ')).replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    const separator = text.indexOf(':')
    if (separator < 1) continue
    const component = canonicalBuildComponent(text.slice(0, separator))
    const buildNumber = text.slice(separator + 1).trim()
    if (component && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(buildNumber)) builds[component] = buildNumber
  }
  return Object.keys(builds).length ? builds : undefined
}

async function getDeployedBuilds(server) {
  if (!server.services) return undefined
  try {
    const response = await fetch(buildDeployedBuildsUrl(server), {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    return parseDeployedBuildsPage(await response.text())
  } catch {
    return undefined
  }
}

async function isReachable(ip, port = 443) {
  const result = await runPowerShell(`Test-NetConnection -ComputerName $env:PULSEBOARD_ARG_0 -Port $env:PULSEBOARD_ARG_1 -InformationLevel Quiet -WarningAction SilentlyContinue`, [ip, port], { logErrors: false })
  return result.ok && result.output.toLowerCase() === 'true'
}

async function remoteService(ip, serviceKey, action = 'status') {
  if (!credentialsConfigured()) return { status: 'unknown', reason: 'Service account is not configured' }
  if (!['status', 'start', 'stop'].includes(action)) return { status: 'unknown', reason: 'Unsupported service action' }
  const script = `$secure = ConvertTo-SecureString $env:SERVICE_PASSWORD -AsPlainText -Force; $credential = [PSCredential]::new($env:SERVICE_USERNAME, $secure); Invoke-Command -ComputerName $env:PULSEBOARD_ARG_0 -Credential $credential -ErrorAction Stop -ScriptBlock { param($name, $action) $service = Get-Service -Name $name -ErrorAction Stop; switch ($action) { 'start' { Start-Service -Name $name -ErrorAction Stop }; 'stop' { Stop-Service -Name $name -ErrorAction Stop }; 'status' {} }; (Get-Service -Name $name -ErrorAction Stop).Status.ToString() } -ArgumentList $env:PULSEBOARD_ARG_1, $env:PULSEBOARD_ARG_2`
  const result = await runPowerShell(script, [ip, serviceKey, action])
  if (!result.ok) return { status: 'unknown', reason: 'Remote service check failed' }
  return { status: result.output.toLowerCase() === 'running' ? 'running' : 'stopped' }
}

async function remoteIisRestart(ip) {
  if (!credentialsConfigured()) return { status: 'unknown', reason: 'Service account is not configured' }
  const script = `$secure = ConvertTo-SecureString $env:SERVICE_PASSWORD -AsPlainText -Force; $credential = [PSCredential]::new($env:SERVICE_USERNAME, $secure); Invoke-Command -ComputerName $env:PULSEBOARD_ARG_0 -Credential $credential -ErrorAction Stop -ScriptBlock { & "$env:SystemRoot\\System32\\iisreset.exe" /restart /timeout:60 | Out-String | Write-Host; if ($LASTEXITCODE -ne 0) { throw "IIS restart failed with exit code $LASTEXITCODE" } }`
  const result = await runPowerShell(script, [ip])
  return result.ok ? { status: 'restarted' } : { status: 'unknown', reason: 'Remote IIS restart failed' }
}

function latestComponentsForBranch(cache, branch) {
  if (!cache || !branch) return getLatestTeamCityComponentBuilds(branch)
  if (!cache.has(branch)) cache.set(branch, getLatestTeamCityComponentBuilds(branch))
  return cache.get(branch)
}

function deploymentStatusForServer(server, deployedBuilds, releaseVersion, releaseBranch, latestComponents, latestRun) {
  if (!server.deploymentBuildTypeId) return undefined
  const comparison = compareDeploymentBuilds(deployedBuilds, latestComponents?.builds)
  const baseUrl = configuredValue('TEAMCITY_URL')?.replace(/\/$/, '')
  const reason = !deployedBuilds
    ? 'Deployed build numbers are unavailable'
    : !releaseBranch
      ? 'Machine release version is unavailable'
      : latestComponents?.reason
  return {
    ...latestRun,
    buildTypeId: server.deploymentBuildTypeId,
    ...(baseUrl ? { buildTypeUrl: `${baseUrl}/buildConfiguration/${encodeURIComponent(server.deploymentBuildTypeId)}?branch=&buildTypeTab=overview` } : {}),
    ...(releaseVersion ? { releaseVersion } : {}),
    ...(releaseBranch ? { branch: releaseBranch } : {}),
    availableBuilds: latestComponents?.builds || {},
    ...comparison,
    canDeploy: comparison.status === 'available' && integrationConfigured('TEAMCITY'),
    canSchedule: integrationConfigured('TEAMCITY'),
    ...(reason ? { reason } : {}),
  }
}

async function getServerStatus(server, teamCityStatusSource, latestComponentsByBranch, teamCityAgentSource) {
  const [reachable, deployedBuilds, deployedVersion, latestRun, teamCityStatus, teamCityAgentInventory, recentDatabaseError] = await Promise.all([
    server.teamCityAgent ? false : isReachable(server.ip, server.checkPort || 443),
    getDeployedBuilds(server),
    server.services ? getDeployedVersion(server) : undefined,
    getLatestDeploymentRun(server),
    teamCityStatusSource,
    server.teamCityAgent ? teamCityAgentSource : undefined,
    server.group === 'Test machines' && sqlErrorChecksEnabled() ? readRecentSqlError(server) : undefined,
  ])
  const releaseBranch = server.releaseBranch || normalizeTeamCityBranch(deployedVersion)
  const releaseVersion = deployedVersion || releaseBranch?.replace(/^v/i, '')
  const latestComponents = server.deploymentBuildTypeId
    ? await latestComponentsForBranch(latestComponentsByBranch, releaseBranch)
    : undefined
  const deployment = deploymentStatusForServer(server, deployedBuilds, releaseVersion, releaseBranch, latestComponents, latestRun)
  const serverWithData = {
    ...server,
    ...(releaseVersion ? { releaseVersion } : {}),
    ...(deployedBuilds ? { deployedBuilds } : {}),
    ...(deployment ? { deployment } : {}),
    ...(recentDatabaseError ? { recentDatabaseError } : {}),
  }
  if (!server.services) {
    if (server.teamCityAgent) {
      const agentStatus = summarizeTeamCityAgentStatus(server.ip, teamCityAgentInventory)
      return { ...serverWithData, status: agentStatus.status, agentStatus }
    }
    return {
      ...serverWithData,
      status: reachable ? 'online' : 'offline',
    }
  }
  const diskVolumes = teamCityStatus?.disks.get(serverStatusCacheKey(server.name)) || []
  const diskSpace = diskVolumes.length
    ? { status: 'available', volumes: diskVolumes }
    : { status: 'unknown', volumes: [], reason: 'Disk status was not reported by TeamCity' }
  if (teamCityStatus) {
    const services = server.services.map((service) => ({ ...service, status: teamCityStatus.services.get(serviceStatusKey(server.name, service.name)) || 'unknown' }))
    const hasKnownService = services.some((service) => service.status !== 'unknown')
    return { ...serverWithData, status: reachable || hasKnownService ? 'online' : 'offline', services, diskSpace }
  }
  if (!reachable) {
    return {
      ...serverWithData,
      status: 'offline',
      services: server.services.map((service) => ({ ...service, status: 'unknown' })),
      diskSpace,
    }
  }
  const services = await Promise.all(server.services.map(async (service) => ({
      ...service,
      status: (await remoteService(server.ip, service.serviceKey || service.name)).status,
  })))
  return { ...serverWithData, status: 'online', services, diskSpace }
}

function send(response, status, body, headers = {}) {
  const payload = status === 204 ? '' : JSON.stringify(body)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(payload)
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function serveFrontend(request, response, requestUrl) {
  const decodedPath = decodePathPart(requestUrl.pathname)
  if (decodedPath === undefined || decodedPath.includes('\0')) return send(response, 400, { error: 'Invalid path' })
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '')
  const filePath = path.resolve(distPath, relativePath)
  if (!isPathInside(distPath, filePath)) return send(response, 403, { error: 'Forbidden' })
  let content
  let servedPath = filePath
  try {
    content = await readFile(filePath)
  } catch {
    if (path.extname(relativePath)) return send(response, 404, { error: 'Not found' })
    servedPath = path.join(distPath, 'index.html')
    content = await readFile(servedPath)
  }
  const extension = path.extname(servedPath).toLowerCase()
  const immutableAsset = decodedPath.startsWith('/assets/') && /-[A-Za-z0-9_-]+\.[^.]+$/.test(decodedPath)
  response.writeHead(200, {
    'Cache-Control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Length': content.length,
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
  })
  if (request.method === 'HEAD') return response.end()
  response.end(content)
}

const api = createServer(async (request, response) => {
  const requestId = request.headers['x-request-id']?.toString().slice(0, 128) || randomUUID()
  const startedAt = Date.now()
  response.setHeader('X-Request-Id', requestId)
  applySecurityHeaders(request, response)
  response.once('finish', () => {
    const pathname = (() => { try { return new URL(request.url || '/', 'http://localhost').pathname } catch { return 'invalid' } })()
    if (!['/healthz', '/readyz'].includes(pathname)) {
      log('info', 'request_completed', { requestId, method: request.method, path: pathname, status: response.statusCode, durationMs: Date.now() - startedAt })
    }
  })
  request.once('aborted', () => {
    log('warn', 'request_aborted', { requestId, method: request.method, path: request.url, durationMs: Date.now() - startedAt })
  })
  response.once('close', () => {
    if (!response.writableEnded) {
      log('warn', 'response_closed_early', { requestId, method: request.method, path: request.url, durationMs: Date.now() - startedAt })
    }
  })

  try {
    if (!request.url || request.url.length > 2048) return send(response, 414, { error: 'Request URL is too long' })
    const requestUrl = new URL(request.url, 'http://localhost')
    const parts = requestUrl.pathname.split('/').filter(Boolean)

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      return send(response, 200, { status: 'ok' })
    }
    if (request.method === 'GET' && requestUrl.pathname === '/readyz') {
      if (shuttingDown) return send(response, 503, { status: 'shutting_down' })
      try {
        await Promise.all([readInventory(), readInfrastructureInventory(infrastructureInventoryPath)])
        return send(response, 200, { status: 'ready' })
      } catch {
        return send(response, 503, { status: 'not_ready' })
      }
    }
    if (parts[0] === 'api' && !isAuthorized(request)) {
      return send(response, 401, { error: 'Authentication required' }, { 'WWW-Authenticate': 'Basic realm="Pulseboard", charset="UTF-8"' })
    }

    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'servers') {
      const inventory = await readInventory()
      const teamCityStatus = getTeamCityMachineStatus(inventory, { force: requestUrl.searchParams.has('refresh') })
      const teamCityAgentStatus = inventory.some((server) => server.teamCityAgent) ? getTeamCityAgentInventory() : undefined
      const latestComponentsByBranch = new Map()
      return send(response, 200, await Promise.all(inventory.map((server) => getServerStatus(server, teamCityStatus, latestComponentsByBranch, teamCityAgentStatus))))
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/infrastructure-status') {
      return send(response, 200, await infrastructureMonitor.getStatus({ force: requestUrl.searchParams.has('refresh') }))
    }
    if (request.method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'servers') {
      const inventory = await readInventory()
      const serverName = decodePathPart(parts[2])
      if (serverName === undefined) return send(response, 400, { error: 'Invalid server name' })
      const server = inventory.find((item) => item.name === serverName)
      if (!server) return send(response, 404, { error: 'Server not found' })
      const teamCityStatus = getTeamCityMachineStatus(inventory, {
        force: requestUrl.searchParams.has('refresh'),
        serverName: server.name,
      })
      const teamCityAgentStatus = server.teamCityAgent ? getTeamCityAgentInventory() : undefined
      return send(response, 200, await getServerStatus(server, teamCityStatus, new Map(), teamCityAgentStatus))
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'integrations') {
      const releaseParameter = requestUrl.searchParams.get('release')
      const releaseOverride = releaseParameter === null ? undefined : normalizeReleaseCheck(releaseParameter)
      if (releaseParameter !== null && !releaseOverride) return send(response, 400, { error: 'Version must use the form 11.8.5.0 or v11.8.5.0' })
      const selectedRelease = releaseOverride || currentTeamCityBranch()
      const [currentRelease, gitlab, teamcity] = await Promise.all([getCurrentRelease(releaseOverride), getGitLabPipeline(selectedRelease), getTeamCityBuild(selectedRelease)])
      return send(response, 200, { currentRelease, gitlab, teamcity })
    }
    if (parts[0] === 'api' && parts[1] === 'ad') {
      try {
        if (request.method === 'GET' && requestUrl.pathname === '/api/ad/summary') {
          const result = await adPasswords.listUsers({
            view: 'expiring', query: '',
            ...(requestUrl.searchParams.has('refresh') ? { force: true } : {}),
          })
          return send(response, 200, {
            status: result.status,
            expiredCount: result.users.filter((user) => user.expiryStatus === 'expired').length,
            expiringCount: result.users.filter((user) => user.expiryStatus === 'scheduled').length,
            mustChangeCount: result.users.filter((user) => user.expiryStatus === 'must_change').length,
            warnings: result.warnings,
            checkedAt: result.checkedAt,
          })
        }
        if (request.method === 'GET' && requestUrl.pathname === '/api/ad/users') {
          return send(response, 200, await adPasswords.listUsers({
            view: requestUrl.searchParams.get('view') || 'expiring',
            query: requestUrl.searchParams.get('q') || '',
            ...(requestUrl.searchParams.has('refresh') ? { force: true } : {}),
          }))
        }
        if (request.method === 'POST' && requestUrl.pathname === '/api/ad/reset-password') {
          if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
          const result = await adPasswords.resetPassword(await readAdResetRequest(request))
          log(result.warnings.length ? 'warn' : 'info', 'ad_password_reset', {
            requestId, actor: configuredValue('DASHBOARD_USERNAME') || 'development',
            userId: result.user.id, accountName: result.user.accountName,
            forceChangeAtNextLogon: result.forceChangeAtNextLogon, accountUnlocked: result.accountUnlocked, warnings: result.warnings,
          })
          return send(response, 200, result)
        }
        return send(response, 404, { error: 'AD endpoint not found' })
      } catch (error) {
        const status = error instanceof AdPasswordError ? error.status : 502
        if (request.method === 'POST') log('warn', 'ad_password_reset_failed', { requestId, status })
        return send(response, status, { error: error instanceof AdPasswordError ? error.message : 'The AD operation could not be completed.' })
      }
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/deployment-schedules') {
      return send(response, 200, { schedules: await deploymentScheduler.list(requestUrl.searchParams.get('server') || undefined) })
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/scheduled-jobs') {
      return send(response, 200, { jobs: await scheduledJobManager.list(), timeZone: scheduledJobManager.timeZone() })
    }
    if (request.method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'scheduled-jobs') {
      return send(response, 200, await scheduledJobManager.get(parts[2]))
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/scheduled-jobs') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const job = await scheduledJobManager.create(await readScheduledJobRequest(request), configuredValue('DASHBOARD_USERNAME') || 'development')
      return send(response, 201, job)
    }
    if (request.method === 'PUT' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'scheduled-jobs') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      return send(response, 200, await scheduledJobManager.update(parts[2], await readScheduledJobRequest(request), configuredValue('DASHBOARD_USERNAME') || 'development'))
    }
    if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'scheduled-jobs' && parts[3] === 'run') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      return send(response, 202, await scheduledJobManager.runNow(parts[2], configuredValue('DASHBOARD_USERNAME') || 'development'))
    }
    if (request.method === 'DELETE' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'scheduled-jobs') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      return send(response, 200, await scheduledJobManager.remove(parts[2], configuredValue('DASHBOARD_USERNAME') || 'development'))
    }
    if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'servers' && parts[3] === 'deployment-schedule') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const serverName = decodePathPart(parts[2])
      if (!serverName) return send(response, 400, { error: 'Invalid server name' })
      const schedule = await deploymentScheduler.create(serverName, await readScheduleRequest(request), configuredValue('DASHBOARD_USERNAME') || 'development')
      return send(response, 202, schedule)
    }
    if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'deployment-schedules' && parts[3] === 'cancel') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      return send(response, 200, await deploymentScheduler.cancel(parts[2], configuredValue('DASHBOARD_USERNAME') || 'development'))
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gitlab/approvals') {
      return send(response, 200, await listGitLabApprovals())
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/gitlab/approval-summary') {
      return send(response, 200, await getGitLabApprovalSummary())
    }
    if (request.method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'gitlab' && parts[2] === 'merge-requests' && parts[4] === 'approve') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      try {
        const result = await approveGitLabMergeRequest(parts[3], await readApprovalRequest(request))
        log('info', 'gitlab_merge_request_approved', { requestId, project: result.projectId, iid: result.iid, sha: result.sha, userId: result.user.id, username: result.user.username })
        return send(response, 200, result)
      } catch (error) {
        if (!(error instanceof GitLabApprovalError)) throw error
        return send(response, error.status, { error: error.message })
      }
    }
    if (request.method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'config') {
      return send(response, 200, {
        autoRefreshSeconds: autoRefreshSeconds(),
        statusRequestTimeoutMs: teamCityServiceStatusTimeoutMs() + 60000,
      })
    }
    if (request.method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'teamcity' && parts[2] === 'builds') {
      const buildId = decodePathPart(parts[3])
      if (!buildId || !/^\d+$/.test(buildId)) return send(response, 400, { error: 'Invalid TeamCity build ID' })
      return send(response, 200, await getTeamCityBuildProgress(buildId))
    }
    if (request.method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'teamcity' && parts[2] === 'components' && parts[4] === 'trigger') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const componentKey = decodePathPart(parts[3])?.toLowerCase()
      const configuration = teamCityComponentBuildTypes().find((component) => component.key === componentKey)
      if (!configuration) return send(response, 404, { error: 'TeamCity component was not found' })
      let requestedRelease
      try { requestedRelease = await readComponentBuildRelease(request) } catch (error) {
        return send(response, error.message === 'Request body is too large' ? 413 : 400, { error: error.message })
      }
      if (!integrationConfigured('TEAMCITY')) return send(response, 503, { error: 'TeamCity is not configured' })
      const branch = requestedRelease || currentTeamCityBranch()
      if (!branch) return send(response, 409, { error: 'CURRENT_RELEASE is not configured' })

      const actionKey = `${configuration.key}:${branch}`.toLowerCase()
      const activeRequest = componentBuildActionLocks.get(actionKey)
      if (activeRequest) {
        const progress = activeRequest.buildId
          ? await getTeamCityBuildProgress(activeRequest.buildId)
          : { status: 'queued' }
        const recentlySubmitted = Date.now() - activeRequest.startedAt < 15 * 60 * 1000
        if (['queued', 'running'].includes(progress.status) || (progress.status === 'unknown' && recentlySubmitted)) {
          return send(response, 409, { error: `${configuration.label} already has a build in progress on ${branch}` }, { 'Retry-After': '15' })
        }
        componentBuildActionLocks.delete(actionKey)
      }

      const activity = await getTeamCityComponentActivity(configuration, branch)
      if (activity.status === 'unknown') return send(response, 503, { error: activity.reason || `Unable to check pending ${configuration.label} changes` })
      if (activity.activeBuild) return send(response, 409, { error: `${configuration.label} already has a ${activity.activeBuild.state} build on ${branch}` })
      if (!activity.pendingChanges) return send(response, 409, { error: `${configuration.label} has no pending changes on ${branch}` })

      componentBuildActionLocks.set(actionKey, { startedAt: Date.now() })
      let result
      try {
        const properties = configuration.key === 'console'
          ? [
              { name: 'reverse.dep.*.system.Version', value: normalizeTeamCityBranch(branch)?.slice(1) },
              { name: 'system.Version', value: normalizeTeamCityBranch(branch)?.slice(1) },
            ]
          : []
        result = await queueTeamCityBuild(
          configuration.buildTypeId,
          properties,
          '',
          { branchName: branch },
        )
      } finally {
        if (!result || result.status !== 'queued') componentBuildActionLocks.delete(actionKey)
      }
      if (result.status === 'queued') componentBuildActionLocks.set(actionKey, { buildId: result.buildId, startedAt: Date.now() })
      const responseBody = { ...result, component: configuration.label, componentKey: configuration.key, branch, pendingChanges: activity.pendingChanges }
      log('info', 'component_build_requested', { requestId, component: configuration.label, branch, buildTypeId: configuration.buildTypeId, result: result.status, buildId: result.buildId })
      return send(response, result.status === 'queued' ? 202 : 503, responseBody)
    }
    if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'servers' && parts[3] === 'deploy') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const inventory = await readInventory()
      const serverName = decodePathPart(parts[2])
      if (serverName === undefined) return send(response, 400, { error: 'Invalid server name' })
      const server = inventory.find((item) => item.name === serverName)
      if (!server) return send(response, 404, { error: 'Server not found' })
      if (!server.deploymentBuildTypeId) return send(response, 409, { error: 'Deployment pipeline is not configured for this server' })

      return await deploymentScheduler.guardImmediate(server.name, async () => {
      const actionKey = serverStatusCacheKey(server.name)
      const activeDeployment = deploymentActionLocks.get(actionKey)
      if (activeDeployment) {
        const progress = activeDeployment.buildId
          ? await getTeamCityBuildProgress(activeDeployment.buildId)
          : { status: 'queued' }
        const recentlySubmitted = Date.now() - activeDeployment.startedAt < 15 * 60 * 1000
        if (['queued', 'running'].includes(progress.status) || (progress.status === 'unknown' && recentlySubmitted)) {
          return send(response, 409, { error: `A deployment for ${server.name} is already in progress` }, { 'Retry-After': '15' })
        }
        deploymentActionLocks.delete(actionKey)
      }

      const trackedJob = await deploymentScheduler.beginImmediate(server, configuredValue('DASHBOARD_USERNAME') || 'development')
      deploymentActionLocks.set(actionKey, { startedAt: Date.now() })
      let result
      try {
        result = await queueTeamCityDeployment(server)
      } finally {
        if (!result || result.status !== 'queued') deploymentActionLocks.delete(actionKey)
        try { await deploymentScheduler.finishImmediate(trackedJob.id, result) }
        catch {
          log('warn', 'deployment_tracking_unconfirmed', { requestId, server: server.name, scheduleId: trackedJob.id })
          if (result) result.reason = 'Deployment submission was processed, but tracking could not be saved. Check TeamCity before taking another action.'
        }
      }
      if (result.status === 'queued') deploymentActionLocks.set(actionKey, { buildId: result.buildId, startedAt: Date.now() })
      log('info', 'deployment_requested', { requestId, server: server.name, buildTypeId: server.deploymentBuildTypeId, result: result.status, buildId: result.buildId })
      return send(response, result.status === 'queued' ? 202 : 503, result)
      })
    }
    if (request.method === 'GET' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'servers' && parts[3] === 'services') {
      const inventory = await readInventory()
      const serverName = decodePathPart(parts[2])
      const serviceName = decodePathPart(parts[4])
      if (serverName === undefined || serviceName === undefined) return send(response, 400, { error: 'Invalid server or service name' })
      const server = inventory.find((item) => item.name === serverName)
      const service = server?.services?.find((item) => item.name === serviceName)
      if (!server || !service) return send(response, 404, { error: 'Server or service not found' })
      if (teamCityServiceConfigured()) {
        const status = await getTeamCityMachineStatus(inventory, {
          force: requestUrl.searchParams.has('refresh'),
          serverName: server.name,
        })
        return send(response, 200, { status: status?.services.get(serviceStatusKey(server.name, service.name)) || 'unknown' })
      }
      if (!(await isReachable(server.ip, server.checkPort || 443))) return send(response, 200, { status: 'unknown', reason: 'Server is unreachable' })
      return send(response, 200, await remoteService(server.ip, service.serviceKey || service.name))
    }
    if (request.method === 'POST' && parts.length === 6 && parts[0] === 'api' && parts[1] === 'servers' && parts[3] === 'services' && ['start', 'stop'].includes(parts[5])) {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const inventory = await readInventory()
      const serverName = decodePathPart(parts[2])
      const serviceName = decodePathPart(parts[4])
      if (serverName === undefined || serviceName === undefined) return send(response, 400, { error: 'Invalid server or service name' })
      const server = inventory.find((item) => item.name === serverName)
      const service = server?.services?.find((item) => item.name === serviceName)
      if (!server || !service) return send(response, 404, { error: 'Server or service not found' })

      const actionKey = serviceStatusKey(server.name, service.name)
      const lockedUntil = serviceActionLocks.get(actionKey) || 0
      if (lockedUntil > Date.now()) {
        return send(response, 409, { error: 'A service action is already in progress; retry shortly' }, { 'Retry-After': String(Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000))) })
      }
      serviceActionLocks.set(actionKey, Date.now() + 15000)
      let result
      try {
        if (teamCityServiceConfigured()) result = await queueTeamCityServiceAction(server, service, parts[5])
        else if (!(await isReachable(server.ip, server.checkPort || 443))) result = { status: 'unknown', reason: 'Server is unreachable' }
        else result = await remoteService(server.ip, service.serviceKey || service.name, parts[5])
      } finally {
        if (!result || result.status !== 'queued') serviceActionLocks.delete(actionKey)
      }
      if (result.status === 'queued') serviceActionLocks.set(actionKey, Date.now() + 30000)
      log('info', 'service_action_requested', { requestId, server: server.name, service: service.name, action: parts[5], result: result.status, buildId: result.buildId })
      return send(response, result.status === 'unknown' ? 503 : result.status === 'queued' ? 202 : 200, result)
    }
    if (request.method === 'POST' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'servers' && parts[3] === 'iis' && parts[4] === 'restart') {
      if (request.headers['x-pulseboard-request'] !== '1') return send(response, 403, { error: 'Missing request verification header' })
      const inventory = await readInventory()
      const serverName = decodePathPart(parts[2])
      if (serverName === undefined) return send(response, 400, { error: 'Invalid server name' })
      const server = inventory.find((item) => item.name === serverName && item.services)
      if (!server) return send(response, 404, { error: 'Test server not found' })

      const actionKey = serviceStatusKey(server.name, 'IIS')
      const lockedUntil = serviceActionLocks.get(actionKey) || 0
      if (lockedUntil > Date.now()) {
        return send(response, 409, { error: 'An IIS restart is already in progress; retry shortly' }, { 'Retry-After': String(Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000))) })
      }
      serviceActionLocks.set(actionKey, Date.now() + 15000)
      let result
      try {
        if (teamCityServiceConfigured()) result = await queueTeamCityIisRestart(server)
        else if (!(await isReachable(server.ip, server.checkPort || 443))) result = { status: 'unknown', reason: 'Server is unreachable' }
        else result = await remoteIisRestart(server.ip)
      } finally {
        if (!result || result.status !== 'queued') serviceActionLocks.delete(actionKey)
      }
      if (result.status === 'queued') serviceActionLocks.set(actionKey, Date.now() + 30000)
      log('info', 'iis_restart_requested', { requestId, server: server.name, result: result.status, buildId: result.buildId })
      return send(response, result.status === 'unknown' ? 503 : result.status === 'queued' ? 202 : 200, result)
    }
    if (['GET', 'HEAD'].includes(request.method) && parts[0] !== 'api') return serveFrontend(request, response, requestUrl)
    return send(response, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof DeploymentScheduleError) return send(response, error.status, { error: error.message })
    if (error instanceof ScheduledJobError) return send(response, error.status, { error: error.message })
    log('error', 'request_failed', { requestId, error: error instanceof Error ? error.message : String(error) })
    return send(response, 500, { error: 'Internal server error', requestId })
  }
})

api.requestTimeout = teamCityServiceStatusTimeoutMs() + 60000
// Keep the upstream connection alive slightly longer than the common
// 60-second reverse-proxy idle timeout, while retaining bounded protection
// against incomplete request headers.
api.headersTimeout = 70000
api.keepAliveTimeout = 65000
api.keepAliveTimeoutBuffer = 1000
api.maxHeadersCount = 100
api.on('clientError', (error, socket) => {
  log('warn', 'client_error', {
    code: error.code,
    error: error.message,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
  })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})

function startServer() {
  validateRuntimeConfig()
  return api.listen(port, host, () => {
    deploymentScheduler.start()
    scheduledJobManager.start()
    log('info', 'server_started', { host, port, nodeEnv: process.env.NODE_ENV || 'development', authMode: authenticationMode() })
  })
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  deploymentScheduler.stop()
  scheduledJobManager.stop()
  log('info', 'server_stopping', { signal })
  api.close((error) => {
    if (error) log('error', 'server_shutdown_failed', { error: error.message })
    process.exitCode = error ? 1 : 0
  })
  setTimeout(() => {
    log('warn', 'server_shutdown_forced')
    api.closeAllConnections()
  }, 10000).unref()
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  startServer()
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export {
  aggregatePendingChangeSources,
  api,
  deploymentScheduler,
  scheduledJobManager,
  getTeamCityBuildProgress,
  compareDeploymentBuilds,
  currentTeamCityBranch,
  extractVenioVersion,
  filterTeamCityBuildsForBranch,
  normalizeTeamCityDate,
  normalizeTeamCityBranch,
  normalizeReleaseCheck,
  parseDeployedBuildsPage,
  parseTeamCityDiskStatuses,
  parseTeamCityServiceStatuses,
  readInventory,
  startServer,
  summarizeTeamCityAgentStatus,
  teamCityBuildPayload,
  validateInventory,
  validateRuntimeConfig,
}
