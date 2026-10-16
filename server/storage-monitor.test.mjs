import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classifyStorage, createStorageMonitor, storageNotificationSettings } from './storage-monitor.mjs'

test('storage thresholds use the actual percentage, including strict boundaries and invalid capacities', () => {
  const env = { DISK_WARNING_PERCENT_FREE: '20', DISK_CRITICAL_PERCENT_FREE: '10' }
  assert.equal(classifyStorage(10000, 2000, env).status, 'healthy')
  assert.equal(classifyStorage(10000, 1999, env).status, 'warning')
  assert.equal(classifyStorage(10000, 1000, env).status, 'warning')
  assert.equal(classifyStorage(10000, 999, env).status, 'critical')
  for (const [total, free] of [[0, 0], [100, 101], [100, -1], [100, NaN]]) assert.throws(() => classifyStorage(total, free, env))
})

test('storage Discord configuration is independent of Code Freeze and opt-in', () => {
  assert.deepEqual(storageNotificationSettings({}), { enabled: false })
  const settings = storageNotificationSettings({ STORAGE_DISCORD_ALERTS_ENABLED: 'true', CODE_FREEZE_APPLIED: 'false', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token', PULSEBOARD_PUBLIC_URL: 'https://pulse.example.com' })
  assert.equal(settings.enabled, true)
  assert.throws(() => storageNotificationSettings({ STORAGE_DISCORD_ALERTS_ENABLED: 'true' }))
})

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'storage-monitor-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const state = { free: 150, missing: false, ok: true, calls: [], checks: 0, time: Date.now() }
  const options = {
    inventory: async () => [{ name: 'FS02', remoteHost: 'fs02.ad.veniosystems.com', storage: { drive: 'G:', label: 'TeamCity storage', share: '\\\\fs02\\teamcity' } }],
    checkVolumes: async () => { state.checks++; return state.missing ? [] : [{ name: 'C:', totalBytes: 1000, freeBytes: 900 }, { name: 'G:', totalBytes: 1000, freeBytes: state.free }] },
    filePath: path.join(directory, 'state.json'),
    settings: () => ({ enabled: true, webhook: 'https://discord.example/webhook', appUrl: 'https://pulse.example.com' }),
    fetchImpl: async (_url, request) => { state.calls.push(JSON.parse(request.body)); return { ok: state.ok, status: 429 } },
    now: () => new Date(state.time),
  }
  return { state, options, monitor: createStorageMonitor(options) }
}

test('checks only the configured drive, deduplicates alerts across restart, escalates, and reports recovery', async (t) => {
  const { state, options, monitor } = await fixture(t)
  assert.equal((await monitor.getStatus()).FS02.status, 'unknown')
  assert.equal(state.checks, 0) // API reads never wait on a TeamCity build.
  await Promise.all([monitor.tick(), monitor.tick()])
  assert.equal(state.checks, 1)
  assert.equal((await monitor.getStatus()).FS02.freePercent, 15)
  assert.equal(state.calls.length, 1)
  assert.match(state.calls[0].content, /fs02.ad.veniosystems.com G:/)
  assert.deepEqual(state.calls[0].allowed_mentions, { parse: [], users: [] })
  await createStorageMonitor(options).tick()
  assert.equal(state.calls.length, 1)
  state.free = 50
  await monitor.tick()
  assert.match(state.calls[1].content, /CRITICAL/)
  state.free = 500
  await monitor.tick()
  assert.match(state.calls[2].content, /recovered/)
  await monitor.tick()
  assert.equal(state.calls.length, 3)
})

test('failed delivery retries, missing readings preserve history, and stale snapshots become unknown', async (t) => {
  const { state, monitor } = await fixture(t)
  state.ok = false
  await monitor.tick()
  state.ok = true
  await monitor.tick()
  assert.equal(state.calls.length, 2)
  state.missing = true
  await monitor.tick()
  assert.equal((await monitor.getStatus()).FS02.status, 'unknown')
  assert.equal(state.calls.length, 2)
  state.missing = false
  await monitor.tick()
  assert.equal(state.calls.length, 2)
  state.time += 86400000 + 240001
  assert.equal((await monitor.getStatus()).FS02.status, 'unknown')
})

test('manual refresh fetches a fresh reading and concurrent refreshes share one check', async (t) => {
  const { state, monitor } = await fixture(t)
  await monitor.tick()
  state.free = 500
  assert.equal((await monitor.getStatus()).FS02.freePercent, 15)
  assert.equal(state.checks, 1)
  const [first, second] = await Promise.all([monitor.getStatus({ force: true }), monitor.getStatus({ force: true })])
  assert.equal(state.checks, 2)
  assert.equal(first.FS02.freePercent, 50)
  assert.equal(second.FS02.freePercent, 50)
})

test('background checks run at startup and once per day instead of every five minutes', async (t) => {
  const { state, monitor } = await fixture(t)
  state.free = 500
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => monitor.stop())
  monitor.start()
  await monitor.tick()
  assert.equal(state.checks, 1)
  t.mock.timers.tick(300000)
  await monitor.getStatus()
  assert.equal(state.checks, 1)
  t.mock.timers.tick(86400000 - 300000)
  await monitor.tick()
  assert.equal(state.checks, 2)
})
