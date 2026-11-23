import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEc2Scheduler } from './ec2-schedules.mjs'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ec2-schedule-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let current = new Date('2026-11-23T01:00:00Z') // Monday, 06:45 Kathmandu
  let server = { name: 'Dev', instanceId: 'i-12345678', ec2Control: true }
  const calls = [], file = path.join(dir, 'schedules.json')
  const make = () => createEc2Scheduler({ filePath: () => file, timeZone: () => 'Asia/Kathmandu', getServer: async () => server, now: () => current, execute: async (s, action) => { calls.push([s.instanceId, action]); return { message: 'Accepted' } } })
  return { manager: make(), make, calls, file, setTime: (value) => { current = new Date(value) }, setServer: (value) => { server = value } }
}

test('schedules weekday actions in the configured timezone and persists execution', async (t) => {
  const f = await fixture(t)
  const job = await f.manager.put('Dev', { frequency: 'weekdays', startTime: '08:00', stopTime: '18:00' }, 'operator')
  assert.equal(job.startNextAt, '2026-11-23T02:15:00.000Z')
  assert.equal(job.stopNextAt, '2026-11-23T12:15:00.000Z')
  f.setTime('2026-11-23T02:15:10Z'); await f.manager.tick(); await f.manager.tick()
  assert.deepEqual(f.calls, [['i-12345678', 'start']])
  const saved = (await f.make().list()).schedules[0]
  assert.equal(saved.lastRun.status, 'accepted')
  assert.equal(saved.startNextAt, '2026-11-24T02:15:00.000Z')
  f.setTime('2026-11-23T12:15:05Z'); await f.manager.tick()
  assert.deepEqual(f.calls[1], ['i-12345678', 'stop'])
})

test('missed occurrences are skipped and configuration changes prevent execution', async (t) => {
  const f = await fixture(t)
  await f.manager.put('Dev', { frequency: 'daily', startTime: '08:00', stopTime: '18:00' }, 'operator')
  f.setTime('2026-11-23T02:17:00Z'); await f.manager.tick()
  assert.equal((await f.manager.list()).schedules[0].lastRun.status, 'missed')
  f.setServer({ name: 'Dev', instanceId: 'i-87654321', ec2Control: true })
  f.setTime('2026-11-23T12:15:05Z'); await f.manager.tick()
  assert.equal((await f.manager.list()).schedules[0].lastRun.status, 'failed')
  assert.deepEqual(f.calls, [])
})

test('validates schedules, supports disabling an action, and removes schedules', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.manager.put('Dev', { frequency: 'daily', startTime: '25:00' }, 'operator'), /HH:MM/)
  await assert.rejects(f.manager.put('Dev', { frequency: 'daily' }, 'operator'), /at least one/)
  await assert.rejects(f.manager.put('Dev', { frequency: 'daily', startTime: '08:00', stopTime: '08:00' }, 'operator'), /must differ/)
  await f.manager.put('Dev', { frequency: 'weekdays', startTime: '08:00' }, 'operator')
  assert.equal((await f.manager.list()).schedules[0].stopNextAt, null)
  await f.manager.remove('Dev', 'operator')
  assert.deepEqual((await f.manager.list()).schedules, [])
})

test('does not overwrite invalid persisted schedule data', async (t) => {
  const f = await fixture(t)
  await writeFile(f.file, '{broken')
  await assert.rejects(f.manager.put('Dev', { frequency: 'daily', startTime: '08:00' }, 'operator'), /storage/)
  assert.equal(await readFile(f.file, 'utf8'), '{broken')
})


test('handles daylight-saving gaps and repeated times as real instants', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ec2-dst-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let current = new Date('2026-03-08T05:00:00Z')
  const manager = createEc2Scheduler({ filePath: () => path.join(dir, 's.json'), timeZone: () => 'America/New_York', now: () => current, getServer: async () => ({ name: 'Dev', instanceId: 'i-12345678', ec2Control: true }), execute: async () => ({ message: 'Accepted' }) })
  const spring = await manager.put('Dev', { frequency: 'daily', startTime: '02:30' }, 'operator')
  assert.equal(spring.startNextAt, '2026-03-09T06:30:00.000Z')
  current = new Date('2026-11-01T04:00:00Z')
  const autumn = await manager.put('Dev', { frequency: 'daily', startTime: '01:30' }, 'operator')
  assert.equal(autumn.startNextAt, '2026-11-01T05:30:00.000Z')
  current = new Date('2026-11-01T05:30:05Z'); await manager.tick()
  assert.equal((await manager.list()).schedules[0].startNextAt, '2026-11-01T06:30:00.000Z')
})
