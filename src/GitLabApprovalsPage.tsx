import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'
import { currentRefreshTime, refreshTimeLabel, refreshTimeTitle } from './refreshTime'
import GitLabApprovals from './GitLabApprovals'
import './GitLabApprovals.css'

type OpenMergeRequest = {
  projectId: string; projectName: string; iid: number; title: string; webUrl: string
  author: string; assignees: string[]; reviewers: string[]; createdAt?: string; updatedAt?: string
  sourceBranch: string; targetBranch: string; state: 'opened' | 'closed'; draft: boolean; labels: string[]
}
type OpenList = {
  status: 'available' | 'partial' | 'unknown'; projects: string[]
  mergeRequests: OpenMergeRequest[]; warnings: string[]; checkedAt: string
}
type Props = { autoRefreshSeconds: number; onNotice: (message: string, tone?: 'info' | 'error') => void }

function formatDate(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return 'Unknown'
  return new Date(value).toLocaleString()
}

function OpenMergeRequests({ autoRefreshSeconds }: { autoRefreshSeconds: number }) {
  const [data, setData] = useState<OpenList>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState('Not checked')
  const request = useRef<AbortController | null>(null)
  const refresh = useCallback(async (force = false) => {
    if (request.current && !force) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const result = await apiRequest<OpenList>('/api/gitlab/merge-requests', { signal: controller.signal }, 65000)
      if (!controller.signal.aborted) { setData(result); setError(undefined); setLastRefresh(currentRefreshTime()) }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load merge requests.')
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false) }
    }
  }, [])
  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), autoRefreshSeconds * 1000)
    const onReturn = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => { window.clearTimeout(initialRefresh); window.clearInterval(timer); window.removeEventListener('focus', onReturn); document.removeEventListener('visibilitychange', onReturn); request.current?.abort(); request.current = null }
  }, [autoRefreshSeconds, refresh])

  return <section className="gitlab-approvals" aria-labelledby="open-mrs-heading">
    <div className="section-header">
      <div><h2 id="open-mrs-heading">Unmerged merge requests {data && data.status !== 'unknown' && !error && <span className="approval-count">{data.mergeRequests.length}{data.status === 'partial' ? '+' : ''}</span>}</h2>
        <p>Unmerged requests across configured projects and all target branches, including drafts and closed requests.</p><p>Auto-refresh every {autoRefreshSeconds}s</p></div>
      <button type="button" className="refresh-button" disabled={loading} onClick={() => void refresh(true)} title={`${refreshTimeTitle(lastRefresh)}${data?.checkedAt ? ` · Data checked ${formatDate(data.checkedAt)}` : ''}`}><span>↻</span> Refresh merge requests <small>{refreshTimeLabel(lastRefresh, loading, !!error)}</small></button>
    </div>
    <div className="approval-panel" aria-busy={loading}>
      {data?.projects.length ? <div className="approval-account"><span>Projects: {data.projects.join(', ')} · All target branches</span></div> : null}
      {error && <p className="approval-error" role="alert">{error} Displayed requests may be out of date.</p>}
      {!!data?.warnings.length && <div className="approval-warning" role="status"><strong>{data.status === 'partial' ? 'Some merge requests could not be loaded.' : 'Merge requests unavailable.'}</strong><details><summary>Show details</summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details></div>}
      {!data && !error && <p className="approval-empty" role="status">Loading merge requests...</p>}
      {data?.status === 'available' && !data.mergeRequests.length && !error && <p className="approval-empty positive" role="status">No unmerged merge requests found.</p>}
      {!!data?.mergeRequests.length && <ul className="approval-list">{data.mergeRequests.map((mr) => <li className="approval-row" key={`${mr.projectId}:${mr.iid}`}>
        <div className="approval-copy">
          <a className="approval-title" href={mr.webUrl} target="_blank" rel="noopener noreferrer"><span>!{mr.iid}</span> {mr.title} ↗</a>
          <p className="approval-meta">{mr.projectName} · {mr.state === 'closed' ? 'Closed' : mr.draft ? 'Draft' : 'Open'} · {mr.sourceBranch} → {mr.targetBranch}</p>
          <div className="mr-details"><span><strong>Developer</strong> {mr.author}</span><span><strong>Assignee</strong> {mr.assignees.join(', ') || 'Unassigned'}</span><span><strong>Reviewer</strong> {mr.reviewers.join(', ') || 'None'}</span><span><strong>Created</strong> {formatDate(mr.createdAt)}</span><span><strong>Updated</strong> {formatDate(mr.updatedAt)}</span></div>
          {!!mr.labels.length && <p className="approval-meta">Labels: {mr.labels.join(', ')}</p>}
        </div>
      </li>)}</ul>}
    </div>
  </section>
}

export default function GitLabApprovalsPage({ autoRefreshSeconds, onNotice }: Props) {
  const [view, setView] = useState<'approvals' | 'mergeRequests'>('approvals')
  return <>
    <div className="filter-tabs approval-page-tabs" role="group" aria-label="Approval page views">
      <button type="button" className={view === 'approvals' ? 'selected' : ''} aria-pressed={view === 'approvals'} onClick={() => setView('approvals')}>Approvals</button>
      <button type="button" className={view === 'mergeRequests' ? 'selected' : ''} aria-pressed={view === 'mergeRequests'} onClick={() => setView('mergeRequests')}>Unmerged merge requests</button>
    </div>
    {view === 'approvals' ? <GitLabApprovals autoRefreshSeconds={autoRefreshSeconds} refreshKey={0} onNotice={onNotice} /> : <OpenMergeRequests autoRefreshSeconds={autoRefreshSeconds} />}
  </>
}
