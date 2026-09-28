import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'
import './EnvironmentSettings.css'

type EnvironmentFile = { content: string; revision: string; restartSupported: boolean; restartRequired: boolean }
const headers = { 'X-Pulseboard-Request': '1', 'Content-Type': 'application/json' }

export default function EnvironmentSettings({ onDirtyChange, onBusyChange }: { onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [file, setFile] = useState<EnvironmentFile>()
  const [content, setContent] = useState('')
  const [visible, setVisible] = useState(false)
  const [pending, setPending] = useState('Loading…')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const dirty = !!file && content !== file.content

  const load = useCallback(async () => {
    setPending('Loading…'); setError(''); setMessage('')
    try {
      const result = await apiRequest<EnvironmentFile>('/api/environment', { headers })
      setFile(result); setContent(result.content)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load .env') }
    finally { setPending('') }
  }, [])

  useEffect(() => {
    mounted.current = true
    const initial = window.setTimeout(() => void load(), 0)
    return () => { mounted.current = false; window.clearTimeout(initial) }
  }, [load])
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange(!!pending); return () => onBusyChange(false) }, [pending, onBusyChange])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  const save = async () => {
    setPending('Saving…'); setError(''); setMessage('')
    try {
      const saved = await apiRequest<EnvironmentFile>('/api/environment', {
        method: 'PUT', headers, body: JSON.stringify({ content, revision: file?.revision }),
      }, 25000)
      setFile(saved); setContent(saved.content); setMessage('Saved .env. Restart the app to apply changes.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save .env') }
    finally { setPending('') }
  }

  const restart = async () => {
    if (!window.confirm('Restart Pulseboard to apply the saved .env? The dashboard will briefly disconnect and running scheduled scripts will be stopped.')) return
    setPending('Restarting…'); setError(''); setMessage('')
    try {
      const previous = await apiRequest<{ instanceId: string }>('/api/environment/restart', {
        method: 'POST', headers, body: JSON.stringify({ revision: file?.revision }),
      }, 25000)
      const deadline = Date.now() + 60000
      while (Date.now() < deadline && mounted.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        try {
          const next = await apiRequest<{ instanceId: string }>('/api/environment/status', { headers }, 2500)
          if (next.instanceId !== previous.instanceId) { window.location.reload(); return }
        } catch { /* The worker is temporarily unavailable while restarting. */ }
      }
      setError('The app has not reconnected. If you changed the port, host, or login, open the new address or sign in again. Otherwise check the server logs and reload this page.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to restart the app') }
    finally { if (mounted.current) setPending('') }
  }

  return <>
    <section className="page-heading">
      <div><p className="eyebrow">App settings</p><h1>Environment</h1><p className="subheading">View and update the app’s .env file, then restart to apply your changes.</p></div>
    </section>
    <section className="environment-panel" aria-busy={!!pending}>
      <div className="environment-toolbar"><div><h2>.env</h2><p>{dirty ? 'Unsaved changes' : file?.restartRequired ? 'Saved changes · restart required' : 'Server configuration'}</p></div>
        <button type="button" disabled={!!pending || !file} onClick={() => setVisible(!visible)}>{visible ? 'Hide values' : 'Show values & edit'}</button>
      </div>
      <p className="environment-help">Use KEY=value entries. Comments, quotes, and multiline values are preserved. This file includes passwords and API tokens.</p>
      {error && <p className="environment-error" role="alert">{error}</p>}
      {message && <p className="environment-message" role="status">{message}</p>}
      {visible && file ? <label className="environment-editor">Environment variables<textarea aria-label="Environment variables" value={content} onChange={(event) => setContent(event.target.value)} disabled={!!pending} spellCheck={false} autoComplete="off" autoCapitalize="off" rows={22} /></label>
        : <div className="environment-hidden">{pending || (file ? 'Values are hidden. Select “Show values & edit” to open the editor.' : 'Configuration could not be loaded.')}</div>}
      <div className="environment-actions">
        <button type="button" disabled={!!pending} onClick={() => { if (!dirty || window.confirm('Discard your unsaved .env changes and reload the file?')) { setVisible(false); void load() } }}>Reload file</button>
        <button type="button" disabled={!!pending || !dirty} onClick={() => void save()}>{pending === 'Saving…' ? pending : 'Save changes'}</button>
        <button type="button" disabled={!!pending || !file?.restartSupported || dirty} onClick={() => void restart()}>{pending === 'Restarting…' ? pending : 'Restart app'}</button>
      </div>
      <p className="environment-help">{dirty ? 'Save your changes before restarting. ' : ''}{file && !file.restartSupported ? 'UI restart requires launching the app with npm start or npm run api. ' : ''}Changing the app’s address or login may require opening a new URL or signing in again. Docker port mappings require recreating the container.</p>
    </section>
  </>
}
