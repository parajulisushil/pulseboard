import { aiReviewSettings, reviewChangesWithAI } from './ai-code-review.mjs'

const approvalLocks = new Set()
const aiReviewCache = new Map()
const value = (name) => process.env[name]?.trim() || undefined

export class GitLabApprovalError extends Error {
  constructor(message, status = 503) {
    super(message)
    this.status = status
  }
}

function configuration() {
  const url = value('GITLAB_URL')?.replace(/\/$/, '')
  const token = value('GITLAB_APPROVAL_TOKEN') || value('GITLAB_TOKEN')
  const projectIds = value('GITLAB_APPROVAL_PROJECT_IDS')
  if (!url || !token || !projectIds) throw new GitLabApprovalError('Configure GITLAB_APPROVAL_PROJECT_IDS with the GitLab project IDs to check.')
  const projects = [...new Set(projectIds.split(',').map((id) => id.trim()))]
  if (projects.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new GitLabApprovalError('GITLAB_APPROVAL_PROJECT_IDS must contain comma-separated numeric project IDs.')
  }
  const targetBranchValue = value('GITLAB_APPROVAL_TARGET_BRANCH')
  const targetBranches = targetBranchValue ? [...new Set(targetBranchValue.split(',').map((branch) => branch.trim()))] : []
  if (targetBranches.some((branch) => !branch)) {
    throw new GitLabApprovalError('GITLAB_APPROVAL_TARGET_BRANCH must contain comma-separated branch names without empty entries.')
  }
  return { url, token, projects, targetBranches }
}

async function requestGitLab(config, resource, { signal, body } = {}) {
  let response
  try {
    response = await fetch(`${config.url}/api/v4${resource}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'PRIVATE-TOKEN': config.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      redirect: 'error',
    })
  } catch {
    throw new GitLabApprovalError('Unable to reach GitLab. Refresh to check the current approval status.')
  }
  if (!response.ok) {
    if (response.status === 409) throw new GitLabApprovalError('The merge request changed. Refresh and review the latest commit before approving.', 409)
    if (response.status === 401 || response.status === 403) {
      throw new GitLabApprovalError('GitLab denied approval access. Check the account permissions and token scope, or open the merge request in GitLab if re-authentication is required.', 403)
    }
    if (response.status === 404) throw new GitLabApprovalError('GitLab could not provide this merge request or its approval rules. Check project access and approval-rule support.', 404)
    if (response.status === 429) throw new GitLabApprovalError('GitLab is rate limiting requests. Try refreshing shortly.', 429)
    throw new GitLabApprovalError(`GitLab returned ${response.status}. Open the merge request in GitLab to check its approval requirements.`)
  }
  return { data: await response.json(), nextPage: response.headers.get('x-next-page') }
}

function projectPath(config) {
  return `/projects/${encodeURIComponent(config.project)}`
}

function publicUser(user) {
  if (!Number.isSafeInteger(user?.id) || !user.username) throw new GitLabApprovalError('GitLab did not identify the approving account.')
  return { id: user.id, name: user.name, username: user.username }
}

export function pendingApprovalRules(approvalState, approvals, userId) {
  if (!Array.isArray(approvalState?.rules) || !Array.isArray(approvals?.approved_by)) {
    throw new GitLabApprovalError('GitLab approval details are unavailable.')
  }
  if (approvals.user_has_approved === true || approvals.approved_by.some((entry) => entry.user?.id === userId)) return []
  if (approvals.user_can_approve === false) return []
  const normalRules = approvalState.rules.filter((rule) => rule.rule_type === 'any_approver' && rule.approvals_required > 0 && !rule.overridden)
  // The operator is the additional approver, after another user completes the normal approval.
  if (!normalRules.length || normalRules.some((rule) => rule.approved !== true)
    || !approvals.approved_by.some((entry) => Number.isSafeInteger(entry.user?.id) && entry.user.id !== userId)) return []
  return approvalState.rules.filter((rule) => rule.approved === false && rule.approvals_required > 0
    && !rule.overridden
    && rule.rule_type === 'regular'
    && /^Code Freeze Approval Rule(?:\s|$)/i.test(rule.name || '')
    && rule.eligible_approvers?.some((user) => user.id === userId))
}

async function approvalDetails(config, iid, signal) {
  const resource = `${projectPath(config)}/merge_requests/${iid}`
  const [state, approvals] = await Promise.all([
    requestGitLab(config, `${resource}/approval_state`, { signal }),
    requestGitLab(config, `${resource}/approvals`, { signal }),
  ])
  return { state: state.data, approvals: approvals.data }
}

function approvalBlockReason(mr) {
  if (mr.draft || mr.work_in_progress) return 'Draft — mark ready in GitLab before approving.'
  if (['checking', 'approvals_syncing'].includes(mr.detailed_merge_status)) return 'GitLab is processing the latest changes. Refresh shortly.'
  if (!/^[a-f0-9]{40,64}$/i.test(mr.sha || '')) return 'The latest commit is unavailable. Refresh shortly.'
  return undefined
}

function prepareDiffForReview(diffs, hasMorePages) {
  const maximumCharacters = 100000
  let content = ''
  let incomplete = hasMorePages || diffs.some((file) => file?.collapsed || file?.too_large)
  for (const file of diffs) {
    if (!file || typeof file.diff !== 'string' || !file.diff) continue
    const section = `diff --git a/${file.old_path || file.new_path} b/${file.new_path || file.old_path}\n${file.diff}\n`
    const remaining = maximumCharacters - content.length
    if (section.length > remaining) {
      content += section.slice(0, Math.max(0, remaining))
      incomplete = true
      break
    }
    content += section
  }
  return { content: content || '(No textual diff was available.)', incomplete }
}

async function aiReview(config, mr, signal) {
  const settings = aiReviewSettings()
  if (settings.error) return { status: 'unavailable', criticalSuggestions: [], reason: settings.error }
  const key = `${config.url}:${config.project}:${mr.iid}:${mr.sha}:${settings.provider}:${settings.model}`
  let cached = aiReviewCache.get(key)
  if (cached?.expiresAt && cached.expiresAt <= Date.now()) {
    aiReviewCache.delete(key)
    cached = undefined
  }
  let pending = cached?.promise
  if (!pending) {
    pending = (async () => {
      const query = new URLSearchParams({ page: '1', per_page: '100', unidiff: 'true' })
      const { data, nextPage } = await requestGitLab(config, `${projectPath(config)}/merge_requests/${mr.iid}/diffs?${query}`, { signal })
      if (!Array.isArray(data)) throw new GitLabApprovalError('GitLab returned an invalid merge request diff.')
      const prepared = prepareDiffForReview(data, Boolean(nextPage))
      return reviewChangesWithAI({ mr, diff: prepared.content, incomplete: prepared.incomplete, settings, signal })
    })()
    aiReviewCache.set(key, { promise: pending })
    if (aiReviewCache.size > 200) aiReviewCache.delete(aiReviewCache.keys().next().value)
  }
  try {
    return await pending
  } catch (error) {
    const unavailable = { status: 'unavailable', criticalSuggestions: [], reason: error instanceof Error ? `AI review unavailable: ${error.message}` : 'AI review unavailable.' }
    if (aiReviewCache.get(key)?.promise === pending) aiReviewCache.set(key, { promise: Promise.resolve(unavailable), expiresAt: Date.now() + 60000 })
    return unavailable
  }
}

async function listProjectApprovals(config, user, signal, mergeRequests, warnings, includeAiReview) {
  try {
    const seen = new Set()
    const targetBranches = config.targetBranches.length ? config.targetBranches : [undefined]
    for (const targetBranch of targetBranches) {
      let page = 1
      while (page) {
        const query = new URLSearchParams({ state: 'opened', scope: 'all', per_page: '100', page: String(page), order_by: 'created_at', sort: 'desc' })
        if (targetBranch) query.set('target_branch', targetBranch)
        const { data, nextPage } = await requestGitLab(config, `${projectPath(config)}/merge_requests?${query}`, { signal })
        if (!Array.isArray(data)) throw new GitLabApprovalError('GitLab returned an invalid merge request list.')
        const candidates = data.filter((mr) => !seen.has(mr.iid))
        candidates.forEach((mr) => seen.add(mr.iid))
        let index = 0
        // Bound concurrent requests while checking every page, including group approval rules.
        await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (index < candidates.length) {
            const mr = candidates[index++]
            if (mr.state !== 'opened' || (config.targetBranches.length && !config.targetBranches.includes(mr.target_branch))) continue
            try {
              const { state, approvals } = await approvalDetails(config, mr.iid, signal)
              const rules = pendingApprovalRules(state, approvals, user.id)
              if (!rules.length) continue
              const reason = approvalBlockReason(mr)
              const draft = Boolean(mr.draft || mr.work_in_progress)
              const review = includeAiReview && !draft
                ? await aiReview(config, mr, signal)
                : { status: 'skipped', criticalSuggestions: [], reason: draft ? 'AI review skipped while this merge request is a draft.' : 'AI review was not requested for this summary.' }
              mergeRequests.push({
                projectId: config.project,
                projectName: mr.references?.full?.replace(/!\d+$/, '') || `Project ${config.project}`,
                iid: mr.iid, title: mr.title, webUrl: mr.web_url, sha: mr.sha,
                author: mr.author?.name || mr.author?.username || 'Unknown author',
                sourceBranch: mr.source_branch, targetBranch: mr.target_branch, updatedAt: mr.updated_at,
                rules: rules.map((rule) => ({ name: rule.name, required: rule.approvals_required, approved: rule.approved_by?.length || 0 })),
                canApprove: !reason, reason, aiReview: review,
              })
            } catch (error) {
              warnings.push(`Project ${config.project} !${mr.iid}: ${error instanceof Error ? error.message : 'Approval status unavailable.'}`)
            }
          }
        }))
        const followingPage = nextPage === null ? (data.length === 100 ? page + 1 : 0) : Number(nextPage)
        if (!Number.isSafeInteger(followingPage) || followingPage < 0 || (followingPage && (followingPage <= page || !candidates.length))) {
          throw new GitLabApprovalError('GitLab pagination could not be completed.')
        }
        page = followingPage
      }
    }
  } catch (error) {
    warnings.push(`Project ${config.project}: ${error instanceof Error ? error.message : 'Unable to load GitLab approvals.'}`)
  }
}

export async function listGitLabApprovals({ includeAiReview = true } = {}) {
  let user
  let config
  const mergeRequests = []
  const warnings = []
  const signal = AbortSignal.timeout(60000)
  try {
    config = configuration()
    user = publicUser((await requestGitLab(config, '/user', { signal })).data)
    let index = 0
    await Promise.all(Array.from({ length: Math.min(2, config.projects.length) }, async () => {
      while (index < config.projects.length) {
        const project = config.projects[index++]
        await listProjectApprovals({ ...config, project }, user, signal, mergeRequests, warnings, includeAiReview)
      }
    }))
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'Unable to load GitLab approvals.')
  }
  mergeRequests.sort((a, b) => Number(a.projectId) - Number(b.projectId) || b.iid - a.iid)
  return {
    status: warnings.length ? (mergeRequests.length ? 'partial' : 'unknown') : 'available',
    user, projects: config?.projects ?? [], targetBranches: config?.targetBranches ?? [],
    mergeRequests, warnings, checkedAt: new Date().toISOString(),
  }
}

export async function getGitLabApprovalSummary() {
  const result = await listGitLabApprovals({ includeAiReview: false })
  return {
    status: result.status,
    pendingCount: result.mergeRequests.length,
    readyCount: result.mergeRequests.filter((mr) => mr.canApprove).length,
    draftCount: result.mergeRequests.filter((mr) => /^Draft\b/.test(mr.reason || '')).length,
    warnings: result.warnings,
    checkedAt: result.checkedAt,
  }
}

export async function approveGitLabMergeRequest(iid, { projectId, sha, userId } = {}) {
  if (!/^[1-9]\d*$/.test(String(iid)) || !/^[a-f0-9]{40,64}$/i.test(sha || '') || !Number.isSafeInteger(userId)) {
    throw new GitLabApprovalError('A valid merge request, reviewed commit, and approving account are required.', 400)
  }
  const settings = configuration()
  if (!settings.projects.includes(String(projectId))) throw new GitLabApprovalError('This project is not in GITLAB_APPROVAL_PROJECT_IDS. Refresh the list.', 403)
  const config = { ...settings, project: String(projectId) }
  const key = `${config.url}:${config.project}:${iid}`
  if (approvalLocks.has(key)) throw new GitLabApprovalError('An approval for this merge request is already in progress.', 409)
  approvalLocks.add(key)
  try {
    const signal = AbortSignal.timeout(30000)
    const user = publicUser((await requestGitLab(config, '/user', { signal })).data)
    if (user.id !== userId) throw new GitLabApprovalError('The approving account changed. Refresh before approving.', 409)
    const resource = `${projectPath(config)}/merge_requests/${iid}`
    const mr = (await requestGitLab(config, resource, { signal })).data
    if (mr.state !== 'opened') throw new GitLabApprovalError('This merge request is no longer open.', 409)
    if (config.targetBranches.length && !config.targetBranches.includes(mr.target_branch)) throw new GitLabApprovalError('This merge request is outside the configured release branches.', 409)
    if (mr.sha !== sha) throw new GitLabApprovalError('The merge request changed. Refresh and review the latest commit before approving.', 409)
    const blockReason = approvalBlockReason(mr)
    if (blockReason) throw new GitLabApprovalError(blockReason, 409)
    const { state, approvals } = await approvalDetails(config, iid, signal)
    if (!pendingApprovalRules(state, approvals, user.id).length) {
      throw new GitLabApprovalError('This merge request no longer needs approval from this account. Refresh the list.', 409)
    }
    const result = (await requestGitLab(config, `${resource}/approve`, { signal, body: { sha } })).data
    if (!result.approved_by?.some((entry) => entry.user?.id === user.id)) {
      throw new GitLabApprovalError('GitLab did not confirm the approval. Refresh to check the current status.')
    }
    return { status: 'approved', projectId: config.project, iid: Number(iid), sha, user }
  } finally {
    approvalLocks.delete(key)
  }
}

export async function readApprovalRequest(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new GitLabApprovalError('Expected a JSON approval request.', 400)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new GitLabApprovalError('Approval request is too large.', 413)
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
    return body
  } catch {
    throw new GitLabApprovalError('Invalid JSON approval request.', 400)
  }
}
