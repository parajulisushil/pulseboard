import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest } from './api'
import AIReviewDisplay, { type AIReview } from './AIReviewDisplay'
import { currentRefreshTime, refreshTimeLabel, refreshTimeTitle } from './refreshTime'

type AssignedRequest = {
  projectId: string; projectName: string; iid: number; title: string; webUrl: string
  sha?: string; author: string; sourceBranch: string; targetBranch: string; draft: boolean; aiReview: AIReview
}
type AssignedList = {
  status: 'available' | 'partial' | 'unknown'
  user?: { name: string; username: string }
  mergeRequests: AssignedRequest[]; warnings: string[]; checkedAt: string
}

export default function AssignedMergeRequests({ autoRefreshSeconds }: { autoRefreshSeconds: number }) {
  const [data, setData] = useState<AssignedList>()
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
      const result = await apiRequest<AssignedList>('/api/gitlab/assigned-merge-requests', { signal: controller.signal }, 65000)
      if (!controller.signal.aborted) { setData(result); setError(undefined); setLastRefresh(currentRefreshTime()) }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load assigned merge requests.')
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false) }
    }
  }, [])
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), autoRefreshSeconds * 1000)
    const onReturn = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', onReturn); document.removeEventListener('visibilitychange', onReturn); request.current?.abort(); request.current = null }
  }, [autoRefreshSeconds, refresh])

  return <section className="gitlab-approvals" aria-labelledby="assigned-mrs-heading">
    <div className="section-header">
      <div><h2 id="assigned-mrs-heading">Assigned to me {data && data.status !== 'unknown' && !error && <span className="approval-count">{data.mergeRequests.length}{data.status === 'partial' ? '+' : ''}</span>}</h2>
        <p>Open merge requests assigned to your GitLab account, across accessible projects and target branches.</p><p>Auto-refresh every {autoRefreshSeconds}s</p></div>
      <button type="button" className="refresh-button" disabled={loading} onClick={() => void refresh(true)} title={`${refreshTimeTitle(lastRefresh)}${data?.checkedAt ? ` · Data checked ${new Date(data.checkedAt).toLocaleString()}` : ''}`}><span>↻</span> Refresh assigned requests <small>{refreshTimeLabel(lastRefresh, loading, !!error)}</small></button>
    </div>
    <div className="approval-panel" aria-busy={loading}>
      {data?.user && <div className="approval-account">Assigned to <strong>{data.user.name} (@{data.user.username})</strong></div>}
      {error && <p className="approval-error" role="alert">{error} Displayed requests may be out of date.</p>}
      {!!data?.warnings.length && <div className="approval-warning" role="status"><strong>{data.status === 'partial' ? 'Some assigned requests could not be loaded.' : 'Assigned requests unavailable.'}</strong><details><summary>Show details</summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details></div>}
      {!data && !error && <p className="approval-empty" role="status">Loading assigned merge requests and AI reviews...</p>}
      {data?.status === 'available' && !data.mergeRequests.length && !error && <p className="approval-empty positive" role="status">No open merge requests are assigned to you.</p>}
      {!!data?.mergeRequests.length && <ul className="approval-list">{data.mergeRequests.map((mr) => <li className="approval-row" key={`${mr.projectId}:${mr.iid}`}>
        <div className="approval-copy"><a className="approval-title" href={mr.webUrl} target="_blank" rel="noopener noreferrer"><span>!{mr.iid}</span> {mr.title} ↗</a>
          <p className="approval-meta">{mr.projectName} · {mr.author} · {mr.draft ? 'Draft · ' : ''}{mr.sourceBranch} → {mr.targetBranch}{mr.sha && <> · <code>{mr.sha.slice(0, 8)}</code></>}</p>
          <AIReviewDisplay review={mr.aiReview} />
        </div>
      </li>)}</ul>}
    </div>
  </section>
}
