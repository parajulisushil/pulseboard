import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PENDING = new Set(['waiting_time', 'waiting_build', 'waiting_deployment'])
const ACTIVE = new Set([...PENDING, 'submitting', 'queued', 'running', 'verifying', 'unconfirmed'])
const STATES = new Set([...ACTIVE, 'success', 'failed', 'verification_failed', 'cancelled'])

export class DeploymentScheduleError extends Error {
  constructor(message, status = 503) { super(message); this.name = 'DeploymentScheduleError'; this.status = status }
}

export function createDeploymentScheduler({ filePath, getServer, getBuild, isDeploymentBusy, queueDeployment, teamCityUrl, verifyDeployment, audit = () => {}, now = () => Date.now() }) {
  let jobs = []
  let loading
  let writes = Promise.resolve()
  let timer
  const locks = new Set()
  const timestamp = () => new Date(now()).toISOString()
  const key = (name) => name.toLowerCase()
  const location = () => typeof filePath === 'function' ? filePath() : filePath
  const canRecheck = (job) => !!verifyDeployment && ['success', 'verification_failed'].includes(job.status)
    && /^[1-9]\d{0,15}$/.test(String(job.buildId || ''))
    && jobs.findLast((item) => key(item.serverName) === key(job.serverName))?.id === job.id
    && !jobs.some((item) => key(item.serverName) === key(job.serverName) && ACTIVE.has(item.status))
  const publicJob = (job) => ({ ...job, active: ACTIVE.has(job.status), canCancel: PENDING.has(job.status) || job.status === 'unconfirmed', canRecheck: canRecheck(job) })

  async function persist(next) {
    try {
      await mkdir(path.dirname(location()), { recursive: true })
      const temporary = `${location()}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 1, schedules: next }, null, 2), { mode: 0o600 })
      await rename(temporary, location())
    } catch { throw new DeploymentScheduleError('Deployment schedules could not be saved. Check write access to the deployment schedule data directory.') }
  }

  async function load() {
    if (!loading) loading = (async () => {
      let data
      try { data = JSON.parse(await readFile(location(), 'utf8')) }
      catch (error) {
        if (error.code === 'ENOENT') return
        throw new DeploymentScheduleError('Deployment schedules could not be read. Check the schedule file and restart the API; existing schedules have not been discarded.')
      }
      if (!data || data.version !== 1 || !Array.isArray(data.schedules) || data.schedules.some((job) =>
        !job || typeof job.id !== 'string' || typeof job.serverName !== 'string' || typeof job.buildTypeId !== 'string' || typeof job.teamCityUrl !== 'string'
        || !STATES.has(job.status) || !['delay', 'after_build', 'immediate'].includes(job.mode)
        || (job.mode === 'delay' && (!job.notBefore || !Number.isFinite(Date.parse(job.notBefore))))
        || (job.mode === 'after_build' && !/^[1-9]\d{0,15}$/.test(String(job.afterBuildId || '')))
        || (['queued', 'running', 'verifying'].includes(job.status) && !/^[1-9]\d{0,15}$/.test(String(job.buildId || ''))))) {
        throw new DeploymentScheduleError('The deployment schedule file is invalid. Restore the file before restarting the API.')
      }
      jobs = data.schedules.map((job) => {
        if (job.status === 'submitting') return {
          ...job, status: 'unconfirmed', reason: 'The API restarted during submission. Check TeamCity before clearing this schedule; the deployment may already have been queued.', updatedAt: timestamp(),
        }
        if (!verifyDeployment && ['verifying', 'verification_failed'].includes(job.status)) return {
          ...job, status: 'success', reason: 'Deployment completed.', updatedAt: timestamp(),
        }
        return job
      })
      if (data.schedules.some((job) => job.status === 'submitting' || (!verifyDeployment && ['verifying', 'verification_failed'].includes(job.status)))) await persist(jobs)
    })()
    await loading
  }

  async function mutate(change) {
    await load()
    const operation = writes.then(async () => {
      const next = change(structuredClone(jobs))
      // Preserve history order when completed jobs become active again for fresh checks.
      const completed = new Set(next.filter((job) => !ACTIVE.has(job.status)).slice(-100))
      const retained = next.filter((job) => ACTIVE.has(job.status) || completed.has(job))
      await persist(retained)
      jobs = retained
    })
    writes = operation.catch(() => {})
    await operation
  }

  async function update(id, changes) {
    await mutate((current) => current.map((job) => job.id === id ? { ...job, ...changes, updatedAt: timestamp() } : job))
    return jobs.find((job) => job.id === id)
  }

  async function withServerLock(serverName, operation) {
    const serverKey = key(serverName)
    if (locks.has(serverKey)) throw new DeploymentScheduleError('A deployment action for this machine is already being processed. Retry shortly.', 409)
    locks.add(serverKey)
    try { await load(); return await operation() }
    finally { locks.delete(serverKey) }
  }

  async function guardImmediate(serverName, operation) {
    return withServerLock(serverName, async () => {
      if (jobs.some((job) => key(job.serverName) === key(serverName) && ACTIVE.has(job.status))) {
        throw new DeploymentScheduleError('This machine already has a deployment schedule or deployment in progress. Cancel or resolve that schedule first.', 409)
      }
      return operation()
    })
  }

  async function list(serverName) {
    await load()
    return jobs.filter((job) => !serverName || key(job.serverName) === key(serverName)).slice().reverse().map(publicJob)
  }

  // Called inside guardImmediate: persist intent before submitting, just like scheduled jobs.
  async function beginImmediate(server, actor) {
    if (!locks.has(key(server.name))) throw new DeploymentScheduleError('An immediate deployment must hold the machine lock.')
    if (!teamCityUrl()) throw new DeploymentScheduleError('TeamCity is not configured.')
    const job = {
      id: randomUUID(), serverName: server.name, buildTypeId: server.deploymentBuildTypeId, teamCityUrl: teamCityUrl(),
      mode: 'immediate', status: 'submitting', notBefore: null, afterBuildId: null,
      createdAt: timestamp(), updatedAt: timestamp(), actor, reason: 'Submitting the deployment to TeamCity.',
    }
    await mutate((current) => [...current, job])
    return publicJob(job)
  }

  async function finishImmediate(id, result) {
    try {
      return await update(id, result?.status === 'queued' && result.buildId
        ? { status: 'queued', buildId: result.buildId, webUrl: result.webUrl, reason: 'Deployment queued in TeamCity.' }
        : { status: 'unconfirmed', reason: 'TeamCity did not confirm submission. Check its queue before clearing this deployment. Automatic retries are disabled.' })
    } catch (error) {
      jobs = jobs.map((job) => job.id === id ? { ...job, status: 'unconfirmed', reason: 'Deployment tracking could not be saved. Check TeamCity before clearing this deployment.' } : job)
      throw error
    }
  }

  async function create(serverName, options, actor) {
    if (!options || !['delay', 'after_build'].includes(options.mode)) throw new DeploymentScheduleError('Choose a delay or a specific TeamCity build.', 400)
    if (options.mode === 'delay' && (!Number.isInteger(options.delayMinutes) || options.delayMinutes < 1 || options.delayMinutes > 1440)) {
      throw new DeploymentScheduleError('Delay must be a whole number of minutes from 1 to 1440.', 400)
    }
    if (options.mode === 'after_build' && !/^[1-9]\d{0,15}$/.test(String(options.afterBuildId || ''))) throw new DeploymentScheduleError('Enter a valid numeric TeamCity build ID.', 400)
    return withServerLock(serverName, async () => {
      if (jobs.some((job) => key(job.serverName) === key(serverName) && ACTIVE.has(job.status))) throw new DeploymentScheduleError('This machine already has an active deployment schedule.', 409)
      const server = await getServer(serverName)
      if (!server?.deploymentBuildTypeId) throw new DeploymentScheduleError('A deployment pipeline is not configured for this machine.', 409)
      const origin = teamCityUrl()
      if (!origin) throw new DeploymentScheduleError('TeamCity is not configured.')
      let prerequisite
      if (options.mode === 'after_build') {
        prerequisite = await getBuild(String(options.afterBuildId))
        if (['failure', 'cancelled'].includes(prerequisite.status)) throw new DeploymentScheduleError('The selected TeamCity build failed or was cancelled. Choose a build that can complete successfully.', 409)
        if (!['queued', 'running', 'success'].includes(prerequisite.status) || String(prerequisite.buildId) !== String(options.afterBuildId)) throw new DeploymentScheduleError('The selected TeamCity build could not be verified. Check its build ID and try again.')
      }
      const job = {
        id: randomUUID(), serverName: server.name, buildTypeId: server.deploymentBuildTypeId, teamCityUrl: origin,
        mode: options.mode, status: options.mode === 'delay' ? 'waiting_time' : 'waiting_build',
        notBefore: options.mode === 'delay' ? new Date(now() + options.delayMinutes * 60000).toISOString() : null,
        afterBuildId: prerequisite ? String(options.afterBuildId) : null,
        prerequisite: prerequisite ? { buildId: prerequisite.buildId, buildNumber: prerequisite.buildNumber, webUrl: prerequisite.webUrl, status: prerequisite.status } : null,
        createdAt: timestamp(), updatedAt: timestamp(), actor,
        reason: options.mode === 'delay' ? 'Waiting for the scheduled time.' : 'Waiting for the selected build to complete successfully.',
      }
      await mutate((current) => [...current, job])
      audit('deployment_scheduled', { scheduleId: job.id, server: job.serverName, mode: job.mode, afterBuildId: job.afterBuildId, notBefore: job.notBefore, actor })
      return publicJob(job)
    })
  }

  async function cancel(id, actor) {
    await load()
    const existing = jobs.find((job) => job.id === id)
    if (!existing) throw new DeploymentScheduleError('Deployment schedule not found.', 404)
    return withServerLock(existing.serverName, async () => {
      const job = jobs.find((item) => item.id === id)
      if (!PENDING.has(job.status) && job.status !== 'unconfirmed') throw new DeploymentScheduleError('This schedule has already been submitted or completed. Manage queued/running builds in TeamCity.', 409)
      const updated = await update(id, { status: 'cancelled', reason: job.status === 'unconfirmed' ? 'Cleared after operator review. Any build already submitted must be managed in TeamCity.' : 'Cancelled before submission to TeamCity.' })
      audit('deployment_schedule_cancelled', { scheduleId: id, server: job.serverName, actor })
      return publicJob(updated)
    })
  }

  async function recheck(id, actor) {
    await load()
    const existing = jobs.find((job) => job.id === id)
    if (!existing) throw new DeploymentScheduleError('Deployment schedule not found.', 404)
    return withServerLock(existing.serverName, async () => {
      const job = jobs.find((item) => item.id === id)
      if (!job || !canRecheck(job)) throw new DeploymentScheduleError('Checks can only be refreshed for the latest completed deployment when no deployment or checks are active for this machine.', 409)
      const server = await getServer(job.serverName)
      if (!server || server.deploymentBuildTypeId !== job.buildTypeId || job.teamCityUrl !== teamCityUrl()) {
        throw new DeploymentScheduleError('The machine or TeamCity configuration has changed. Checks could not be refreshed for this deployment.', 409)
      }
      const updated = await update(id, {
        status: 'verifying', verificationAttempts: 0, nextVerificationAt: null,
        reason: 'Refreshing the login page and application service checks. Previous results remain visible until the new checks finish.',
      })
      audit('deployment_verification_requested', { scheduleId: id, server: job.serverName, buildId: job.buildId, actor })
      return publicJob(updated)
    })
  }

  async function advance(id) {
    const job = jobs.find((item) => item.id === id)
    if (!job || !ACTIVE.has(job.status) || ['unconfirmed', 'submitting'].includes(job.status)) return
    if (job.teamCityUrl !== teamCityUrl()) {
      if (PENDING.has(job.status)) await update(id, { status: 'failed', reason: 'TeamCity configuration changed. Create a new schedule for the current server.' })
      else if (job.status === 'verifying') await update(id, { status: 'verification_failed', reason: 'Deployment checks stopped because the TeamCity configuration changed.' })
      return
    }
    if (job.status === 'verifying') {
      if (job.nextVerificationAt && now() < Date.parse(job.nextVerificationAt)) return
      const server = await getServer(job.serverName)
      if (!server || server.deploymentBuildTypeId !== job.buildTypeId || !verifyDeployment) {
        await update(id, { status: 'verification_failed', reason: 'Deployment completed, but its machine configuration or verification capability is unavailable.' }); return
      }
      let verification
      try { verification = await verifyDeployment(server) }
      catch { verification = { status: 'needs_attention', checkedAt: timestamp(), login: { status: 'unknown', reason: 'Login check could not be completed.' }, services: [], allServicesRunning: false, servicesReason: 'Service checks could not be completed.' } }
      const attempts = (job.verificationAttempts || 0) + 1
      const passed = verification.status === 'passed' && verification.login?.status === 'passed' && verification.allServicesRunning === true
      const status = passed ? 'success' : attempts >= 3 ? 'verification_failed' : 'verifying'
      await update(id, {
        status, verification, verificationAttempts: attempts,
        nextVerificationAt: status === 'verifying' ? new Date(now() + 30000).toISOString() : null,
        reason: passed ? 'Deployment verified: login page is available and all configured application services are running.'
          : status === 'verifying' ? `Deployment completed. Login page or services are not ready; retrying in 30 seconds (check ${attempts} of 3).`
          : 'Deployment completed, but login page or service checks need attention after 3 attempts.',
      })
      audit('deployment_verification_checked', { scheduleId: id, server: job.serverName, buildId: job.buildId, status, attempts })
      return
    }
    if (['queued', 'running'].includes(job.status)) {
      const progress = await getBuild(String(job.buildId))
      if (progress.status === 'unknown' || String(progress.buildId) !== String(job.buildId)) { await update(id, { reason: 'Deployment status is temporarily unavailable. Check TeamCity; no new deployment will be submitted.' }); return }
      if (progress.status === 'success' && verifyDeployment) {
        await update(id, { status: 'verifying', verificationAttempts: 0, reason: 'Deployment completed. Checking the login page and application services.', webUrl: progress.webUrl || job.webUrl })
        return
      }
      const status = progress.status === 'success' ? 'success' : ['failure', 'cancelled'].includes(progress.status) ? 'failed' : progress.status
      if (['success', 'failed', 'queued', 'running'].includes(status)) await update(id, { status, reason: progress.reason || `Deployment ${status}.`, webUrl: progress.webUrl || job.webUrl })
      return
    }
    if (job.notBefore && now() < Date.parse(job.notBefore)) return
    if (job.afterBuildId) {
      const prerequisite = await getBuild(job.afterBuildId)
      if (['failure', 'cancelled'].includes(prerequisite.status)) {
        await update(id, { status: 'failed', reason: `Build ${job.afterBuildId} failed or was cancelled. Deployment was not queued.` }); return
      }
      if (prerequisite.status !== 'success' || String(prerequisite.buildId) !== job.afterBuildId) {
        await update(id, { status: 'waiting_build', reason: prerequisite.status === 'unknown' ? `Cannot verify build ${job.afterBuildId}. Waiting; deployment will not start without confirmed success.` : `Waiting for build ${job.afterBuildId} (${prerequisite.status}).` }); return
      }
    }
    const server = await getServer(job.serverName)
    if (!server || server.deploymentBuildTypeId !== job.buildTypeId) { await update(id, { status: 'failed', reason: 'The machine or its deployment pipeline changed. Create a new schedule.' }); return }
    if (await isDeploymentBusy(server)) { await update(id, { status: 'waiting_deployment', reason: 'Another deployment for this machine is active. Waiting for it to finish.' }); return }
    // Persist intent before the external write. A crash or lost response must never auto-submit twice.
    await update(id, { status: 'submitting', reason: 'Submitting the deployment to TeamCity.' })
    let result
    try { result = await queueDeployment(server, job) }
    catch { result = { status: 'unknown' } }
    if (result.status !== 'queued' || !result.buildId) {
      await update(id, { status: 'unconfirmed', reason: 'TeamCity did not confirm submission. Check its queue before clearing this schedule; it may already be queued. Automatic retries are disabled.' })
      audit('deployment_schedule_unconfirmed', { scheduleId: id, server: job.serverName })
      return
    }
    await update(id, { status: 'queued', buildId: result.buildId, webUrl: result.webUrl, reason: 'Deployment queued in TeamCity.' })
    audit('scheduled_deployment_queued', { scheduleId: id, server: job.serverName, buildId: result.buildId })
  }

  async function tick() {
      await load()
      await Promise.all([...jobs].map(async (job) => {
        if (!ACTIVE.has(job.status) || locks.has(key(job.serverName))) return
        try { await withServerLock(job.serverName, () => advance(job.id)) }
        catch (error) {
          // A saved submitting state is deliberately left in place on storage failure.
          // Do not execute it again, even before the next restart.
          if (jobs.find((item) => item.id === job.id)?.status === 'submitting') {
            jobs = jobs.map((item) => item.id === job.id ? { ...item, status: 'unconfirmed', reason: 'Submission outcome could not be saved. Check TeamCity before clearing this schedule.' } : item)
          } else if (PENDING.has(jobs.find((item) => item.id === job.id)?.status)) {
            await update(job.id, { reason: 'Waiting: TeamCity or the machine configuration could not be checked. Deployment has not been submitted.' }).catch(() => {})
          }
          audit('deployment_schedule_check_failed', { scheduleId: job.id, error: error instanceof DeploymentScheduleError ? error.message : 'Unable to check deployment prerequisites.' })
        }
      }))
  }

  function start() {
    if (timer) return
    const check = () => void tick().catch(() => audit('deployment_scheduler_unavailable', { error: 'Deployment schedule storage could not be read.' }))
    timer = setInterval(check, 10000)
    timer.unref()
    check()
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined }

  return { list, create, cancel, recheck, guardImmediate, beginImmediate, finishImmediate, tick, start, stop }
}

export async function readScheduleRequest(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new DeploymentScheduleError('Expected a JSON schedule request.', 400)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new DeploymentScheduleError('Schedule request is too large.', 413)
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
    return body
  } catch { throw new DeploymentScheduleError('Invalid JSON schedule request.', 400) }
}
