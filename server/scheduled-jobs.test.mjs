import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { calculateNextRun, createScheduledJobManager, readScheduledJobRequest } from './scheduled-jobs.mjs'

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulseboard-jobs-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const clock = { value: new Date('2026-09-18T04:00:00.000Z') }
  const manager = createScheduledJobManager({
    filePath: path.join(directory, 'jobs.json'), now: () => new Date(clock.value),
    pythonCommand: () => process.execPath, timeoutMs: () => 5000,
  })
  return { manager, clock, filePath: path.join(directory, 'jobs.json') }
}

test('calculates one-time, hourly, daily, and weekday schedules', () => {
  assert.equal(calculateNextRun({ type: 'once', runAt: '2026-09-18T05:00:00.000Z' }, new Date('2026-09-18T04:00:00.000Z')), '2026-09-18T05:00:00.000Z')
  assert.equal(calculateNextRun({ type: 'once', runAt: '2026-09-18T03:00:00.000Z' }, new Date('2026-09-18T04:00:00.000Z')), null)
  const after = new Date(2026, 8, 18, 10, 20, 30)
  const hourly = new Date(calculateNextRun({ type: 'hourly', minute: 15 }, after))
  assert.deepEqual([hourly.getHours(), hourly.getMinutes(), hourly.getSeconds()], [11, 15, 0])
  const daily = new Date(calculateNextRun({ type: 'daily', time: '12:45' }, after))
  assert.deepEqual([daily.getDate(), daily.getHours(), daily.getMinutes()], [18, 12, 45])
  const fridayEvening = new Date(2026, 8, 18, 18, 0, 0)
  const weekday = new Date(calculateNextRun({ type: 'weekdays', time: '09:00' }, fridayEvening))
  assert.deepEqual([weekday.getDay(), weekday.getDate(), weekday.getHours()], [1, 21, 9])
})

test('calculates Kathmandu wall-clock schedules without applying the UTC offset twice', () => {
  const beforeRun = new Date('2026-09-18T10:00:00.000Z') // 15:45 in Kathmandu
  assert.equal(
    calculateNextRun({ type: 'weekdays', time: '17:30' }, beforeRun, 'Asia/Kathmandu'),
    '2026-09-18T11:45:00.000Z',
  )
  const afterRun = new Date('2026-09-18T12:00:00.000Z') // Friday evening in Kathmandu
  assert.equal(
    calculateNextRun({ type: 'weekdays', time: '17:30' }, afterRun, 'Asia/Kathmandu'),
    '2026-09-21T11:45:00.000Z',
  )
})

test('automatically recalculates recurring jobs saved before explicit timezone support', async (context) => {
  const { manager, filePath } = await fixture(context)
  await writeFile(filePath, JSON.stringify({ version: 1, jobs: [{
    id: 'legacy-job', name: 'Legacy', language: 'python', sourceMode: 'inline', scriptContent: 'pass',
    schedule: { type: 'weekdays', time: '17:30' }, status: 'scheduled', nextRunAt: '2026-09-18T17:30:00.000Z',
    createdAt: '2026-09-18T03:00:00.000Z', lastRunAt: null, lastStatus: null, lastOutput: '', lastError: null,
  }] }))
  const [job] = await manager.list()
  assert.equal(job.nextRunAt, '2026-09-18T11:45:00.000Z')
  assert.equal(job.scheduleTimeZone, 'Asia/Kathmandu')
  const stored = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(stored.version, 2)
  assert.equal(stored.jobs[0].scheduleTimeZone, 'Asia/Kathmandu')
})

test('persists jobs without exposing inline source and executes due scripts', async (context) => {
  const { manager, clock, filePath } = await fixture(context)
  const job = await manager.create({
    name: 'Inline check', language: 'python', sourceMode: 'inline', scriptContent: 'console.log("job-complete")',
    schedule: { type: 'once', runAt: '2026-09-18T04:01:00.000Z' },
  }, 'operator')
  assert.equal(job.scriptContent, undefined)
  assert.equal(job.scriptPreview, undefined)
  assert.equal((await manager.list())[0].status, 'scheduled')
  assert.match(await readFile(filePath, 'utf8'), /scriptContent/)
  clock.value = new Date('2026-09-18T04:01:00.000Z')
  await manager.tick()
  for (let attempt = 0; attempt < 50 && (await manager.list())[0].status === 'running'; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
  const completed = (await manager.list())[0]
  assert.equal(completed.status, 'completed')
  assert.equal(completed.lastStatus, 'success')
  assert.match(completed.lastOutput, /job-complete/)
  assert.equal(completed.nextRunAt, null)
})

test('validates script sources and schedule fields before writing', async (context) => {
  const { manager } = await fixture(context)
  const base = { name: 'Job', language: 'python', sourceMode: 'path', scriptPath: 'task.py' }
  for (const input of [
    { ...base, name: '', schedule: { type: 'daily', time: '09:00' } },
    { ...base, scriptPath: 'task.ps1', schedule: { type: 'daily', time: '09:00' } },
    { ...base, schedule: { type: 'hourly', minute: 60 } },
    { ...base, schedule: { type: 'daily', time: '25:00' } },
    { ...base, schedule: { type: 'once', runAt: '2020-01-01T00:00:00Z' } },
  ]) await assert.rejects(manager.create(input), { status: 400 })
  assert.deepEqual(await manager.list(), [])
})

test('request reader enforces JSON and a bounded request body', async () => {
  const request = (body, type = 'application/json') => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': type } })
  assert.deepEqual(await readScheduledJobRequest(request('{"name":"job"}')), { name: 'job' })
  await assert.rejects(readScheduledJobRequest(request('{bad')), { status: 400 })
  await assert.rejects(readScheduledJobRequest(request('{}', 'text/plain')), { status: 400 })
  await assert.rejects(readScheduledJobRequest(request('x'.repeat(310000))), { status: 413 })
})

test('manual runs work and completed jobs can be deleted', async (context) => {
  const { manager } = await fixture(context)
  const job = await manager.create({ name: 'Manual', language: 'python', sourceMode: 'inline', scriptContent: 'process.stdout.write("manual")', schedule: { type: 'daily', time: '23:59' } })
  await manager.runNow(job.id, 'operator')
  for (let attempt = 0; attempt < 50 && (await manager.list())[0].status === 'running'; attempt++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match((await manager.list())[0].lastOutput, /manual/)
  assert.deepEqual(await manager.remove(job.id, 'operator'), { id: job.id })
  assert.deepEqual(await manager.list(), [])
})

test('jobs can be loaded for editing and updated without losing run history', async (context) => {
  const { manager } = await fixture(context)
  const job = await manager.create({ name: 'Original', language: 'python', sourceMode: 'inline', scriptContent: 'print("old")', schedule: { type: 'daily', time: '09:00' } }, 'operator')
  const editable = await manager.get(job.id)
  assert.equal(editable.scriptContent, 'print("old")')
  const updated = await manager.update(job.id, { name: 'Updated', language: 'python', sourceMode: 'inline', scriptContent: 'print("new")', schedule: { type: 'weekdays', time: '17:30' } }, 'operator')
  assert.equal(updated.name, 'Updated')
  assert.deepEqual(updated.schedule, { type: 'weekdays', time: '17:30' })
  assert.equal(updated.scriptContent, undefined)
  assert.equal((await manager.get(job.id)).scriptContent, 'print("new")')
  await assert.rejects(manager.get('missing'), { status: 404 })
  await assert.rejects(manager.update('missing', { name: 'Missing', language: 'python', sourceMode: 'inline', scriptContent: 'pass', schedule: { type: 'daily', time: '09:00' } }), { status: 404 })
})
