import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'
import './GitLabApprovals.css'

type Approver = { id: number; name: string; username: string }
type CriticalSuggestion = { title: string; explanation: string; file: string; line: number | null }
type AIReview = {
  status: 'reviewed' | 'unavailable' | 'skipped'
  provider?: 'openai' | 'groq'
  providerName?: string
  model?: string
  criticalSuggestions: CriticalSuggestion[]
  incomplete?: boolean
  reason?: string
}
type MergeRequest = {
  projectId: string
  projectName: string
  iid: number
  title: string
  webUrl: string
  sha?: string
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt?: string
  rules: { name: string; required: number; approved: number }[]
  canApprove: boolean
  reason?: string
  aiReview: AIReview
}
type ApprovalList = {
  codeFreezeApplied?: boolean
  status: 'available' | 'partial' | 'unknown'
  user?: Approver
  projects?: string[]
  targetBranches?: string[]
  mergeRequests: MergeRequest[]
  warnings: string[]
  checkedAt: string
}
type Props = {
  autoRefreshSeconds: number
  refreshKey: number
  onNotice: (message: string, tone?: 'info' | 'error') => void
}
type ApprovalFilter = 'ready' | 'drafts' | 'all'

const mergeRequestKey = (mr: MergeRequest) => `${mr.projectId}:${mr.iid}`
const isDraft = (mr: MergeRequest) => /^Draft\b/.test(mr.reason || '')
const refreshTimeLabel = (value?: string) => value
  ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : 'Not checked'

export default function GitLabApprovals({ autoRefreshSeconds, refreshKey, onNotice }: Props) {
  const [data, setData] = useState<ApprovalList>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string[]>([])
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<ApprovalFilter>('ready')
  const requestController = useRef<AbortController | null>(null)
  const actions = useRef(new Set<string>())
  const cancelRefresh = useCallback(() => {
    requestController.current?.abort()
    requestController.current = null
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (requestController.current && !force) return
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setLoading(true)
    try {
      const result = await apiRequest<ApprovalList>('/api/gitlab/approvals', { signal: controller.signal }, 65000)
      if (controller.signal.aborted) return
      setData(result)
      setError(undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load GitLab approvals.')
    } finally {
      if (requestController.current === controller) {
        requestController.current = null
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(true), 0)
    const timer = window.setInterval(() => void refresh(), autoRefreshSeconds * 1000)
    const onReturn = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(timer)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
      cancelRefresh()
    }
  }, [autoRefreshSeconds, refreshKey, refresh, cancelRefresh])

  const followedLink = useRef(false)
  useEffect(() => {
    if (followedLink.current || !data) return
    const target = document.getElementById(window.location.hash.slice(1))
    if (target) { target.scrollIntoView({ block: 'center' }); followedLink.current = true }
  }, [data])

  const approve = async (mr: MergeRequest) => {
    const key = mergeRequestKey(mr)
    if (!mr.projectId || !mr.canApprove || !mr.sha || !data?.user || error || actions.current.has(key)) return
    const user = data.user
    const criticalWarning = mr.aiReview.criticalSuggestions.length
      ? `\n\nWarning: AI review found ${mr.aiReview.criticalSuggestions.length} critical suggestion${mr.aiReview.criticalSuggestions.length === 1 ? '' : 's'}.`
      : ''
    if (!window.confirm(`Approve ${mr.projectName} !${mr.iid}: ${mr.title}\n\n${mr.sourceBranch} → ${mr.targetBranch}\nCommit ${mr.sha.slice(0, 12)}\nApproving as @${user.username}${criticalWarning}`)) return
    actions.current.add(key)
    setPending((current) => [...current, key])
    setActionErrors((current) => { const next = { ...current }; delete next[key]; return next })
    // Discard an older list response that could restore an approved row.
    cancelRefresh()
    try {
      await apiRequest(`/api/gitlab/merge-requests/${mr.iid}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' },
        body: JSON.stringify({ projectId: mr.projectId, sha: mr.sha, userId: user.id }),
      }, 35000)
      cancelRefresh()
      setData((current) => current ? { ...current, mergeRequests: current.mergeRequests.filter((item) => mergeRequestKey(item) !== key) } : current)
      onNotice(`Approved ${mr.projectName} !${mr.iid} as @${user.username}`)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Unable to approve this merge request.'
      setActionErrors((current) => ({ ...current, [key]: message }))
      onNotice(message, 'error')
    } finally {
      actions.current.delete(key)
      setPending((current) => current.filter((item) => item !== key))
      void refresh(true)
    }
  }

  const visibleMergeRequests = data?.mergeRequests.filter((mr) => (
    filter === 'all' || (filter === 'drafts' ? isDraft(mr) : mr.canApprove)
  )) ?? []
  const draftCount = data?.mergeRequests.filter(isDraft).length ?? 0

  return (
    <section id="gitlab-approvals" className="gitlab-approvals" aria-labelledby="gitlab-approvals-heading">
      <div className="section-header">
        <div>
          <h2 id="gitlab-approvals-heading">GitLab approvals {data?.projects && data.status !== 'unknown' && !error && <span className="approval-count">{visibleMergeRequests.length}{data.status === 'partial' ? '+' : ''}</span>}</h2>
          <p>Code Freeze requests awaiting your additional approval after normal approval is complete.</p>
          <p>Auto-refresh every {autoRefreshSeconds}s · Code Freeze alerts {data ? (data.codeFreezeApplied ? 'enabled' : 'disabled') : 'checking...'}</p>
        </div>
        <button type="button" className="refresh-button" disabled={loading} onClick={() => void refresh(true)}><span>↻</span> Refresh approvals <small>{loading ? 'checking...' : refreshTimeLabel(data?.checkedAt)}</small></button>
      </div>
      <div className="approval-panel" aria-busy={loading}>
        {data?.projects && !!data.mergeRequests.length && <div className="filter-tabs" role="group" aria-label="Filter merge requests">
          <button type="button" className={filter === 'ready' ? 'selected' : ''} aria-pressed={filter === 'ready'} onClick={() => setFilter('ready')}>Ready ({data.mergeRequests.filter((mr) => mr.canApprove).length})</button>
          <button type="button" className={filter === 'drafts' ? 'selected' : ''} aria-pressed={filter === 'drafts'} onClick={() => setFilter('drafts')}>Draft MRs ({draftCount})</button>
          <button type="button" className={filter === 'all' ? 'selected' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All ({data.mergeRequests.length})</button>
        </div>}
        {data?.user && <div className="approval-account"><span>Approving as <strong>{data.user.name} (@{data.user.username})</strong></span><span>Projects: {data.projects?.join(', ')} · {data.targetBranches?.length ? data.targetBranches.join(', ') : 'All target branches'}</span></div>}
        {data && !data.projects && <p className="approval-error" role="alert">Restart the API to load the updated Code Freeze approval list.</p>}
        {error && <p className="approval-error" role="alert">{error} Displayed requests may be out of date. Refresh before approving.</p>}
        {!!data?.warnings.length && <div className="approval-warning" role="status"><strong>{data.status === 'partial' ? 'Some approval statuses could not be checked.' : 'Approval status unavailable.'}</strong><details><summary>Show details</summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details></div>}
        {!data && !error && <p className="approval-empty" role="status">Checking GitLab approval requirements...</p>}
        {data?.projects && data.status === 'available' && !data.mergeRequests.length && !error && <p className="approval-empty positive" role="status">No Code Freeze requests are ready for your additional approval.</p>}
        {data?.projects && !!data.mergeRequests.length && !visibleMergeRequests.length && !error && <p className="approval-empty" role="status">{filter === 'drafts' ? 'No Draft MRs are awaiting Code Freeze approval.' : 'No merge requests match this filter.'}</p>}
        {data?.projects && !!visibleMergeRequests.length && <ul className="approval-list">{visibleMergeRequests.map((mr) => (
          <li className="approval-row" id={`mr-${mr.projectId}-${mr.iid}`} key={mergeRequestKey(mr)}>
            <div className="approval-copy">
              <a className="approval-title" href={mr.webUrl} target="_blank" rel="noopener noreferrer"><span>!{mr.iid}</span> {mr.title} ↗</a>
              <p className="approval-meta">{mr.projectName} · {mr.author} · <span>{mr.sourceBranch} → {mr.targetBranch}</span>{mr.sha && <> · <code>{mr.sha.slice(0, 8)}</code></>}</p>
              <p className="approval-meta positive">Normal approval complete</p>
              <p className="approval-rules">{mr.rules.map((rule) => `${rule.name}: ${rule.approved}/${rule.required} approvals`).join(' · ')}</p>
              <div className={`ai-review ${mr.aiReview.criticalSuggestions.length ? 'has-critical' : ''}`}>
                <strong>AI review{mr.aiReview.providerName ? ` · ${mr.aiReview.providerName}` : ''}</strong>
                {mr.aiReview.status === 'skipped' && <p>{mr.aiReview.reason || 'AI review skipped.'}</p>}
                {mr.aiReview.status === 'unavailable' && <p>{mr.aiReview.reason || 'AI review unavailable.'}</p>}
                {mr.aiReview.status === 'reviewed' && !mr.aiReview.criticalSuggestions.length && <p>No critical suggestions found.{mr.aiReview.incomplete ? ' Review coverage is incomplete.' : ''}</p>}
                {!!mr.aiReview.criticalSuggestions.length && <ul>{mr.aiReview.criticalSuggestions.map((suggestion, index) => (
                  <li key={`${suggestion.file}:${suggestion.line}:${index}`}><strong>{suggestion.title}</strong><span>{suggestion.file}{suggestion.line ? `:${suggestion.line}` : ''}</span><p>{suggestion.explanation}</p></li>
                ))}</ul>}
                {mr.aiReview.criticalSuggestions.length > 0 && mr.aiReview.reason && <p>{mr.aiReview.reason}</p>}
              </div>
              {mr.reason && <p className="approval-reason">{mr.reason}</p>}
              {actionErrors[mergeRequestKey(mr)] && <p className="approval-error" role="alert">{actionErrors[mergeRequestKey(mr)]}</p>}
            </div>
            <button type="button" className="approve-button" disabled={!mr.projectId || !mr.canApprove || !!error || pending.includes(mergeRequestKey(mr))} aria-label={`Approve ${mr.projectName} merge request !${mr.iid}`} onClick={() => void approve(mr)}>{pending.includes(mergeRequestKey(mr)) ? 'Approving...' : 'Approve'}</button>
          </li>
        ))}</ul>}
      </div>
    </section>
  )
}
