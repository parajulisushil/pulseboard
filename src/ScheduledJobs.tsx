import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { apiRequest } from './api'
import './ScheduledJobs.css'

type Schedule = { type: 'manual' } | { type: 'interval'; minutes: number } | { type: 'once'; runAt: string } | { type: 'hourly'; minute: number } | { type: 'daily' | 'weekdays'; time: string }
type Job = {
  id: string; name: string; language: 'python' | 'powershell' | 'sql'; sourceMode: 'path' | 'inline'; scriptPath?: string; scriptContent?: string
  sql?: { server: string; port: number; database: string; username: string; encrypt: boolean; trustServerCertificate: boolean; webhookType: 'none' | 'slack' | 'discord'; hasPassword: boolean; hasWebhook: boolean }
  schedule: Schedule; status: 'scheduled' | 'running' | 'completed'; nextRunAt: string | null; createdAt: string
  lastRunAt: string | null; lastStatus: 'success' | 'failed' | null; lastOutput: string; lastError: string | null
}

function defaultDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  date.setSeconds(0, 0)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function formatDateTime(value: string, timeZone?: string) {
  try { return new Date(value).toLocaleString(undefined, { timeZone }) } catch { return new Date(value).toLocaleString() }
}

function inputDateTime(value: string) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function scheduleLabel(schedule: Schedule, timeZone: string) {
  if (schedule.type === 'manual') return 'Manual only'
  if (schedule.type === 'interval') return `Every ${schedule.minutes} minute(s)`
  if (schedule.type === 'once') return `Once · ${formatDateTime(schedule.runAt, timeZone)}`
  if (schedule.type === 'hourly') return `Hourly · at minute ${String(schedule.minute).padStart(2, '0')}`
  if (schedule.type === 'weekdays') return `Weekdays · ${schedule.time}`
  return `Daily · ${schedule.time}`
}

export default function ScheduledJobs() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [timeZone, setTimeZone] = useState('server local time')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState<'python' | 'powershell' | 'sql'>('powershell')
  const [sourceMode, setSourceMode] = useState<'path' | 'inline'>('path')
  const [scriptPath, setScriptPath] = useState('')
  const [scriptContent, setScriptContent] = useState('')
  const [scheduleType, setScheduleType] = useState<'once' | 'hourly' | 'daily' | 'weekdays' | 'interval' | 'manual'>('daily')
  const [runAt, setRunAt] = useState(defaultDateTime)
  const [minute, setMinute] = useState('0')
  const [time, setTime] = useState('09:00')
  const [intervalMinutes, setIntervalMinutes] = useState('15')
  const [server, setServer] = useState(''); const [port, setPort] = useState('1433')
  const [database, setDatabase] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState('')
  const [encrypt, setEncrypt] = useState(true); const [trustCertificate, setTrustCertificate] = useState(false)
  const [webhookType, setWebhookType] = useState<'none' | 'slack' | 'discord'>('none'); const [webhookUrl, setWebhookUrl] = useState('')
  const [hasPassword, setHasPassword] = useState(false); const [hasWebhook, setHasWebhook] = useState(false)


  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const result = await apiRequest<{ jobs: Job[]; timeZone: string }>('/api/scheduled-jobs')
      setJobs(result.jobs); setTimeZone(result.timeZone || 'server local time'); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load scheduled jobs') }
    finally { if (!quiet) setLoading(false) }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const interval = window.setInterval(() => void refresh(true), 10000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [refresh])

  const resetForm = () => {
    setEditingId(''); setName(''); setLanguage('powershell'); setSourceMode('path'); setScriptPath(''); setScriptContent('')
    setScheduleType('daily'); setRunAt(defaultDateTime()); setMinute('0'); setTime('09:00'); setIntervalMinutes('15')
    setServer(''); setPort('1433'); setDatabase(''); setUsername(''); setPassword(''); setEncrypt(true); setTrustCertificate(false); setWebhookType('none'); setWebhookUrl(''); setHasPassword(false); setHasWebhook(false)
  }

  const edit = async (job: Job) => {
    setPending(job.id); setError('')
    try {
      const editable = await apiRequest<Job>(`/api/scheduled-jobs/${job.id}`)
      setEditingId(editable.id); setName(editable.name); setLanguage(editable.language); setSourceMode(editable.sourceMode)
      setScriptPath(editable.scriptPath || ''); setScriptContent(editable.scriptContent || ''); setScheduleType(editable.schedule.type)
      if (editable.schedule.type === 'once') setRunAt(inputDateTime(editable.schedule.runAt))
      else if (editable.schedule.type === 'hourly') setMinute(String(editable.schedule.minute))
      else if (editable.schedule.type === 'interval') setIntervalMinutes(String(editable.schedule.minutes))
      else if (editable.schedule.type === 'daily' || editable.schedule.type === 'weekdays') setTime(editable.schedule.time)
      if (editable.sql) { setServer(editable.sql.server); setPort(String(editable.sql.port)); setDatabase(editable.sql.database); setUsername(editable.sql.username); setPassword(''); setEncrypt(editable.sql.encrypt); setTrustCertificate(editable.sql.trustServerCertificate); setWebhookType(editable.sql.webhookType); setWebhookUrl(''); setHasPassword(editable.sql.hasPassword); setHasWebhook(editable.sql.hasWebhook) }
      setShowForm(true); window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load the scheduled job') }
    finally { setPending('') }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    const hourlyMinute = Number(minute)
    if (scheduleType === 'hourly' && (!Number.isInteger(hourlyMinute) || hourlyMinute < 0 || hourlyMinute > 59)) { setError('Choose an hourly minute between 0 and 59.'); return }
    const schedule = scheduleType === 'manual' ? { type: 'manual' } : scheduleType === 'interval' ? { type: 'interval', minutes: Number(intervalMinutes) } : scheduleType === 'once' ? { type: 'once', runAt: new Date(runAt).toISOString() }
      : scheduleType === 'hourly' ? { type: 'hourly', minute: hourlyMinute }
        : { type: scheduleType, time }
    setPending('save')
    try {
      await apiRequest<Job>(editingId ? `/api/scheduled-jobs/${editingId}` : '/api/scheduled-jobs', {
        method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
        body: JSON.stringify({ name, language, sourceMode: language === 'sql' ? 'inline' : sourceMode, ...(language === 'sql' || sourceMode === 'inline' ? { scriptContent } : { scriptPath }), schedule, ...(language === 'sql' ? { sql: { server, port: Number(port), database, username, password, encrypt, trustServerCertificate: trustCertificate, webhookType, webhookUrl } } : {}) }),
      }, 20000)
      resetForm(); setShowForm(false); await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save the scheduled job') }
    finally { setPending('') }
  }

  const run = async (job: Job) => {
    if (!window.confirm(`Run “${job.name}” now on this Pulseboard server?`)) return
    setPending(job.id); setError('')
    try { await apiRequest(`/api/scheduled-jobs/${job.id}/run`, { method: 'POST', headers: { 'X-Pulseboard-Request': '1' } }); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to run the job') }
    finally { setPending('') }
  }

  const remove = async (job: Job) => {
    if (!window.confirm(`Delete scheduled job “${job.name}”? Its previous run details will also be removed.`)) return
    setPending(job.id); setError('')
    try { await apiRequest(`/api/scheduled-jobs/${job.id}`, { method: 'DELETE', headers: { 'X-Pulseboard-Request': '1' } }); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to delete the job') }
    finally { setPending('') }
  }

  return <>
    <section className="page-heading">
      <div><p className="eyebrow">Server automation</p><h1>Scheduled jobs</h1><p className="subheading">Run SQL Server queries, Python, or PowerShell on a schedule or on demand.</p></div>
      <button type="button" className="refresh-button" onClick={() => { if (showForm) { resetForm(); setShowForm(false) } else { resetForm(); setShowForm(true) } }}><span>{showForm ? '×' : '+'}</span>{showForm ? 'Close' : 'New job'}</button>
    </section>

    <div className="job-runtime-note"><strong>Execution host</strong><span>Scripts execute under the API service account. SQL queries run with the configured SQL login. Recurring schedules and displayed run times use <b>{timeZone}</b>.</span></div>
    {error && <div className="scheduled-job-error" role="alert">{error}</div>}

    {showForm && <form className="scheduled-job-form" onSubmit={(event) => void submit(event)}>
      <h2>{editingId ? 'Edit scheduled job' : 'Create scheduled job'}</h2>
      <div className="scheduled-job-grid">
        <label>Job name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Nightly cleanup" /></label>
        <label>Job type<select value={language} onChange={(event) => { setLanguage(event.target.value as typeof language); setScriptContent('') }}><option value="powershell">PowerShell (.ps1)</option><option value="python">Python (.py)</option><option value="sql">SQL Server query</option></select></label>
        {language !== 'sql' && <label>Script source<select value={sourceMode} onChange={(event) => setSourceMode(event.target.value as 'path' | 'inline')}><option value="path">Script file on server</option><option value="inline">Enter script here</option></select></label>}
        <label>Schedule<select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}><option value="manual">Manual only</option><option value="interval">Every N minutes</option><option value="once">Date and time (once)</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekdays">Weekdays only</option></select></label>
      </div>
      {language === 'sql' && <>
        <div className="scheduled-job-grid">
          <label>SQL Server name<input required value={server} onChange={(event) => setServer(event.target.value)} placeholder="sql.example.com" /></label>
          <label>Port<input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
          <label>Database<input required value={database} onChange={(event) => setDatabase(event.target.value)} /></label>
          <label>Username<input required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="new-password" required={!hasPassword} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={hasPassword ? 'Leave blank to keep saved password' : ''} /></label>
          <label>Webhook delivery<select value={webhookType} onChange={(event) => { setWebhookType(event.target.value as typeof webhookType); setWebhookUrl(''); setHasWebhook(false) }}><option value="none">None</option><option value="slack">Slack</option><option value="discord">Discord</option></select></label>
          {webhookType !== 'none' && <label>Webhook URL<input type="password" autoComplete="new-password" required={!hasWebhook} value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder={hasWebhook ? 'Leave blank to keep saved webhook' : 'https://…'} /></label>}
          <label className="sql-checkbox"><input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)} /> Encrypt connection</label>
          <label className="sql-checkbox"><input type="checkbox" checked={trustCertificate} onChange={(event) => setTrustCertificate(event.target.checked)} /> Trust server certificate</label>
        </div>
        <label>SQL query<textarea required rows={10} spellCheck={false} value={scriptContent} onChange={(event) => setScriptContent(event.target.value)} placeholder="SELECT TOP (100) * FROM dbo.Example" /><small>Queries run with the SQL login's permissions. Results are sent to the webhook when enabled.</small></label>
      </>}
      {language !== 'sql' && (sourceMode === 'path'
        ? <label>Script location on API server<input required value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} placeholder={language === 'python' ? 'C:\\scripts\\job.py or /scripts/job.py' : 'C:\\scripts\\job.ps1 or /scripts/job.ps1'} /><small>When using Docker, mount the script directory into the container and enter that container path.</small></label>
        : <label>Script<textarea required rows={10} spellCheck={false} value={scriptContent} onChange={(event) => setScriptContent(event.target.value)} placeholder={language === 'python' ? 'print("Hello from Pulseboard")' : 'Write-Output "Hello from Pulseboard"'} /></label>)}
      <div className="scheduled-job-grid timing">
        {scheduleType === 'interval' && <label>Interval in minutes<input type="number" min="1" max="10080" step="1" required value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}
        {scheduleType === 'once' && <label>Run date and time<input type="datetime-local" required value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
        {scheduleType === 'hourly' && <label>Minute of each hour<input type="number" min="0" max="59" step="1" required value={minute} onChange={(event) => setMinute(event.target.value)} /></label>}
        {(scheduleType === 'daily' || scheduleType === 'weekdays') && <label>Run time<input type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>}
      </div>
      <div className="scheduled-job-form-actions"><p>Overlapping runs of the same job are prevented. SQL results are limited to 100 rows / 14,000 characters; webhook messages are shortened. Script output is limited to 16 KB.</p><div><button type="button" className="secondary" onClick={() => { resetForm(); setShowForm(false) }}>Cancel</button><button type="submit" disabled={pending === 'save'}>{pending === 'save' ? 'Saving…' : editingId ? 'Save changes' : 'Save scheduled job'}</button></div></div>
    </form>}

    <section className="scheduled-job-list" aria-live="polite">
      {loading ? <div className="loading-state">Loading scheduled jobs…</div> : !jobs.length ? <div className="scheduled-job-empty"><span>⌁</span><h2>No scheduled jobs</h2><p>Create a SQL query, Python, or PowerShell job.</p></div> : jobs.map((job) => <article className="scheduled-job-card" key={job.id}>
        <div className="scheduled-job-main"><span className={`job-state ${job.status}`} /><div><h2>{job.name}</h2><p>{job.language === 'sql' ? `SQL Server · ${job.sql?.server} / ${job.sql?.database}` : `${job.language === 'python' ? 'Python' : 'PowerShell'} · ${job.sourceMode === 'path' ? job.scriptPath : 'Script entered in Pulseboard'}`}</p></div><span className="job-schedule">{scheduleLabel(job.schedule, timeZone)}</span></div>
        <div className="scheduled-job-details"><div><small>Next run</small><strong>{job.nextRunAt ? formatDateTime(job.nextRunAt, timeZone) : 'No future run'}</strong></div><div><small>Last run</small><strong>{job.lastRunAt ? formatDateTime(job.lastRunAt, timeZone) : 'Never'}</strong></div><div><small>Result</small><strong className={job.lastStatus || ''}>{job.status === 'running' ? 'Running…' : job.lastStatus || '—'}</strong></div></div>
        {(job.lastError || job.lastOutput) && <details className="scheduled-job-output"><summary>Last run output</summary>{job.lastError && <p>{job.lastError}</p>}<pre>{job.lastOutput || 'No output was captured.'}</pre></details>}
        <div className="scheduled-job-actions"><button type="button" disabled={job.status === 'running' || pending === job.id} onClick={() => void edit(job)}>Edit</button><button type="button" disabled={job.status === 'running' || pending === job.id} onClick={() => void run(job)}>Run now</button><button type="button" className="danger" disabled={job.status === 'running' || pending === job.id} onClick={() => void remove(job)}>Delete</button></div>
      </article>)}
    </section>
  </>
}
