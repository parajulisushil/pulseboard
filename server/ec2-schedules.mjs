import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { scheduledJobTimeZone } from './scheduled-jobs.mjs'

export class Ec2ScheduleError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function createEc2Scheduler({ filePath, timeZone, getServer, execute, audit = () => {}, now = () => new Date() }) {
  let operation = Promise.resolve(), timer, ticking = false
  const zone = () => scheduledJobTimeZone(timeZone())
  const exclusive = (fn) => { const result = operation.then(fn, fn); operation = result.catch(() => {}); return result }
  function next(schedule, action, date) {
    const time = schedule[`${action}Time`]
    if (!time) return null
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone(), hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    // Search real instants so daylight-saving gaps are skipped and repeated local times
    // are handled chronologically, without inventing a nonexistent wall time.
    let instant = Math.floor(date.getTime() / 60000) * 60000 + 60000
    for (let i = 0; i < 8 * 24 * 60; i++, instant += 60000) {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]))
      if (`${parts.hour}:${parts.minute}` === time && (schedule.frequency === 'daily' || !['Sat', 'Sun'].includes(parts.weekday))) return new Date(instant).toISOString()
    }
    throw new Ec2ScheduleError(503, 'Could not calculate the next EC2 schedule time')
  }
  async function load() {
    try {
      const data = JSON.parse(await readFile(filePath(), 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.schedules) || data.schedules.some((s) => !s || typeof s.serverName !== 'string' || !/^i-[0-9a-f]{8,17}$/i.test(s.instanceId) || !['daily', 'weekdays'].includes(s.frequency) || !['start', 'stop'].every((a) => s[`${a}Time`] === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(s[`${a}Time`]) && Number.isFinite(Date.parse(s[`${a}NextAt`]))))) throw new Error('Invalid schedule file')
      return data
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, schedules: [] }
      throw new Ec2ScheduleError(503, 'EC2 schedule storage is unavailable or invalid')
    }
  }
  async function save(data) {
    const target = filePath()
    try {
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
      await rename(temporary, target)
    } catch { throw new Ec2ScheduleError(503, 'EC2 schedules could not be saved') }
  }
  const list = () => exclusive(async () => ({ schedules: (await load()).schedules, timeZone: zone() }))
  const put = (serverName, input, actor) => exclusive(async () => {
    if (!input || !['daily', 'weekdays'].includes(input.frequency)) throw new Ec2ScheduleError(400, 'Choose daily or weekdays')
    const times = {}
    for (const action of ['start', 'stop']) {
      const value = input[`${action}Time`] || null
      if (value !== null && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Ec2ScheduleError(400, 'Times must use HH:MM')
      times[`${action}Time`] = value
    }
    if (!times.startTime && !times.stopTime) throw new Ec2ScheduleError(400, 'Choose at least one action time')
    if (times.startTime && times.startTime === times.stopTime) throw new Ec2ScheduleError(400, 'Start and stop times must differ')
    const server = await getServer(serverName)
    if (!server || !server.ec2Control || !/^i-[0-9a-f]{8,17}$/i.test(server.instanceId || '')) throw new Ec2ScheduleError(409, 'EC2 control is not configured for this machine')
    const data = await load()
    if (data.schedules.some((s) => s.instanceId.toLowerCase() === server.instanceId.toLowerCase() && s.serverName !== server.name)) throw new Ec2ScheduleError(409, 'This instance already has a schedule under another machine name')
    const schedule = { serverName: server.name, instanceId: server.instanceId, frequency: input.frequency, ...times, timeZone: zone(), updatedAt: now().toISOString(), actor, lastRun: null }
    for (const action of ['start', 'stop']) schedule[`${action}NextAt`] = next(schedule, action, now())
    data.schedules = [...data.schedules.filter((s) => s.serverName !== server.name), schedule]
    await save(data); audit('ec2_schedule_saved', { server: server.name, instanceId: server.instanceId, actor, frequency: schedule.frequency, ...times })
    return schedule
  })
  const remove = (serverName, actor) => exclusive(async () => {
    const data = await load(), index = data.schedules.findIndex((s) => s.serverName === serverName)
    if (index < 0) throw new Ec2ScheduleError(404, 'EC2 schedule not found')
    const [removed] = data.schedules.splice(index, 1)
    await save(data); audit('ec2_schedule_removed', { server: serverName, instanceId: removed.instanceId, actor })
    return { removed: true }
  })
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const due = await exclusive(async () => {
        const data = await load(), current = now(), tasks = []; let changed = false
        for (const s of data.schedules) {
          if (s.timeZone !== zone()) {
            s.timeZone = zone()
            for (const action of ['start', 'stop']) s[`${action}NextAt`] = next(s, action, current)
            changed = true; continue
          }
          for (const action of ['start', 'stop']) {
            const at = s[`${action}NextAt`]
            if (!at || Date.parse(at) > current.getTime()) continue
            s[`${action}NextAt`] = next(s, action, current)
            const token = randomUUID()
            const missed = current.getTime() - Date.parse(at) > 60000
            s.lastRun = { token, action, scheduledAt: at, status: missed ? 'missed' : 'unconfirmed', message: missed ? 'Skipped while the API was unavailable or delayed.' : 'Request reserved; outcome may need review.' }
            if (!missed) tasks.push({ serverName: s.serverName, instanceId: s.instanceId, action, token })
            changed = true
          }
        }
        if (changed) await save(data)
        return tasks
      })
      for (const task of due) {
        await exclusive(async () => {
          const data = await load(), s = data.schedules.find((item) => item.serverName === task.serverName && item.lastRun?.token === task.token)
          if (!s) return
          if (now().getTime() - Date.parse(s.lastRun.scheduledAt) > 60000) {
            s.lastRun = { ...s.lastRun, status: 'missed', message: 'Skipped because execution was delayed.', completedAt: now().toISOString() }
            await save(data); return
          }
          let status = 'accepted', message
          try {
            const server = await getServer(task.serverName)
            if (!server || server.ec2Control !== true || server.instanceId?.toLowerCase() !== task.instanceId.toLowerCase()) throw new Error('Machine configuration changed; action skipped.')
            try { const result = await execute(server, task.action); message = result.message }
            catch (error) { status = 'unconfirmed'; message = `${error instanceof Error ? error.message : 'Request failed'} Check the instance before retrying.` }
          } catch (error) { status = 'failed'; message = error instanceof Error ? error.message : 'Action failed' }
          s.lastRun = { ...s.lastRun, status, message, completedAt: now().toISOString() }
          await save(data)
          audit('ec2_schedule_action', { server: task.serverName, instanceId: task.instanceId, action: task.action, status, message })
        })
      }
    } catch (error) { audit('ec2_schedule_failed', { error: error instanceof Error ? error.message : String(error) }) }
    finally { ticking = false }
  }
  return { list, put, remove, tick, start() { if (!timer) { void tick(); timer = setInterval(() => void tick(), 10000); timer.unref() } }, stop() { clearInterval(timer); timer = undefined }, timeZone: zone }
}
