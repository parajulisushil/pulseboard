import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { api, getTeamCityComponentActivity } from './index.mjs'

const branch = 'v11.8.5.0'
const build = (id, buildTypeId, startDate, dependencies) => ({ id, buildTypeId, branchName: branch, startDate, number: String(id), webUrl: `https://teamcity.example/build/${id}`, ...(dependencies && { 'snapshot-dependencies': { count: dependencies.length, build: dependencies } }) })
const serviceOld = build(167735, 'Service', '20261028T090349+0000')
const serviceNew = build(167741, 'Service', '20261028T091446+0000', [])
const intermediate = build(50, 'Intermediate', '20261028T090400+0000')
const root = build(167737, 'Setup', '20261028T091138+0000', [intermediate])
root.finishDate = '20261028T093819+0000'

function fixture(context, { included = serviceOld, latest = serviceNew, failSnapshots = false, active = false } = {}) {
  const previous = { TEAMCITY_URL: process.env.TEAMCITY_URL, TEAMCITY_TOKEN: process.env.TEAMCITY_TOKEN }
  process.env.TEAMCITY_URL = 'https://teamcity.example'
  process.env.TEAMCITY_TOKEN = 'test-token'
  context.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const calls = []
  const originalFetch = globalThis.fetch
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(String(url))
    if (request.hostname === '127.0.0.1') return originalFetch(url, options)
    calls.push(request)
    const path = request.pathname
    const locator = request.searchParams.get('locator') || ''
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (path === '/app/rest/buildQueue') { calls.push({ payload: JSON.parse(options.body) }); return response({ id: 900, number: '900' }) }
    if (path.startsWith('/app/rest/buildTypes/')) {
      const id = decodeURIComponent(path.split('/').at(-1)).replace('id:', '')
      const deps = id === 'Setup' ? ['Intermediate'] : id === 'Intermediate' ? ['Service'] : []
      return response({ id, name: id, 'snapshot-dependencies': { 'snapshot-dependency': deps.map((name) => ({ 'source-buildType': { id: name } })) } })
    }
    if (path === '/app/rest/changes') { assert.match(locator, /branch:\(name:v11\.8\.5\.0\)/); return response({ count: 0, change: [] }) }
    if (path === '/app/rest/builds/id:50') return failSnapshots ? response({}, 503) : response(build(50, 'Intermediate', intermediate.startDate, [included]))
    if (path.startsWith('/app/rest/builds/id:')) return response({ ...included, 'snapshot-dependencies': { count: 0, build: [] } })
    if (path === '/app/rest/builds') {
      assert.match(locator, /branch:\(name:v11\.8\.5\.0\)/)
      if (locator.includes('state:running') || locator.includes('state:queued')) return response({ build: active && locator.includes('state:running') && locator.includes('id:Service') ? [{ id: 99, state: 'running', branchName: branch }] : [] })
      assert.match(locator, /state:finished,status:SUCCESS,personal:false/)
      const item = locator.includes('id:Setup') ? root : locator.includes('id:Intermediate') ? { ...intermediate, 'snapshot-dependencies': { count: 1, build: [included] } } : latest
      return response({ count: 1, build: [item] })
    }
    throw new Error(`Unexpected TeamCity request: ${path}`)
  })
  return calls
}
const configuration = { key: 'console', label: 'Console', buildTypeId: 'Setup', includeDependencies: true }

test('detects newer successful dependency builds on the selected branch even when they finish before the setup build', async (context) => {
  const calls = fixture(context)
  const result = await getTeamCityComponentActivity(configuration, branch)
  assert.equal(result.status, 'pending')
  assert.equal(result.pendingChanges, 0)
  assert.equal(result.canTrigger, true)
  assert.deepEqual(result.pendingBuilds.map(({ id, includedBuildIds }) => ({ id, includedBuildIds })), [{ id: 167741, includedBuildIds: [167735] }])
  assert(calls.some((url) => url.pathname === '/app/rest/builds/id:50'))
})

test('does not report builds already included or older than the included dependency', async (context) => {
  fixture(context, { included: serviceNew, latest: serviceOld })
  const result = await getTeamCityComponentActivity(configuration, branch)
  assert.equal(result.status, 'current')
  assert.deepEqual(result.pendingBuilds, [])
  assert.equal(result.canTrigger, false)
})

test('does not offer another trigger while a dependency build is active', async (context) => {
  fixture(context, { active: true })
  const result = await getTeamCityComponentActivity(configuration, branch)
  assert.equal(result.status, 'running')
  assert.equal(result.pendingBuilds.length, 1)
  assert.equal(result.canTrigger, false)
})

test('reports unknown when snapshot data is unavailable', async (context) => {
  fixture(context, { failSnapshots: true })
  const result = await getTeamCityComponentActivity(configuration, branch)
  assert.equal(result.status, 'unknown')
  assert.equal(result.canTrigger, false)
  assert.match(result.reason, /TeamCity returned 503/)
})

test('rejects a latest dependency build from another branch', async (context) => {
  fixture(context, { latest: { ...serviceNew, branchName: 'v11.8.4.0' } })
  const result = await getTeamCityComponentActivity(configuration, branch)
  assert.equal(result.status, 'unknown')
  assert.match(result.reason, /different branch/)
  assert.equal(result.canTrigger, false)
})


test('allows a Console trigger when only a newer dependency build is pending', async (context) => {
  const calls = fixture(context)
  const names = ['TEAMCITY_CONSOLE_BUILD_TYPE_ID', 'CURRENT_RELEASE', 'AUTH_MODE', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, { TEAMCITY_CONSOLE_BUILD_TYPE_ID: 'Setup', CURRENT_RELEASE: branch, AUTH_MODE: 'basic', DASHBOARD_USERNAME: 'operator', DASHBOARD_PASSWORD: 'test-password-long-enough' })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  context.after(async () => {
    await new Promise((resolve) => api.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  })
  const response = await fetch(`http://127.0.0.1:${api.address().port}/api/teamcity/components/console/trigger`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from('operator:test-password-long-enough').toString('base64')}`, 'X-Pulseboard-Request': '1' },
  })
  assert.equal(response.status, 202)
  const result = await response.json()
  assert.equal(result.pendingChanges, 0)
  assert.equal(result.pendingBuilds[0].id, 167741)
  const queued = calls.find((call) => call.payload)?.payload
  assert.equal(queued.branchName, branch)
  assert.equal(queued.buildType.id, 'Setup')
})
