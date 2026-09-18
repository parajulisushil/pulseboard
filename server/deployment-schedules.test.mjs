import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDeploymentScheduler, readScheduleRequest } from './deployment-schedules.mjs'
import { api, deploymentScheduler, getTeamCityBuildProgress } from './index.mjs'

async function fixture(context, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pulseboard-schedules-'))
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  })
  const clock = { value: Date.parse('2026-09-07T10:00:00Z') }
  const builds = new Map([
    ['21', { buildId: 21, status: 'running', webUrl: 'https://teamcity.test/build/21' }],
    ['22', { buildId: 22, status: 'running' }],
    ['101', { buildId: 101, status: 'queued' }],
  ])
  const servers = new Map([['Machine A', { name: 'Machine A', deploymentBuildTypeId: 'Deploy_A' }], ['Machine B', { name: 'Machine B', deploymentBuildTypeId: 'Deploy_B' }]])
  const calls = []
  const state = { busy: false, origin: 'https://teamcity.test' }
  const options = {
    filePath: path.join(directory, 'schedules.json'),
    now: () => clock.value,
    getServer: async (name) => servers.get(name),
    getBuild: async (id) => builds.get(String(id)) || { status: 'unknown' },
    isDeploymentBusy: async () => state.busy,
    queueDeployment: async (server, job) => { calls.push({ server, job }); return { status: 'queued', buildId: 101, webUrl: 'https://teamcity.test/build/101' } },
    teamCityUrl: () => state.origin,
    ...overrides,
  }
  return { scheduler: createDeploymentScheduler(options), options, clock, builds, servers, calls, state }
}

test('delayed deployments wait until the exact due time, queue once, and track completion', async (context) => {
  const f = await fixture(context)
  const job = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  assert.equal(job.status, 'waiting_time')
  assert.equal(job.notBefore, '2026-09-07T10:01:00.000Z')
  assert.equal(f.calls.length, 0)
  f.clock.value += 59999
  await f.scheduler.tick()
  assert.equal(f.calls.length, 0)
  f.clock.value++
  await f.scheduler.tick()
  assert.equal(f.calls.length, 1)
  assert.equal((await f.scheduler.list())[0].status, 'queued')
  await f.scheduler.tick()
  assert.equal(f.calls.length, 1)
  f.builds.set('101', { buildId: 101, status: 'running' })
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list())[0].status, 'running')
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  const completed = (await f.scheduler.list())[0]
  assert.equal(completed.status, 'success')
  assert.equal(completed.active, false)
  assert.equal(completed.canCancel, false)
  assert.equal(f.calls.length, 1)
})

test('waits for the specific selected build, regardless of other builds still running', async (context) => {
  const f = await fixture(context)
  const job = await f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '21' }, 'operator')
  assert.equal(job.afterBuildId, '21')
  await f.scheduler.tick()
  assert.equal(f.calls.length, 0)
  f.builds.set('21', { buildId: 21, status: 'success' })
  assert.equal(f.builds.get('22').status, 'running')
  await f.scheduler.tick()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].server.deploymentBuildTypeId, 'Deploy_A')
})

test('successful deployments verify after completion, retry, and resume verification after restart', async (context) => {
  let checks = 0
  const f = await fixture(context, { verifyDeployment: async () => {
    checks++
    return { status: checks === 1 ? 'needs_attention' : 'passed', login: { status: 'passed' }, allServicesRunning: checks > 1 }
  } })
  await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  await f.scheduler.tick()
  assert.equal(checks, 0)
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list())[0].status, 'verifying')
  await f.scheduler.tick()
  assert.equal(checks, 1)
  assert.equal((await f.scheduler.list())[0].active, true)
  await f.scheduler.tick()
  assert.equal(checks, 1)
  const restarted = createDeploymentScheduler(f.options)
  f.clock.value += 30000
  await restarted.tick()
  const result = (await restarted.list())[0]
  assert.equal(result.status, 'success')
  assert.equal(result.verificationAttempts, 2)
  assert.equal(result.active, false)
  assert.equal(f.calls.length, 1)
})

test('immediate deployments persist before submission and verify without an open dashboard', async (context) => {
  const f = await fixture(context, { verifyDeployment: async () => ({ status: 'passed', login: { status: 'passed' }, allServicesRunning: true }) })
  await f.scheduler.guardImmediate('Machine A', async () => {
    const job = await f.scheduler.beginImmediate(f.servers.get('Machine A'), 'operator')
    assert.equal(JSON.parse(await readFile(f.options.filePath, 'utf8')).schedules[0].status, 'submitting')
    await f.scheduler.finishImmediate(job.id, { status: 'queued', buildId: 101 })
  })
  const restarted = createDeploymentScheduler(f.options)
  f.builds.set('101', { buildId: 101, status: 'success' })
  await restarted.tick()
  await restarted.tick()
  assert.equal((await restarted.list())[0].status, 'success')
  assert.equal((await restarted.list())[0].mode, 'immediate')
  assert.equal(f.calls.length, 0)
})

test('unavailable verification stops after three checks without redeploying', async (context) => {
  let checks = 0
  const f = await fixture(context, { verifyDeployment: async () => { checks++; throw new Error('private diagnostic') } })
  await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  for (let index = 0; index < 4; index++) { await f.scheduler.tick(); f.clock.value += 30000 }
  const result = (await f.scheduler.list())[0]
  assert.equal(checks, 3)
  assert.equal(result.status, 'verification_failed')
  assert.equal(result.active, false)
  assert.equal(result.verification.login.status, 'unknown')
  assert(!JSON.stringify(result).includes('private diagnostic'))
  assert.equal(f.calls.length, 1)
})

test('refreshing failed checks persists, prevents duplicate actions, and recovers without redeploying', async (context) => {
  let healthy = false
  const verify = context.mock.fn(async () => ({
    status: healthy ? 'passed' : 'needs_attention', checkedAt: new Date(f.clock.value).toISOString(),
    login: { status: healthy ? 'passed' : 'failed', reason: healthy ? 'Login available.' : 'Login not ready.' },
    services: [{ name: 'ApplicationService', status: 'running' }], allServicesRunning: true, servicesReason: 'All services running.',
  }))
  const audit = context.mock.fn()
  const f = await fixture(context, { verifyDeployment: verify, audit })
  const older = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  await f.scheduler.cancel(older.id, 'operator')
  const job = await f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '21' }, 'operator')
  f.builds.set('21', { buildId: 21, status: 'success' })
  await f.scheduler.tick()
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  for (let index = 0; index < 3; index++) { await f.scheduler.tick(); f.clock.value += 30000 }
  const failed = (await f.scheduler.list('Machine A'))[0]
  assert.equal(failed.status, 'verification_failed')
  assert.equal(failed.canRecheck, true)
  await f.scheduler.list('Machine A')
  await f.scheduler.tick()
  assert.equal(verify.mock.callCount(), 3, 'Reading saved results must not rerun checks')

  const requests = await Promise.allSettled([f.scheduler.recheck(job.id, 'operator'), f.scheduler.recheck(job.id, 'operator')])
  assert.equal(requests.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(requests.find((result) => result.status === 'rejected').reason.status, 409)
  const refreshing = requests.find((result) => result.status === 'fulfilled').value
  assert.equal(refreshing.status, 'verifying')
  assert.equal(refreshing.active, true)
  assert.equal(refreshing.canRecheck, false)
  assert.equal(refreshing.verificationAttempts, 0)
  assert.equal(refreshing.nextVerificationAt, null)
  assert.deepEqual(refreshing.verification, failed.verification, 'Keep the previous results until fresh results arrive')
  assert.equal(JSON.parse(await readFile(f.options.filePath, 'utf8')).schedules.find((item) => item.id === job.id).status, 'verifying')
  await assert.rejects(f.scheduler.recheck(job.id, 'operator'), { status: 409 })
  await assert.rejects(f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator'), { status: 409 })
  await assert.rejects(f.scheduler.guardImmediate('Machine A', async () => assert.fail('Must not deploy during checks')), { status: 409 })

  healthy = true
  const getBuild = context.mock.fn(async () => assert.fail('Refreshing must not inspect deployment or prerequisite builds'))
  const queueDeployment = context.mock.fn(async () => assert.fail('Refreshing must not deploy'))
  const restarted = createDeploymentScheduler({ ...f.options, getBuild, queueDeployment })
  await restarted.tick()
  const result = (await restarted.list('Machine A'))[0]
  assert.equal(result.id, job.id, 'Refreshing must preserve the latest deployment in history')
  assert.equal(result.status, 'success')
  assert.equal(result.canRecheck, true)
  assert.equal(result.active, false)
  assert.equal(result.verificationAttempts, 1)
  assert.equal(result.buildId, failed.buildId)
  assert.equal(result.webUrl, failed.webUrl)
  assert.notEqual(result.verification.checkedAt, failed.verification.checkedAt)
  assert.equal(result.verification.login.status, 'passed')
  assert.equal(verify.mock.callCount(), 4)
  assert.equal(getBuild.mock.callCount(), 0)
  assert.equal(queueDeployment.mock.callCount(), 0)
  assert.equal(f.calls.length, 1)
  const requestAudit = audit.mock.calls.find((call) => call.arguments[0] === 'deployment_verification_requested')
  assert.deepEqual(requestAudit.arguments[1], { scheduleId: job.id, server: 'Machine A', buildId: 101, actor: 'operator' })
  const saved = createDeploymentScheduler(f.options)
  assert.deepEqual((await saved.list('Machine A'))[0], result)
})

test('successful immediate deployments can be refreshed, and each failed refresh has a fresh retry limit', async (context) => {
  let running = true
  const f = await fixture(context, { verifyDeployment: async () => ({
    status: running ? 'passed' : 'needs_attention', checkedAt: new Date(f.clock.value).toISOString(),
    login: { status: 'passed' }, services: [{ name: 'ApplicationService', status: running ? 'running' : 'stopped' }], allServicesRunning: running,
  }) })
  let job
  await f.scheduler.guardImmediate('Machine A', async () => {
    job = await f.scheduler.beginImmediate(f.servers.get('Machine A'), 'operator')
    await f.scheduler.finishImmediate(job.id, { status: 'queued', buildId: 101 })
  })
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list())[0].status, 'success')
  running = false
  for (let cycle = 0; cycle < 2; cycle++) {
    await f.scheduler.recheck(job.id, 'operator')
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.clock.value += 30000
      await f.scheduler.tick()
      const result = (await f.scheduler.list())[0]
      assert.equal(result.verificationAttempts, attempt)
      assert.equal(result.status, attempt === 3 ? 'verification_failed' : 'verifying')
      assert.equal(result.verification.login.status, 'passed')
      assert.equal(result.verification.services[0].status, 'stopped')
      assert.equal(result.verification.checkedAt, new Date(f.clock.value).toISOString())
    }
    await f.scheduler.tick()
    assert.equal((await f.scheduler.list())[0].canRecheck, true)
  }
  assert.equal(f.calls.length, 0)
})

test('refresh rejects missing, unfinished, unsuccessful, and superseded deployments', async (context) => {
  const verify = context.mock.fn(async () => ({ status: 'passed', login: { status: 'passed' }, allServicesRunning: true }))
  const f = await fixture(context, { verifyDeployment: verify })
  await assert.rejects(f.scheduler.recheck('missing', 'operator'), { status: 404 })
  const cancelled = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  await assert.rejects(f.scheduler.recheck(cancelled.id, 'operator'), { status: 409 })
  await f.scheduler.cancel(cancelled.id, 'operator')
  await assert.rejects(f.scheduler.recheck(cancelled.id, 'operator'), { status: 409 })
  const failed = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  await assert.rejects(f.scheduler.recheck(failed.id, 'operator'), { status: 409 })
  f.builds.set('101', { buildId: 101, status: 'failure' })
  await f.scheduler.tick()
  await assert.rejects(f.scheduler.recheck(failed.id, 'operator'), { status: 409 })
  assert.equal(verify.mock.callCount(), 0)
  const completed = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  await f.scheduler.tick()
  const newer = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  assert.equal((await f.scheduler.list()).find((item) => item.id === completed.id).canRecheck, false)
  await assert.rejects(f.scheduler.recheck(completed.id, 'operator'), { status: 409 })
  await f.scheduler.cancel(newer.id, 'operator')
  await assert.rejects(f.scheduler.recheck(completed.id, 'operator'), { status: 409 })
  assert.equal(verify.mock.callCount(), 1)
})

test('refresh rejects changed configuration or unavailable verification without changing saved results', async (context) => {
  const f = await fixture(context, { verifyDeployment: async () => ({ status: 'passed', login: { status: 'passed' }, allServicesRunning: true }) })
  const job = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  await f.scheduler.tick()
  const completed = (await f.scheduler.list())[0]
  const server = f.servers.get('Machine A')
  f.servers.delete('Machine A')
  await assert.rejects(f.scheduler.recheck(job.id, 'operator'), { status: 409 })
  f.servers.set('Machine A', { ...server, deploymentBuildTypeId: 'Changed' })
  await assert.rejects(f.scheduler.recheck(job.id, 'operator'), { status: 409 })
  f.servers.set('Machine A', server)
  f.state.origin = 'https://different-teamcity.test'
  await assert.rejects(f.scheduler.recheck(job.id, 'operator'), { status: 409 })
  assert.deepEqual((await f.scheduler.list())[0], completed)
  const unavailable = createDeploymentScheduler({ ...f.options, verifyDeployment: undefined })
  assert.equal((await unavailable.list())[0].canRecheck, false)
  await assert.rejects(unavailable.recheck(job.id, 'operator'), { status: 409 })
  assert.equal(f.calls.length, 1)
})

test('a slow verification does not delay another machine’s scheduled deployment', async (context) => {
  let release
  let started
  const waiting = new Promise((resolve) => { release = resolve })
  const checking = new Promise((resolve) => { started = resolve })
  context.after(() => release())
  const f = await fixture(context, { verifyDeployment: async () => {
    started(); await waiting
    return { status: 'passed', login: { status: 'passed' }, allServicesRunning: true }
  } })
  await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  await f.scheduler.create('Machine B', { mode: 'delay', delayMinutes: 2 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  f.builds.set('101', { buildId: 101, status: 'success' })
  await f.scheduler.tick()
  const inFlight = f.scheduler.tick()
  await checking
  f.clock.value += 60000
  await f.scheduler.tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].server.name, 'Machine B')
  release()
  await inFlight
})

test('failed or wrong-ID deployment results never begin verification', async (context) => {
  for (const progress of [{ buildId: 999, status: 'success' }, { buildId: 101, status: 'failure' }, { buildId: 101, status: 'cancelled' }]) {
    let checks = 0
    const f = await fixture(context, { verifyDeployment: async () => { checks++ } })
    await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
    f.clock.value += 60000
    await f.scheduler.tick()
    f.builds.set('101', progress)
    await f.scheduler.tick()
    await f.scheduler.tick()
    assert.equal(checks, 0)
    assert.equal((await f.scheduler.list())[0].status, progress.buildId === 999 ? 'queued' : 'failed')
  }
})

test('failed or cancelled prerequisites stop the schedule without deploying', async (context) => {
  for (const status of ['failure', 'cancelled']) {
    const f = await fixture(context)
    await f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '21' }, 'operator')
    f.builds.set('21', { buildId: 21, status })
    await f.scheduler.tick()
    assert.equal((await f.scheduler.list())[0].status, 'failed')
    assert.equal(f.calls.length, 0)
  }
})

test('unavailable prerequisite checks wait safely and recover when successful', async (context) => {
  const f = await fixture(context)
  await f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '21' }, 'operator')
  f.builds.set('21', { status: 'unknown' })
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list())[0].status, 'waiting_build')
  assert.match((await f.scheduler.list())[0].reason, /Cannot verify/)
  assert.equal(f.calls.length, 0)
  f.builds.set('21', { buildId: 22, status: 'success' })
  await f.scheduler.tick()
  assert.equal(f.calls.length, 0)
  f.builds.set('21', { buildId: 21, status: 'success' })
  await f.scheduler.tick()
  assert.equal(f.calls.length, 1)
})

test('pending schedules can be cancelled; submitted deployments cannot be cancelled locally', async (context) => {
  const f = await fixture(context)
  const job = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  assert.equal((await f.scheduler.cancel(job.id, 'operator')).status, 'cancelled')
  f.clock.value += 60000
  await f.scheduler.tick()
  assert.equal(f.calls.length, 0)
  const next = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  await assert.rejects(f.scheduler.cancel(next.id, 'operator'), { status: 409 })
  await assert.rejects(f.scheduler.cancel('missing', 'operator'), { status: 404 })
})

test('duplicate and simultaneous schedules and immediate deployments share a machine lock', async (context) => {
  const f = await fixture(context)
  const results = await Promise.allSettled([
    f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator'),
    f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator'),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  let immediate = false
  await assert.rejects(f.scheduler.guardImmediate('Machine A', async () => { immediate = true }), { status: 409 })
  assert.equal(immediate, false)
  await f.scheduler.create('Machine B', { mode: 'delay', delayMinutes: 1 }, 'operator')
  assert.equal((await f.scheduler.list()).length, 2)
})

test('waiting and queued schedules recover from disk after API restarts', async (context) => {
  const f = await fixture(context)
  await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 120000
  const restarted = createDeploymentScheduler(f.options)
  await restarted.tick()
  assert.equal(f.calls.length, 1)
  const restartedAgain = createDeploymentScheduler(f.options)
  await restartedAgain.tick()
  assert.equal(f.calls.length, 1)
  assert.equal((await restartedAgain.list())[0].buildId, 101)
})

test('uncertain submission and interrupted submission never automatically retry', async (context) => {
  let attempts = 0
  const f = await fixture(context, { queueDeployment: async () => { attempts++; return { status: 'unknown' } } })
  const job = await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  await f.scheduler.tick()
  await f.scheduler.tick()
  assert.equal(attempts, 1)
  assert.equal((await f.scheduler.list())[0].status, 'unconfirmed')
  const data = JSON.parse(await readFile(f.options.filePath, 'utf8'))
  data.schedules[0].status = 'submitting'
  await writeFile(f.options.filePath, JSON.stringify(data))
  const restarted = createDeploymentScheduler(f.options)
  await restarted.tick()
  assert.equal(attempts, 1)
  assert.equal((await restarted.list())[0].status, 'unconfirmed')
  assert.equal((await restarted.cancel(job.id, 'operator')).status, 'cancelled')
})

test('existing deployments delay submission and configuration changes prevent dispatch', async (context) => {
  const f = await fixture(context)
  await f.scheduler.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  f.state.busy = true
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list())[0].status, 'waiting_deployment')
  assert.equal(f.calls.length, 0)
  f.state.busy = false
  await f.scheduler.tick()
  assert.equal(f.calls.length, 1)
  await f.scheduler.create('Machine B', { mode: 'delay', delayMinutes: 1 }, 'operator')
  f.clock.value += 60000
  f.servers.set('Machine B', { name: 'Machine B', deploymentBuildTypeId: 'Changed' })
  await f.scheduler.tick()
  assert.equal((await f.scheduler.list('Machine B'))[0].status, 'failed')
  assert.equal(f.calls.length, 1)
})

test('rejects invalid schedules and failed/unverifiable prerequisites before saving', async (context) => {
  const f = await fixture(context)
  for (const options of [{ mode: 'now' }, { mode: 'delay', delayMinutes: 0 }, { mode: 'delay', delayMinutes: 1441 }, { mode: 'delay', delayMinutes: 1.5 }, { mode: 'after_build', afterBuildId: 'https://untrusted' }]) {
    await assert.rejects(f.scheduler.create('Machine A', options, 'operator'), { status: 400 })
  }
  await assert.rejects(f.scheduler.create('missing', { mode: 'delay', delayMinutes: 1 }, 'operator'), { status: 409 })
  await assert.rejects(f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '99' }, 'operator'), { status: 503 })
  f.builds.set('21', { buildId: 21, status: 'failure' })
  await assert.rejects(f.scheduler.create('Machine A', { mode: 'after_build', afterBuildId: '21' }, 'operator'), { status: 409 })
  assert.equal((await f.scheduler.list()).length, 0)
})

test('unreadable/corrupt storage fails closed, and write failure prevents submission', async (context) => {
  const f = await fixture(context)
  await writeFile(f.options.filePath, '{broken json')
  await assert.rejects(f.scheduler.list(), { status: 503 })
  assert.equal(f.calls.length, 0)
  const g = await fixture(context)
  let location = g.options.filePath
  const blocked = createDeploymentScheduler({ ...g.options, filePath: () => location })
  await blocked.create('Machine A', { mode: 'delay', delayMinutes: 1 }, 'operator')
  // Force writes to fail without changing the already-loaded schedule: parent is a regular file.
  const invalidParent = path.join(path.dirname(g.options.filePath), 'regular-file')
  await writeFile(invalidParent, 'not a directory')
  location = path.join(invalidParent, 'schedules.json')
  g.clock.value += 60000
  await blocked.tick()
  assert.equal(g.calls.length, 0)
  location = g.options.filePath
  await blocked.tick()
  assert.equal(g.calls.length, 1)
})

test('schedule request parser requires a bounded JSON object', async () => {
  const request = (body, type = 'application/json') => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': type } })
  assert.deepEqual(await readScheduleRequest(request('{"mode":"delay","delayMinutes":5}')), { mode: 'delay', delayMinutes: 5 })
  for (const body of ['null', '[]', '{invalid']) await assert.rejects(readScheduleRequest(request(body)), { status: 400 })
  await assert.rejects(readScheduleRequest(request('{}', 'text/plain')), { status: 400 })
  await assert.rejects(readScheduleRequest(request('x'.repeat(4097))), { status: 413 })
})

test('schedule routes enforce authentication and request verification without queuing real builds', async (context) => {
  const previous = Object.fromEntries(['AUTH_MODE', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD'].map((name) => [name, process.env[name]]))
  Object.assign(process.env, { AUTH_MODE: 'basic', DASHBOARD_USERNAME: 'operator', DASHBOARD_PASSWORD: 'long-test-api-password' })
  context.mock.method(deploymentScheduler, 'list', async () => [])
  const create = context.mock.method(deploymentScheduler, 'create', async (name, options) => ({ id: 'test-job', serverName: name, ...options, status: 'waiting_time' }))
  const cancel = context.mock.method(deploymentScheduler, 'cancel', async () => ({ status: 'cancelled' }))
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  context.after(async () => {
    await new Promise((resolve) => api.close(resolve))
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  })
  const base = `http://127.0.0.1:${api.address().port}`
  const authorization = `Basic ${Buffer.from('operator:long-test-api-password').toString('base64')}`
  assert.equal((await fetch(`${base}/api/deployment-schedules`)).status, 401)
  for (const endpoint of ['/api/servers/Machine%20A/deployment-schedule', '/api/deployment-schedules/test-job/cancel']) {
    assert.equal((await fetch(base + endpoint, { method: 'POST' })).status, 401)
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { authorization } })).status, 403)
  }
  assert.equal(create.mock.callCount(), 0)
  assert.equal(cancel.mock.callCount(), 0)
  const response = await fetch(`${base}/api/servers/Machine%20A/deployment-schedule`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-pulseboard-request': '1' }, body: JSON.stringify({ mode: 'delay', delayMinutes: 15 }),
  })
  assert.equal(response.status, 202)
  assert.deepEqual(create.mock.calls[0].arguments, ['Machine A', { mode: 'delay', delayMinutes: 15 }, 'operator'])
  assert.equal((await fetch(`${base}/api/deployment-schedules/test-job/cancel`, { method: 'POST', headers: { authorization, 'x-pulseboard-request': '1' } })).status, 200)
  assert.equal((await fetch(`${base}/api/deployment-schedules/test-job/recheck`, { method: 'POST', headers: { authorization, 'x-pulseboard-request': '1' } })).status, 404)
})

test('TeamCity status reader treats cancelled and failed-to-start builds as unsuccessful', async (context) => {
  const previous = { url: process.env.TEAMCITY_URL, token: process.env.TEAMCITY_TOKEN }
  const remote = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    const id = Number(new URL(request.url, 'http://localhost').pathname.split(':').at(-1))
    response.end(JSON.stringify({ id, state: 'finished', status: 'SUCCESS', ...(id === 21 ? { canceledInfo: { text: 'Cancelled' } } : id === 22 ? { failedToStart: true } : {}), buildType: { name: 'API build' }, branchName: 'v11.8.5.0' }))
  })
  remote.listen(0, '127.0.0.1')
  await once(remote, 'listening')
  process.env.TEAMCITY_URL = `http://127.0.0.1:${remote.address().port}`
  process.env.TEAMCITY_TOKEN = 'fake-token'
  context.after(async () => {
    await new Promise((resolve) => remote.close(resolve))
    for (const [name, value] of [['TEAMCITY_URL', previous.url], ['TEAMCITY_TOKEN', previous.token]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  })
  assert.equal((await getTeamCityBuildProgress('21')).status, 'cancelled')
  assert.equal((await getTeamCityBuildProgress('22')).status, 'failure')
  const success = await getTeamCityBuildProgress('23')
  assert.equal(success.status, 'success')
  assert.equal(success.buildName, 'API build')
  assert.equal(success.branch, 'v11.8.5.0')
})
