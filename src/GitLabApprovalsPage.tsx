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
  const [branch, setBranch] = useState('')
  const [project, setProject] = useState('')
  const [search, setSearch] = useState('')
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

  const requests = data?.mergeRequests ?? []
  const branches = [...new Set(requests.map((mr) => mr.targetBranch).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const projects = [...new Map(requests.map((mr) => [mr.projectId, mr.projectName])).entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  const searchTerm = search.trim().toLocaleLowerCase()
  const visible = requests.filter((mr) => (!branch || mr.targetBranch === branch) && (!project || mr.projectId === project)
    && (!searchTerm || [mr.title, `!${mr.iid}`, String(mr.iid), mr.projectName, mr.author, mr.sourceBranch, mr.targetBranch, ...mr.assignees, ...mr.reviewers, ...mr.labels].some((value) => value?.toLocaleLowerCase().includes(searchTerm))))
  const grouped = new Map<string, Map<string, { name: string; requests: OpenMergeRequest[] }>>()
  for (const mr of visible) {
    const branchName = mr.targetBranch || 'Unknown branch'
    if (!grouped.has(branchName)) grouped.set(branchName, new Map())
    const branchProjects = grouped.get(branchName)!
    if (!branchProjects.has(mr.projectId)) branchProjects.set(mr.projectId, { name: mr.projectName, requests: [] })
    branchProjects.get(mr.projectId)!.requests.push(mr)
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))

  return <section className="gitlab-approvals" aria-labelledby="open-mrs-heading">
    <div className="section-header">
      <div><h2 id="open-mrs-heading">Unmerged merge requests {data && data.status !== 'unknown' && !error && <span className="approval-count">{visible.length}{data.status === 'partial' ? '+' : ''}</span>}</h2>
        <p>Unmerged requests across configured projects and all target branches, including drafts and closed requests.</p><p>Auto-refresh every {autoRefreshSeconds}s</p></div>
      <button type="button" className="refresh-button" disabled={loading} onClick={() => void refresh(true)} title={`${refreshTimeTitle(lastRefresh)}${data?.checkedAt ? ` · Data checked ${formatDate(data.checkedAt)}` : ''}`}><span>↻</span> Refresh merge requests <small>{refreshTimeLabel(lastRefresh, loading, !!error)}</small></button>
    </div>
    <div className="approval-panel" aria-busy={loading}>
      {data?.projects.length ? <div className="approval-account"><span>Projects: {data.projects.join(', ')} · All target branches</span></div> : null}
      <div className="mr-filters" role="group" aria-label="Filter unmerged merge requests">
        <label>Target branch<select value={branch} onChange={(event) => setBranch(event.target.value)}><option value="">All branches</option>{branch && !branches.includes(branch) && <option value={branch}>{branch}</option>}{branches.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Project<select value={project} onChange={(event) => setProject(event.target.value)}><option value="">All projects</option>{project && !projects.some(([id]) => id === project) && <option value={project}>Project {project}</option>}{projects.map(([id, name]) => <option key={id} value={id}>{name} ({id})</option>)}</select></label>
        <label className="mr-search">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, MR, or person" /></label>
      </div>
      {error && <p className="approval-error" role="alert">{error} Displayed requests may be out of date.</p>}
      {!!data?.warnings.length && <div className="approval-warning" role="status"><strong>{data.status === 'partial' ? 'Some merge requests could not be loaded.' : 'Merge requests unavailable.'}</strong><details><summary>Show details</summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details></div>}
      {!data && !error && <p className="approval-empty" role="status">Loading merge requests...</p>}
      {data?.status === 'available' && !data.mergeRequests.length && !error && <p className="approval-empty positive" role="status">No unmerged merge requests found.</p>}
      {!!requests.length && !visible.length && <p className="approval-empty" role="status">No merge requests match these filters.</p>}
      {groups.map(([branchName, branchProjects]) => <section className="mr-branch-group" key={branchName}>
        <h3 className="mr-branch-heading"><span>Target branch</span> {branchName} <small>{[...branchProjects.values()].reduce((count, item) => count + item.requests.length, 0)}</small></h3>
        {[...branchProjects.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0])).map(([id, group]) => <section className="mr-project-group" key={id}>
          <h4 className="mr-project-heading">{group.name} <small>{group.requests.length}</small></h4>
          <ul className="approval-list">{group.requests.map((mr) => <li className="approval-row" key={`${mr.projectId}:${mr.iid}`}>
            <div className="approval-copy">
              <a className="approval-title" href={mr.webUrl} target="_blank" rel="noopener noreferrer"><span>!{mr.iid}</span> {mr.title} ↗</a>
              <p className="approval-meta">{mr.state === 'closed' ? 'Closed' : mr.draft ? 'Draft' : 'Open'} · {mr.sourceBranch} → {mr.targetBranch}</p>
              <div className="mr-details"><span><strong>Developer</strong> {mr.author}</span><span><strong>Assignee</strong> {mr.assignees.join(', ') || 'Unassigned'}</span><span><strong>Reviewer</strong> {mr.reviewers.join(', ') || 'None'}</span><span><strong>Created</strong> {formatDate(mr.createdAt)}</span><span><strong>Updated</strong> {formatDate(mr.updatedAt)}</span></div>
              {!!mr.labels.length && <p className="approval-meta">Labels: {mr.labels.join(', ')}</p>}
            </div>
          </li>)}</ul>
        </section>)}
      </section>)}
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
