import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from './api'
import './Ec2Schedule.css'

type Schedule = {
  serverName: string; instanceId: string; frequency: 'daily' | 'weekdays'; startTime: string | null; stopTime: string | null
  startNextAt: string | null; stopNextAt: string | null
  lastRun: { action: string; status: string; message?: string; scheduledAt: string } | null
}

export default function Ec2Schedule({ serverName, instanceId }: { serverName: string; instanceId: string }) {
  const [schedule, setSchedule] = useState<Schedule>()
  const [timeZone, setTimeZone] = useState('')
  const [editing, setEditing] = useState(false)
  const [frequency, setFrequency] = useState<'daily' | 'weekdays'>('weekdays')
  const [startTime, setStartTime] = useState('08:00')
  const [stopTime, setStopTime] = useState('18:00')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const result = await apiRequest<{ schedules: Schedule[]; timeZone: string }>('/api/ec2-schedules')
      setSchedule(result.schedules.find((item) => item.serverName === serverName)); setTimeZone(result.timeZone); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load schedule') }
  }, [serverName])
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 30000); return () => { window.clearTimeout(initial); window.clearInterval(timer) } }, [refresh])
  function edit() {
    setFrequency(schedule?.frequency || 'weekdays'); setStartTime(schedule ? schedule.startTime || '' : '08:00'); setStopTime(schedule ? schedule.stopTime || '' : '18:00'); setEditing(true)
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError('')
    try {
      await apiRequest(`/api/ec2-schedules/${encodeURIComponent(serverName)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' }, body: JSON.stringify({ frequency, startTime: startTime || null, stopTime: stopTime || null }) })
      setEditing(false); await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save schedule') }
    finally { setPending(false) }
  }
  async function remove() {
    if (!window.confirm(`Remove the EC2 schedule for ${serverName}?`)) return
    setPending(true); setError('')
    try { await apiRequest(`/api/ec2-schedules/${encodeURIComponent(serverName)}`, { method: 'DELETE', headers: { 'X-Pulseboard-Request': '1' } }); setEditing(false); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to remove schedule') }
    finally { setPending(false) }
  }
  const displayTime = (value: string | null) => value && timeZone ? new Date(value).toLocaleString(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }) : '—'
  return <div className="ec2-schedule">
    <div className="ec2-schedule-heading"><strong>Instance schedule</strong>{!editing && <button type="button" onClick={edit}>{schedule ? 'Edit' : 'Set schedule'}</button>}</div>
    {error && <p className="ec2-schedule-error" role="alert">{error}</p>}
    {schedule && !editing && <>
      <p>{schedule.frequency === 'weekdays' ? 'Weekdays' : 'Daily'} · {timeZone}</p>
      {schedule.instanceId !== instanceId && <p className="ec2-schedule-error">Instance changed. Edit the schedule to confirm the new instance.</p>}
      <p>Start {schedule.startTime || 'off'} · Next {displayTime(schedule.startNextAt)}</p>
      <p>Stop {schedule.stopTime || 'off'} · Next {displayTime(schedule.stopNextAt)}</p>
      {schedule.lastRun && <p>Last {schedule.lastRun.action}: {schedule.lastRun.status} · {displayTime(schedule.lastRun.scheduledAt)}{schedule.lastRun.message ? ` — ${schedule.lastRun.message}` : ''}</p>}
      <button type="button" disabled={pending} onClick={() => void remove()}>Remove schedule</button>
    </>}
    {editing && <form onSubmit={(event) => void save(event)}>
      <label>Repeat<select value={frequency} onChange={(event) => setFrequency(event.target.value as 'daily' | 'weekdays')}><option value="weekdays">Weekdays</option><option value="daily">Every day</option></select></label>
      <label>Start time<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
      <label>Stop time<input type="time" value={stopTime} onChange={(event) => setStopTime(event.target.value)} /></label>
      <p>Times use {timeZone}. Clear a time to disable that action. Stopping interrupts active work. The API must be running; missed actions are skipped.</p>
      <div><button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button><button type="button" disabled={pending} onClick={() => setEditing(false)}>Cancel</button></div>
    </form>}
  </div>
}
