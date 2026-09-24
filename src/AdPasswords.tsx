import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiRequest } from './api'
import './AdPasswords.css'

type AdUser = {
  id: string | null
  accountName: string
  displayName: string
  principalName: string
  email: string
  enabled: boolean | null
  expiryStatus: 'scheduled' | 'expired' | 'never' | 'must_change' | 'unknown'
  expiresAt: string | null
  daysRemaining: number | null
  passwordLastSet: string | null
  canReset: boolean
}
type Criteria = { view: 'expiring' | 'search'; query: string }
type UserList = Criteria & {
  status: 'available' | 'partial'
  users: AdUser[]
  warnings: string[]
  checkedAt: string
  windowEnd: string
  resetDefaults: { forceChangeAtNextLogon: boolean; unlockAccount: boolean }
}
type ResetResult = {
  status: 'reset'
  user: { id: string; accountName: string; displayName: string }
  password: string
  generated: boolean
  resetAt: string
  forceChangeAtNextLogon: boolean
  accountUnlocked: boolean
  warnings: string[]
}

const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : 'Unavailable'
const refreshTimeLabel = (value?: string) => value
  ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : 'Not checked'

function expiryLabel(user: AdUser) {
  if (user.expiryStatus === 'never') return 'Never expires'
  if (user.expiryStatus === 'must_change') return 'Must change at next sign-in'
  if (user.expiryStatus === 'unknown') return 'Expiry unavailable'
  if (user.expiryStatus === 'expired') return 'Expired'
  return `${user.daysRemaining} ${user.daysRemaining === 1 ? 'day' : 'days'} remaining`
}

export default function AdPasswords({ onResetPending }: { onResetPending: (pending: boolean) => void }) {
  const [criteria, setCriteria] = useState<Criteria>({ view: 'expiring', query: '' })
  const [query, setQuery] = useState('')
  const [showExpired, setShowExpired] = useState(true)
  const [data, setData] = useState<UserList>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AdUser>()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [resetError, setResetError] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ResetResult>()
  const [reveal, setReveal] = useState(false)
  const [copyMessage, setCopyMessage] = useState('')
  const requestController = useRef<AbortController | null>(null)
  const resetInFlight = useRef(false)
  const passwordInput = useRef<HTMLInputElement>(null)
  const visibleUsers = data?.users.filter((user) => showExpired || user.expiryStatus !== 'expired') ?? []
  const hiddenExpiredCount = (data?.users.length ?? 0) - visibleUsers.length

  const refresh = useCallback(async (force = false) => {
    requestController.current?.abort()
    if (criteria.view === 'search' && !criteria.query) { setData(undefined); setLoading(false); setError(''); return }
    const controller = new AbortController()
    requestController.current = controller
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ view: criteria.view, q: criteria.query })
      if (force) params.set('refresh', '1')
      const response = await apiRequest<UserList>(`/api/ad/users?${params}`, { signal: controller.signal }, 80000)
      if (!controller.signal.aborted) setData(response)
    } catch (failure) {
      if (!controller.signal.aborted) { setData(undefined); setError(failure instanceof Error ? failure.message : 'Unable to read AD users.') }
    } finally {
      if (requestController.current === controller) { requestController.current = null; setLoading(false) }
    }
  }, [criteria])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => { window.clearTimeout(timer); requestController.current?.abort() }
  }, [refresh])

  useEffect(() => {
    if (selected) { passwordInput.current?.focus(); passwordInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
  }, [selected])

  const chooseView = (view: Criteria['view']) => {
    setQuery(''); setData(undefined); setSelected(undefined); setPassword(''); setConfirmation(''); setResetError('')
    setCriteria({ view, query: '' })
  }

  const toggleExpired = () => {
    setShowExpired((value) => !value)
    if (showExpired && selected?.expiryStatus === 'expired') {
      setSelected(undefined); setPassword(''); setConfirmation(''); setResetError('')
    }
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSelected(undefined); setPassword(''); setConfirmation(''); setResetError(''); setData(undefined)
    setCriteria({ view: criteria.view, query: query.trim() })
  }

  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected?.id || resetInFlight.current || loading || error) return
    if (password && Array.from(password).length !== 12) { setResetError('Use exactly 12 characters, or leave the password blank to generate one.'); return }
    if (password !== confirmation) { setResetError('The custom passwords do not match.'); return }
    if (!window.confirm(`Reset the password for ${selected.displayName} (${selected.accountName})?\n\n${password ? 'Use the custom 12-character password.' : 'Generate a random 12-character password.'}`)) return
    resetInFlight.current = true
    setPending(true); onResetPending(true); setResetError(''); setResult(undefined); setReveal(false); setCopyMessage('')
    requestController.current?.abort()
    try {
      const response = await apiRequest<ResetResult>('/api/ad/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
        body: JSON.stringify({ userId: selected.id, accountName: selected.accountName, password }),
      }, 80000)
      if (response?.status !== 'reset' || typeof response.password !== 'string') throw new Error('The server did not return a confirmed password reset. Check the account before trying again.')
      setResult(response); setSelected(undefined); setPassword(''); setConfirmation(''); setReveal(true)
      try { await navigator.clipboard.writeText(response.password); setCopyMessage('Password copied to the clipboard.') }
      catch { setCopyMessage('Password shown below. Select it to copy manually if needed.') }
      void refresh()
    } catch (failure) {
      const connectionInterrupted = failure instanceof TypeError || (failure instanceof Error && ['TimeoutError', 'AbortError'].includes(failure.name))
      setResetError(connectionInterrupted ? 'The connection was interrupted. AD may already have reset the password; check the account before trying again.' : failure instanceof Error ? failure.message : 'AD did not confirm the reset. Check the account before trying again.')
    } finally {
      resetInFlight.current = false
      setPending(false); onResetPending(false)
    }
  }

  const copyPassword = async () => {
    if (!result) return
    try { await navigator.clipboard.writeText(result.password); setCopyMessage('Password copied to the clipboard.') }
    catch { setReveal(true); setCopyMessage('Copy is unavailable here. Select and copy the password below.') }
  }

  return (
    <section id="ad-passwords" className="ad-passwords" aria-labelledby="ad-heading">
      <div className="page-heading">
        <div><p className="eyebrow">Active Directory</p><h1 id="ad-heading">AD passwords</h1><p className="subheading">Check password expiry and reset a selected user’s password.</p></div>
        <button type="button" className="refresh-button" disabled={loading || pending || (criteria.view === 'search' && !criteria.query)} onClick={() => void refresh(true)}><span>↻</span> Refresh users <small>{loading ? 'checking...' : refreshTimeLabel(data?.checkedAt)}</small></button>
      </div>

      <div className="ad-panel">
        <div className="filter-tabs ad-tabs" role="group" aria-label="AD password options">
          <button type="button" className={criteria.view === 'expiring' ? 'selected' : ''} aria-pressed={criteria.view === 'expiring'} disabled={pending} onClick={() => chooseView('expiring')}>Expired / expiring within 7 days</button>
          <button type="button" className={criteria.view === 'search' ? 'selected' : ''} aria-pressed={criteria.view === 'search'} disabled={pending} onClick={() => chooseView('search')}>Find a user / reset password</button>
        </div>
        <form className="ad-search" onSubmit={submitSearch}>
          <label htmlFor="ad-query">{criteria.view === 'expiring' ? 'Filter users' : 'Find a user'}</label>
          <div className="ad-input-row"><input id="ad-query" type="search" placeholder="Name, username, or email" value={query} maxLength={200} required={criteria.view === 'search'} disabled={pending} onChange={(event) => setQuery(event.target.value)} /><button className="refresh-button" disabled={pending || (criteria.view === 'search' && !query.trim())} type="submit">{criteria.view === 'expiring' ? 'Apply filter' : 'Search users'}</button></div>
          <p className="ad-muted">{criteria.view === 'expiring' ? 'Enabled users with expired passwords, required changes at next sign-in, or passwords expiring in the next seven days. Expired passwords appear first, followed by required changes and upcoming expiries.' : 'Search all users to check their expiry date, days remaining, and last password change.'} Dates use your local time zone.</p>
          <button type="button" className="ad-expired-toggle" role="switch" aria-checked={showExpired} disabled={pending} onClick={toggleExpired}><span className="ad-toggle-track" aria-hidden="true" />Show expired users</button>
        </form>
      </div>

      {result && <div className="ad-panel ad-result" role="region" aria-label="Password reset result">
        <div className="ad-panel-heading"><h2>Password reset successful</h2><button type="button" className="refresh-button" onClick={() => { setResult(undefined); setReveal(false); setCopyMessage('') }}>Dismiss password</button></div>
        <p><strong>{result.user.displayName}</strong> · {result.user.accountName} · {dateLabel(result.resetAt)}</p>
        <label htmlFor="ad-result-password">{result.generated ? 'Generated password' : 'New password'}</label>
        <div className="ad-input-row"><input id="ad-result-password" className="ad-secret" type={reveal ? 'text' : 'password'} value={result.password} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="refresh-button" onClick={() => setReveal((value) => !value)}>{reveal ? 'Hide' : 'Show'}</button><button type="button" className="refresh-button" onClick={() => void copyPassword()}>Copy password</button></div>
        <p className="ad-muted">The password is shown and copied automatically. Copy it before dismissing or leaving this page. It is not saved by Pulseboard.</p>
        {copyMessage && <p role="status">{copyMessage}</p>}
        <p className="ad-muted">Change required at next sign-in: {result.forceChangeAtNextLogon ? 'Yes' : 'No change requirement was set'} · Account unlock: {result.accountUnlocked ? 'Confirmed' : 'Not performed or not confirmed'}</p>
        {!!result.warnings.length && <ul className="ad-warning" role="alert">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </div>}

      {selected && <form className="ad-panel ad-reset" onSubmit={(event) => void resetPassword(event)} aria-label={`Reset password for ${selected.accountName}`}>
        <h2>Reset password for {selected.displayName}</h2><p className="ad-identity">{selected.accountName}{selected.principalName && ` · ${selected.principalName}`} · {expiryLabel(selected)}</p>
        <label htmlFor="ad-new-password">New password (optional)</label>
        <input ref={passwordInput} id="ad-new-password" type="password" autoComplete="new-password" value={password} disabled={pending} onChange={(event) => { setPassword(event.target.value); setConfirmation(''); setResetError('') }} aria-describedby="ad-password-help" />
        <p id="ad-password-help" className="ad-muted">Leave blank to generate a random 12-character password with uppercase, lowercase, numbers, and symbols. A custom password must be exactly 12 characters and meet AD’s password policy.</p>
        {!!password && <><label htmlFor="ad-confirm-password">Confirm custom password</label><input id="ad-confirm-password" type="password" autoComplete="new-password" value={confirmation} disabled={pending} required onChange={(event) => setConfirmation(event.target.value)} /></>}
        {data && <p className="ad-muted">Require change at next sign-in: {data.resetDefaults.forceChangeAtNextLogon ? 'Yes' : 'No'} · Unlock after reset: {data.resetDefaults.unlockAccount ? 'Yes' : 'No'}</p>}
        {resetError && <p className="ad-error" role="alert">{resetError}</p>}
        <div className="ad-form-actions"><button type="button" className="refresh-button" disabled={pending} onClick={() => { setSelected(undefined); setPassword(''); setConfirmation(''); setResetError('') }}>Cancel</button><button type="submit" className="ad-reset-button" disabled={pending || loading || !!error}>{pending ? 'Resetting password...' : 'Reset password'}</button></div>
      </form>}

      <div className="ad-panel" aria-busy={loading}>
        {error && <p className="ad-error ad-message" role="alert">{error}</p>}
        {loading && <p className="ad-message ad-muted" role="status">Checking Active Directory...</p>}
        {!loading && !error && !data && <p className="ad-message ad-muted">Enter a name, username, or email to check password expiry or select a user to reset.</p>}
        {data && <>
          <div className="ad-list-summary"><strong aria-live="polite">{visibleUsers.length}{data.status === 'partial' ? '+' : ''} {visibleUsers.length === 1 ? 'user' : 'users'}{data.query && ` matching “${data.query}”`}{hiddenExpiredCount > 0 && ` · ${hiddenExpiredCount} expired hidden`}</strong><span>Checked {dateLabel(data.checkedAt)}{data.view === 'expiring' && ` · Through ${dateLabel(data.windowEnd)}`}</span></div>
          {!!data.warnings.length && <ul className="ad-warning ad-message" role="status">{data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {!loading && !visibleUsers.length && <p className="ad-message ad-muted">{hiddenExpiredCount > 0 ? 'All matching users in these results have expired passwords. Turn on “Show expired users” to display them.' : data.status === 'partial' ? 'No matching users in the results that could be checked.' : data.view === 'expiring' ? 'No matching enabled users have expired passwords, required changes at next sign-in, or passwords expiring in the next seven days.' : 'No users matched your search.'}</p>}
          {!!visibleUsers.length && <div className="ad-table-wrap"><table className="ad-table"><thead><tr><th scope="col">User</th><th scope="col">Password expiry</th><th scope="col">Last password change</th><th scope="col">Action</th></tr></thead><tbody>{visibleUsers.map((user, index) => <tr key={user.id || `${user.accountName}:${index}`}>
            <td><strong>{user.displayName}</strong><span>{user.accountName}{user.enabled === false ? ' · Disabled' : user.enabled === null ? ' · Account state unknown' : ''}</span>{user.principalName && <span>{user.principalName}</span>}{user.email && user.email !== user.principalName && <span>{user.email}</span>}</td>
            <td><strong className={`ad-expiry-${user.expiryStatus}`}>{expiryLabel(user)}</strong>{user.expiresAt && <span>{dateLabel(user.expiresAt)}</span>}</td>
            <td>{dateLabel(user.passwordLastSet)}</td>
            <td><button type="button" className="ad-reset-button" disabled={!user.canReset || loading || pending || !!error} aria-label={`Reset password for ${user.accountName}`} onClick={() => { setSelected(user); setPassword(''); setConfirmation(''); setResetError('') }}>Reset password</button></td>
          </tr>)}</tbody></table></div>}
        </>}
      </div>
    </section>
  )
}
