import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_REQUEST_BYTES = 300 * 1024
const MAX_SCRIPT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024
const ACTIVE_STATUSES = new Set(['scheduled', 'running'])
const DEFAULT_TIME_ZONE = 'Asia/Kathmandu'
const dateTimeFormatters = new Map()

export class ScheduledJobError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function formatterFor(timeZone) {
  if (!dateTimeFormatters.has(timeZone)) {
    dateTimeFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }))
  }
  return dateTimeFormatters.get(timeZone)
}

function localParts(value, timeZone) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }
}

function shiftLocal(parts, milliseconds) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + milliseconds)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() }
}

function localInstant(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  let instant = target
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = localParts(new Date(instant), timeZone)
    const difference = target - Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second)
    instant += difference
    if (!difference) break
  }
  return new Date(instant)
}

export function scheduledJobTimeZone(value = process.env.SCHEDULED_JOB_TIME_ZONE || process.env.TZ || DEFAULT_TIME_ZONE) {
  formatterFor(value).format(new Date())
  return value
}

export function calculateNextRun(schedule, after = new Date(), timeZone = scheduledJobTimeZone()) {
  if (schedule.type === 'once') {
    const value = new Date(schedule.runAt)
    return Number.isNaN(value.getTime()) || value <= after ? null : value.toISOString()
  }
  const current = localParts(after, timeZone)
  if (schedule.type === 'hourly') {
    let desired = { ...current, minute: schedule.minute, second: 0 }
    let next = localInstant(desired, timeZone)
    if (next <= after) { desired = shiftLocal(desired, 60 * 60 * 1000); next = localInstant(desired, timeZone) }
    return next.toISOString()
  }
  const [hour, minute] = schedule.time.split(':').map(Number)
  let desired = { ...current, hour, minute, second: 0 }
  let next = localInstant(desired, timeZone)
  if (next <= after) { desired = shiftLocal(desired, 24 * 60 * 60 * 1000); next = localInstant(desired, timeZone) }
  if (schedule.type === 'weekdays') {
    while ([0, 6].includes(new Date(Date.UTC(desired.year, desired.month - 1, desired.day)).getUTCDay())) {
      desired = shiftLocal(desired, 24 * 60 * 60 * 1000)
    }
    next = localInstant(desired, timeZone)
  }
  return next.toISOString()
}

function validateRequest(input, now) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ScheduledJobError(400, 'Request body must be a JSON object')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 100) throw new ScheduledJobError(400, 'Name is required and must be 100 characters or fewer')
  if (!['python', 'powershell'].includes(input.language)) throw new ScheduledJobError(400, 'Language must be python or powershell')
  if (!['path', 'inline'].includes(input.sourceMode)) throw new ScheduledJobError(400, 'Script source must be path or inline')
  let scriptPath
  let scriptContent
  if (input.sourceMode === 'path') {
    scriptPath = typeof input.scriptPath === 'string' ? input.scriptPath.trim() : ''
    if (!scriptPath || scriptPath.length > 2048 || scriptPath.includes('\0')) throw new ScheduledJobError(400, 'A valid script path is required')
    const expected = input.language === 'python' ? '.py' : '.ps1'
    if (path.extname(scriptPath).toLowerCase() !== expected) throw new ScheduledJobError(400, `The script path must end in ${expected}`)
  } else {
    scriptContent = typeof input.scriptContent === 'string' ? input.scriptContent : ''
    if (!scriptContent.trim()) throw new ScheduledJobError(400, 'Script content is required')
    if (Buffer.byteLength(scriptContent) > MAX_SCRIPT_BYTES) throw new ScheduledJobError(413, 'Script content is too large')
  }
  const schedule = input.schedule
  if (!schedule || Array.isArray(schedule) || typeof schedule !== 'object' || !['once', 'hourly', 'daily', 'weekdays'].includes(schedule.type)) {
    throw new ScheduledJobError(400, 'Schedule type must be once, hourly, daily, or weekdays')
  }
  let cleanSchedule
  if (schedule.type === 'once') {
    const runAt = new Date(schedule.runAt)
    if (Number.isNaN(runAt.getTime()) || runAt <= now) throw new ScheduledJobError(400, 'The one-time run date must be in the future')
    cleanSchedule = { type: 'once', runAt: runAt.toISOString() }
  } else if (schedule.type === 'hourly') {
    if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) throw new ScheduledJobError(400, 'Hourly minute must be between 0 and 59')
    cleanSchedule = { type: 'hourly', minute: schedule.minute }
  } else {
    if (typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new ScheduledJobError(400, 'Time must use HH:MM in 24-hour format')
    cleanSchedule = { type: schedule.type, time: schedule.time }
  }
  return { name, language: input.language, sourceMode: input.sourceMode, ...(scriptPath ? { scriptPath } : { scriptContent }), schedule: cleanSchedule }
}

export async function readScheduledJobRequest(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ScheduledJobError(400, 'Content-Type must be application/json')
  const chunks = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new ScheduledJobError(413, 'Request body is too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ScheduledJobError(400, 'Request body must contain valid JSON') }
}

function publicJob(job) {
  const visible = { ...job }
  delete visible.scriptContent
  return visible
}

function editableJob(job) { return { ...job } }

export function createScheduledJobManager(options) {
  const now = options.now || (() => new Date())
  const filePath = () => typeof options.filePath === 'function' ? options.filePath() : options.filePath
  const timeZone = () => scheduledJobTimeZone(options.timeZone?.() || process.env.SCHEDULED_JOB_TIME_ZONE || process.env.TZ || DEFAULT_TIME_ZONE)
  const running = new Map()
  const executing = new Set()
  let timer
  let operation = Promise.resolve()

  const exclusive = (task) => {
    const result = operation.then(task, task)
    operation = result.catch(() => {})
    return result
  }

  async function load() {
    try {
      const data = JSON.parse(await readFile(filePath(), 'utf8'))
      if (!data || !Array.isArray(data.jobs)) throw new Error('Invalid scheduled jobs file')
      return data
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, jobs: [] }
      throw new ScheduledJobError(503, 'Scheduled job storage is unavailable')
    }
  }

  async function save(data) {
    const target = filePath()
    try {
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    } catch { throw new ScheduledJobError(503, 'Scheduled job storage could not be updated') }
  }

  function applyTimeZone(data, current = now()) {
    const configured = timeZone()
    let changed = data.version !== 2
    data.version = 2
    for (const job of data.jobs) {
      if (job.scheduleTimeZone === configured) continue
      job.scheduleTimeZone = configured
      if (job.status === 'scheduled' && job.schedule.type !== 'once') job.nextRunAt = calculateNextRun(job.schedule, current, configured)
      changed = true
    }
    return changed
  }

  async function validateScriptPath(job) {
    if (job.sourceMode !== 'path') return
    try {
      if (!(await stat(path.resolve(job.scriptPath))).isFile()) throw new Error('Not a file')
    } catch { throw new ScheduledJobError(400, 'The script path is not a readable file on the API server') }
  }

  async function execute(job) {
    let target = job.scriptPath
    let temporary
    if (job.sourceMode === 'inline') {
      temporary = path.join(os.tmpdir(), `pulseboard-job-${job.id}${job.language === 'python' ? '.py' : '.ps1'}`)
      await writeFile(temporary, job.scriptContent, { encoding: 'utf8', mode: 0o600 })
      target = temporary
    } else {
      target = path.resolve(target)
    }
    const command = job.language === 'python'
      ? (options.pythonCommand?.() || process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python.exe' : 'python3'))
      : (options.powershellCommand?.() || process.env.POWERSHELL_BIN || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh'))
    const args = job.language === 'python' ? [target] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', target]
    const timeoutMs = options.timeoutMs?.() || 15 * 60 * 1000
    let output = ''
    try {
      const result = await new Promise((resolve) => {
        const child = spawn(command, args, { cwd: job.sourceMode === 'path' ? path.dirname(path.resolve(target)) : os.tmpdir(), windowsHide: true, shell: false, env: process.env })
        running.set(job.id, child)
        const append = (chunk) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES) }
        child.stdout.on('data', append); child.stderr.on('data', append)
        let timedOut = false
        const timeout = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
        child.once('error', (error) => { clearTimeout(timeout); resolve({ ok: false, reason: error.message }) })
        child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ ok: code === 0 && !timedOut, reason: timedOut ? `Timed out after ${Math.round(timeoutMs / 60000)} minutes` : code === 0 ? undefined : `Exited with code ${code ?? signal}` }) })
      })
      return { ...result, output }
    } finally {
      running.delete(job.id)
      if (temporary) await unlink(temporary).catch(() => {})
    }
  }

  async function finish(id, result) {
    await exclusive(async () => {
      const data = await load(); const job = data.jobs.find((item) => item.id === id)
      if (!job) return
      const completedAt = now().toISOString()
      job.lastRunAt = completedAt; job.lastStatus = result.ok ? 'success' : 'failed'; job.lastOutput = result.output || ''; job.lastError = result.reason || null
      job.status = job.schedule.type === 'once' ? 'completed' : 'scheduled'
      job.nextRunAt = job.schedule.type === 'once' ? null : calculateNextRun(job.schedule, now(), job.scheduleTimeZone || timeZone())
      await save(data)
      options.audit?.('scheduled_job_completed', { jobId: job.id, name: job.name, status: job.lastStatus, reason: result.reason })
    })
  }

  async function dispatch(job) {
    try {
      try { await finish(job.id, await execute(job)) } catch (error) {
        options.audit?.('scheduled_job_execution_error', { jobId: job.id, error: error instanceof Error ? error.message : String(error) })
        await finish(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error), output: '' }).catch(() => {})
      }
    } finally { executing.delete(job.id) }
  }

  async function tick() {
    const due = await exclusive(async () => {
      const data = await load(); const current = now(); const selected = []; const timeZoneChanged = applyTimeZone(data, current)
      for (const job of data.jobs) {
        if (job.status === 'running' && !executing.has(job.id)) {
          job.status = job.schedule.type === 'once' ? 'completed' : 'scheduled'; job.lastStatus = 'failed'; job.lastError = 'Execution was interrupted by an API restart'; job.lastRunAt = current.toISOString()
          job.nextRunAt = job.schedule.type === 'once' ? null : calculateNextRun(job.schedule, current, job.scheduleTimeZone || timeZone())
        }
        if (job.status === 'scheduled' && job.nextRunAt && new Date(job.nextRunAt) <= current && !running.has(job.id)) {
          job.status = 'running'; job.lastError = null; executing.add(job.id); selected.push({ ...job })
        }
      }
      if (timeZoneChanged || selected.length || data.jobs.some((job) => job.lastError === 'Execution was interrupted by an API restart' && job.lastRunAt === current.toISOString())) await save(data)
      return selected
    })
    for (const job of due) { options.audit?.('scheduled_job_started', { jobId: job.id, name: job.name }); void dispatch(job) }
  }

  return {
    async list() { return exclusive(async () => { const data = await load(); if (applyTimeZone(data)) await save(data); return data.jobs.map(publicJob).sort((a, b) => (a.nextRunAt || a.createdAt).localeCompare(b.nextRunAt || b.createdAt)) }) },
    async get(id) {
      return exclusive(async () => {
        const job = (await load()).jobs.find((item) => item.id === id)
        if (!job) throw new ScheduledJobError(404, 'Scheduled job not found')
        return editableJob(job)
      })
    },
    async create(input, actor = 'unknown') {
      return exclusive(async () => {
        const current = now(); const clean = validateRequest(input, current); const data = await load()
        await validateScriptPath(clean)
        const configuredTimeZone = timeZone()
        const job = { id: randomUUID(), ...clean, scheduleTimeZone: configuredTimeZone, status: 'scheduled', nextRunAt: calculateNextRun(clean.schedule, current, configuredTimeZone), createdAt: current.toISOString(), createdBy: actor, lastRunAt: null, lastStatus: null, lastOutput: '', lastError: null }
        data.jobs.push(job); await save(data); options.audit?.('scheduled_job_created', { jobId: job.id, name: job.name, actor, schedule: job.schedule, language: job.language, sourceMode: job.sourceMode })
        return publicJob(job)
      })
    },
    async update(id, input, actor = 'unknown') {
      return exclusive(async () => {
        const current = now(); const clean = validateRequest(input, current); await validateScriptPath(clean)
        const data = await load(); const job = data.jobs.find((item) => item.id === id)
        if (!job) throw new ScheduledJobError(404, 'Scheduled job not found')
        if (job.status === 'running' || executing.has(id)) throw new ScheduledJobError(409, 'A running job cannot be edited')
        for (const key of ['name', 'language', 'sourceMode', 'scriptPath', 'scriptContent', 'schedule']) delete job[key]
        const configuredTimeZone = timeZone()
        Object.assign(job, clean, { scheduleTimeZone: configuredTimeZone, status: 'scheduled', nextRunAt: calculateNextRun(clean.schedule, current, configuredTimeZone), updatedAt: current.toISOString(), updatedBy: actor })
        await save(data); options.audit?.('scheduled_job_updated', { jobId: id, name: job.name, actor, schedule: job.schedule, language: job.language, sourceMode: job.sourceMode })
        return publicJob(job)
      })
    },
    async remove(id, actor = 'unknown') {
      return exclusive(async () => {
        const data = await load(); const index = data.jobs.findIndex((job) => job.id === id)
        if (index < 0) throw new ScheduledJobError(404, 'Scheduled job not found')
        if (data.jobs[index].status === 'running' || executing.has(id)) throw new ScheduledJobError(409, 'A running job cannot be deleted')
        const [job] = data.jobs.splice(index, 1); await save(data); options.audit?.('scheduled_job_deleted', { jobId: id, name: job.name, actor }); return { id }
      })
    },
    async runNow(id, actor = 'unknown') {
      const job = await exclusive(async () => {
        const data = await load(); const item = data.jobs.find((candidate) => candidate.id === id)
        if (!item) throw new ScheduledJobError(404, 'Scheduled job not found')
        if (ACTIVE_STATUSES.has(item.status) && item.status === 'running') throw new ScheduledJobError(409, 'The job is already running')
        item.status = 'running'; item.lastError = null; executing.add(item.id)
        try { await save(data) } catch (error) { executing.delete(item.id); throw error }
        return { ...item }
      })
      options.audit?.('scheduled_job_manual_run', { jobId: id, name: job.name, actor }); void dispatch(job); return publicJob(job)
    },
    async tick() { return tick() },
    timeZone,
    start() { if (!timer) { void tick(); timer = setInterval(() => void tick().catch((error) => options.audit?.('scheduled_job_tick_failed', { error: error.message })), 10000); timer.unref?.() } },
    stop() { if (timer) clearInterval(timer); timer = undefined; for (const child of running.values()) child.kill() },
  }
}
