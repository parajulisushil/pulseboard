import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiRequest } from './api'
import './DeploymentControls.css'

type Schedule = {
  id: string; serverName: string; mode: 'delay' | 'after_build' | 'immediate'; status: string
  active: boolean; canCancel: boolean; notBefore: string | null; afterBuildId: string | null
  reason: string; buildId?: number; webUrl?: string
  prerequisite?: { buildId: number; webUrl?: string } | null
}
type Build = { buildId: number; buildNumber?: string; buildName?: string; branch?: string; status: string; reason?: string; webUrl?: string }
type Props = {
  serverName: string; canDeploy: boolean; deploying: boolean
  onDeploy: () => void; onComplete: (name: string) => Promise<void>
  builds?: { id?: number; number?: string; component?: string }[]
}

const statusLabels: Record<string, string> = {
  waiting_time: 'Deployment scheduled', waiting_build: 'Waiting for build', waiting_deployment: 'Waiting for existing deployment',
  submitting: 'Submitting deployment', queued: 'Deployment queued', running: 'Deploying',
  verifying: 'Deployment completed', verification_failed: 'Deployment completed',
  success: 'Deployment completed', failed: 'Deployment stopped', cancelled: 'Schedule cancelled', unconfirmed: 'Submission needs review',
}

export default function DeploymentControls({ serverName, canDeploy, deploying, onDeploy, onComplete, builds = [] }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<'delay' | 'after_build'>('after_build')
  const [minutes, setMinutes] = useState('15')
  const [buildId, setBuildId] = useState('')
  const [preview, setPreview] = useState<Build>()
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState(false)
  const actions = useRef(false)
  const refreshController = useRef<AbortController | null>(null)
  const previewController = useRef<AbortController | null>(null)
  const previousStatuses = useRef(new Map<string, string>())
  const current = schedules.find((schedule) => schedule.active) || schedules[0]
  const blocked = !loaded || !!loadError || !!current?.active || deploying || pending

  const refresh = useCallback(async () => {
    if (refreshController.current || actions.current) return
    const controller = new AbortController()
    refreshController.current = controller
    try {
      const result = await apiRequest<{ schedules: Schedule[] }>(`/api/deployment-schedules?server=${encodeURIComponent(serverName)}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!Array.isArray(result?.schedules)) throw new Error('Restart the API to enable deployment scheduling.')
      for (const schedule of result.schedules) {
        const previous = previousStatuses.current.get(schedule.id)
        if (previous && previous !== schedule.status && ['success', 'verification_failed'].includes(schedule.status)) void onComplete(serverName)
        previousStatuses.current.set(schedule.id, schedule.status)
      }
      setSchedules(result.schedules); setLoaded(true); setLoadError('')
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Unable to read deployment schedules.')
    } finally { if (refreshController.current === controller) refreshController.current = null }
  }, [serverName, onComplete])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(), 10000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval); refreshController.current?.abort(); previewController.current?.abort() }
  }, [refresh])

  const checkBuild = async () => {
    if (!/^[1-9]\d{0,15}$/.test(buildId)) { setActionError('Enter the numeric build ID from TeamCity.'); return }
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    setChecking(true); setPreview(undefined); setActionError('')
    try {
      const build = await apiRequest<Build>(`/api/teamcity/builds/${buildId}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (String(build.buildId) !== buildId || !['queued', 'running', 'success'].includes(build.status)) throw new Error(build.reason || 'This build is unavailable, failed, or cancelled. Choose another build.')
      setPreview(build)
    } catch (error) { if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : 'Unable to check the selected build.') }
    finally { if (previewController.current === controller) { setChecking(false); previewController.current = null } }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (blocked || actions.current) return
    if (mode === 'after_build' && (!preview || String(preview.buildId) !== buildId)) { setActionError('Check the selected TeamCity build before scheduling.'); return }
    const delay = Number(minutes)
    if (mode === 'delay' && (!Number.isInteger(delay) || delay < 1 || delay > 1440)) { setActionError('Choose a delay between 1 and 1440 whole minutes.'); return }
    const timing = mode === 'delay' ? `in ${delay} minutes` : `after TeamCity build ${buildId}${preview?.buildName ? ` (${preview.buildName})` : ''} succeeds`
    if (!window.confirm(`Schedule deployment to ${serverName} ${timing}?\n\nThis will run the machine’s existing deployment pipeline with its latest artifacts and may log off active users.`)) return
    actions.current = true; setPending(true); setActionError('')
    refreshController.current?.abort(); refreshController.current = null
    try {
      const result = await apiRequest<Schedule>(`/api/servers/${encodeURIComponent(serverName)}/deployment-schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
        body: JSON.stringify(mode === 'delay' ? { mode, delayMinutes: delay } : { mode, afterBuildId: buildId }),
      }, 20000)
      setSchedules((current) => [result, ...current.filter((item) => item.id !== result.id)]); setExpanded(false)
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Schedule submission could not be confirmed. Refresh before trying again.') }
    finally { actions.current = false; setPending(false); void refresh() }
  }

  const cancel = async () => {
    if (!current?.canCancel || actions.current) return
    const message = current.status === 'unconfirmed'
      ? `Have you checked TeamCity for the deployment to ${serverName}? Clearing this schedule does not cancel any build already submitted. Clear it only after reviewing that build.`
      : `Cancel the pending deployment to ${serverName}?`
    if (!window.confirm(message)) return
    actions.current = true; setPending(true); setActionError('')
    refreshController.current?.abort(); refreshController.current = null
    try {
      const result = await apiRequest<Schedule>(`/api/deployment-schedules/${current.id}/cancel`, { method: 'POST', headers: { 'X-Pulseboard-Request': '1' } })
      setSchedules((current) => current.map((item) => item.id === result.id ? result : item))
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Unable to cancel this schedule.') }
    finally { actions.current = false; setPending(false); void refresh() }
  }

  return <div className="deployment-controls">
    <div className="deployment-control-buttons">
      {canDeploy && <button type="button" className="deployment-control-button" disabled={blocked} onClick={onDeploy}>{deploying ? 'Deploying...' : 'Deploy latest now'}</button>}
      <button type="button" className="deployment-control-button" disabled={blocked} aria-expanded={expanded} onClick={() => { setExpanded((value) => !value); setActionError('') }}>Schedule deployment</button>
    </div>
    {loadError && <p className="deployment-schedule-error" role="alert">{loadError} <button className="deployment-inline-button" type="button" onClick={() => void refresh()}>Retry</button></p>}
    {actionError && <p className="deployment-schedule-error" role="alert">{actionError}</p>}
    {current && !['success', 'verification_failed'].includes(current.status) && <div className={`deployment-schedule-status ${current.status}`} aria-live="polite">
      <strong>{statusLabels[current.status] || current.status}</strong>
      <p>{current.reason}</p>
      {current.notBefore && <p>Not before {new Date(current.notBefore).toLocaleString()}</p>}
      {current.afterBuildId && <p>Wait for {current.prerequisite?.webUrl ? <a href={current.prerequisite.webUrl} target="_blank" rel="noopener noreferrer">build ID {current.afterBuildId} ↗</a> : `build ID ${current.afterBuildId}`} to succeed</p>}
      {current.webUrl && <a href={current.webUrl} target="_blank" rel="noopener noreferrer">View deployment in TeamCity ↗</a>}
      {current.canCancel && <button type="button" className="deployment-inline-button" disabled={pending} onClick={() => void cancel()}>{current.status === 'unconfirmed' ? 'Clear after checking TeamCity' : 'Cancel schedule'}</button>}
    </div>}
    {expanded && !current?.active && <form className="deployment-schedule-form" onSubmit={(event) => void submit(event)} aria-label={`Schedule deployment to ${serverName}`}>
      <label>When to deploy<select value={mode} disabled={pending} onChange={(event) => { setMode(event.target.value as 'delay' | 'after_build'); setActionError('') }}><option value="after_build">After a specific TeamCity build succeeds</option><option value="delay">After a delay</option></select></label>
      {mode === 'delay' ? <label>Delay in minutes<input type="number" min="1" max="1440" step="1" required value={minutes} disabled={pending} onChange={(event) => setMinutes(event.target.value)} /></label> : <>
        <label>TeamCity build ID<input inputMode="numeric" pattern="[1-9][0-9]{0,15}" list={`deployment-build-ids-${serverName}`} required value={buildId} disabled={pending} onChange={(event) => { previewController.current?.abort(); setChecking(false); setBuildId(event.target.value); setPreview(undefined); setActionError('') }} /></label>
        <datalist id={`deployment-build-ids-${serverName}`}>{builds.filter((build) => build.id).map((build) => <option key={build.id} value={build.id}>{build.component || 'Build'} {build.number || build.id}</option>)}</datalist>
        <p>Use the numeric build ID from its TeamCity URL, not its build number. Active dashboard builds are suggested.</p>
        <button type="button" className="deployment-control-button" disabled={pending || checking || !buildId} onClick={() => void checkBuild()}>{checking ? 'Checking...' : 'Check build'}</button>
        {preview && <p className="deployment-build-preview">{preview.buildName || 'TeamCity build'} · ID {preview.buildId}{preview.buildNumber && ` · #${preview.buildNumber}`} · {preview.status}{preview.branch && ` · ${preview.branch}`}{preview.webUrl && <> · <a href={preview.webUrl} target="_blank" rel="noopener noreferrer">Open build ↗</a></>}</p>}
      </>}
      <p>The schedule is saved and survives closing this page or restarting the API. The API must be running to submit it.</p>
      <button className="deployment-control-button" type="submit" disabled={pending || blocked || (mode === 'after_build' && !preview)}>{pending ? 'Saving schedule...' : 'Confirm schedule'}</button>
    </form>}
  </div>
}
