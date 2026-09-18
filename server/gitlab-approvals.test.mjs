import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { approveGitLabMergeRequest, getGitLabApprovalSummary, listGitLabApprovals, pendingApprovalRules } from './gitlab-approvals.mjs'
import { api } from './index.mjs'

const sha = 'a'.repeat(40)
const user = { id: 7, username: 'release-owner', name: 'Release Owner' }
const mr = { iid: 1, project_id: 21, title: 'Release fix', state: 'opened', sha, source_branch: 'fix/release', target_branch: 'release/11.8.5', author: { name: 'Developer' }, web_url: 'https://gitlab.example.com/release/-/merge_requests/1' }
const rule = { id: 1, name: 'Code Freeze Approval Rule 11.8.5.0', approved: false, approvals_required: 1, approved_by: [], eligible_approvers: [user], rule_type: 'regular' }
const firstApprover = { id: 8, username: 'first-reviewer' }
const normalRule = { id: 2, name: 'Minimum required approvals', rule_type: 'any_approver', approvals_required: 1, approved: true, approved_by: [firstApprover] }
const ruleState = (...rules) => ({ rules: [normalRule, ...rules] })
const approvals = { approved_by: [{ user: firstApprover }], user_can_approve: true }

async function fakeGitLab(context, respond) {
  const previous = Object.fromEntries(['GITLAB_URL', 'GITLAB_TOKEN', 'GITLAB_APPROVAL_TOKEN', 'GITLAB_PROJECT_ID', 'GITLAB_APPROVAL_PROJECT_IDS', 'GITLAB_APPROVAL_TARGET_BRANCH', 'AI_PROVIDER', 'AI_REVIEW_PROVIDER', 'AI_REVIEW_MODEL', 'OPENAI_API_KEY', 'OPENAI_REVIEW_MODEL', 'GROQ_API_KEY', 'GROQ_REVIEW_MODEL'].map((name) => [name, process.env[name]]))
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const call = { method: request.method, url: new URL(request.url, 'http://localhost'), token: request.headers['private-token'], body: body ? JSON.parse(body) : undefined }
    calls.push(call)
    try {
      const result = await respond(call)
      response.writeHead(result?.status || 200, { 'Content-Type': 'application/json', ...result?.headers })
      response.end(JSON.stringify(result?.body ?? {}))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  process.env.GITLAB_URL = `http://127.0.0.1:${server.address().port}`
  process.env.GITLAB_TOKEN = 'pipeline-token'
  process.env.GITLAB_APPROVAL_TOKEN = 'approval-token'
  process.env.GITLAB_PROJECT_ID = '999'
  process.env.GITLAB_APPROVAL_PROJECT_IDS = '21'
  delete process.env.GITLAB_APPROVAL_TARGET_BRANCH
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_REVIEW_MODEL
  delete process.env.AI_PROVIDER
  delete process.env.AI_REVIEW_PROVIDER
  delete process.env.AI_REVIEW_MODEL
  delete process.env.GROQ_API_KEY
  delete process.env.GROQ_REVIEW_MODEL
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    for (const [name, original] of Object.entries(previous)) {
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
  })
  return calls
}

function defaultResponse(call) {
  if (call.url.pathname === '/api/v4/user') return { body: user }
  if (call.url.pathname.endsWith('/approval_state')) return { body: ruleState(rule) }
  if (call.url.pathname.endsWith('/approvals')) return { body: approvals }
  if (call.url.pathname.endsWith('/approve')) return { body: { approved_by: [{ user }] } }
  if (call.url.pathname.endsWith('/merge_requests')) return { body: [mr], headers: { 'X-Next-Page': '' } }
  return { body: mr }
}

test('requires an outstanding eligible rule and excludes already approved or disallowed users', () => {
  assert.equal(pendingApprovalRules(ruleState(rule), approvals, user.id).length, 1)
  for (const changed of [{ approved: true }, { approvals_required: 0 }, { eligible_approvers: [{ id: 8 }] }, { overridden: true }]) {
    assert.deepEqual(pendingApprovalRules(ruleState({ ...rule, ...changed }), approvals, user.id), [])
  }
  assert.deepEqual(pendingApprovalRules(ruleState(rule), { ...approvals, approved_by: [{ user }] }, user.id), [])
  assert.deepEqual(pendingApprovalRules(ruleState(rule), { ...approvals, user_can_approve: false }, user.id), [])
  assert.equal(pendingApprovalRules(ruleState({ ...rule, rule_type: 'any_approver', eligible_approvers: [] }), approvals, user.id).length, 0)
  assert.throws(() => pendingApprovalRules({}, approvals, user.id), /unavailable/)
})

test('only lists Code Freeze rules after another user completes normal approval', () => {
  assert.deepEqual(pendingApprovalRules(ruleState(), approvals, user.id), [])
  assert.deepEqual(pendingApprovalRules({ rules: [rule] }, approvals, user.id), [])
  assert.deepEqual(pendingApprovalRules({ rules: [{ ...normalRule, approved: false }, rule] }, approvals, user.id), [])
  assert.deepEqual(pendingApprovalRules(ruleState(rule), { ...approvals, approved_by: [] }, user.id), [])
  assert.deepEqual(pendingApprovalRules(ruleState({ ...rule, name: 'Security review' }), approvals, user.id), [])
  assert.equal(pendingApprovalRules(ruleState({ ...rule, name: 'Code Freeze Approval Rule' }), approvals, user.id).length, 1)
  assert.equal(pendingApprovalRules(ruleState({ ...rule, name: 'code freeze approval rule 11.8.4.0' }), approvals, user.id).length, 1)
})

test('lists matching MR numbers from multiple projects without mixing them', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  process.env.GITLAB_APPROVAL_PROJECT_IDS = '21, 22,21'
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'available')
  assert.deepEqual(result.projects, ['21', '22'])
  assert.deepEqual(result.mergeRequests.map((item) => [item.projectId, item.iid]), [['21', 1], ['22', 1]])
  const approved = await approveGitLabMergeRequest(1, { projectId: '22', sha, userId: user.id })
  assert.equal(approved.projectId, '22')
  assert.equal(calls.filter((call) => call.method === 'POST')[0].url.pathname, '/api/v4/projects/22/merge_requests/1/approve')
  assert.equal(calls.some((call) => call.url.pathname.includes('/projects/999/')), false)
})

test('continues checking other projects when one project is unavailable', async (context) => {
  await fakeGitLab(context, (call) => call.url.pathname.includes('/projects/21/') ? { status: 403 } : defaultResponse(call))
  process.env.GITLAB_APPROVAL_PROJECT_IDS = '21,22'
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.mergeRequests.map((item) => item.projectId), ['22'])
  assert.match(result.warnings[0], /Project 21/)
})

test('rejects unconfigured projects and invalid project configuration without contacting GitLab', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  await assert.rejects(approveGitLabMergeRequest(1, { projectId: '999', sha, userId: user.id }), /not in GITLAB_APPROVAL_PROJECT_IDS/)
  await assert.rejects(approveGitLabMergeRequest(1, { sha, userId: user.id }), /not in GITLAB_APPROVAL_PROJECT_IDS/)
  for (const projects of ['', '21,not-an-id', '21,', '0']) {
    process.env.GITLAB_APPROVAL_PROJECT_IDS = projects
    const result = await listGitLabApprovals()
    assert.equal(result.status, 'unknown')
  }
  assert.equal(calls.length, 0)
})

test('lists every page, including group eligibility, with drafts visible but disabled', async (context) => {
  const calls = await fakeGitLab(context, (call) => {
    if (call.url.pathname.endsWith('/merge_requests')) {
      const secondPage = call.url.searchParams.get('page') === '2'
      return { body: secondPage ? [{ ...mr, iid: 3, draft: true }] : [mr, { ...mr, iid: 2 }], headers: { 'X-Next-Page': secondPage ? '' : '2' } }
    }
    if (call.url.pathname.endsWith('/2/approvals')) return { body: { approved_by: [{ user }] } }
    // Group members appear in eligible_approvers even when the explicit users list is empty.
    if (call.url.pathname.endsWith('/approval_state')) return { body: ruleState({ ...rule, users: [], groups: [{ id: 99 }] }) }
    return defaultResponse(call)
  })
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'available')
  assert.deepEqual(result.mergeRequests.map((item) => item.iid), [3, 1])
  assert.equal(result.mergeRequests[0].canApprove, false)
  assert.match(result.mergeRequests[0].reason, /Draft/)
  assert.equal(result.mergeRequests[1].canApprove, true)
  assert.deepEqual(result.user, user)
  assert(calls.every((call) => call.token === 'approval-token'))
  assert(calls.some((call) => call.url.pathname.includes('21')))
  assert.equal(JSON.stringify(result).includes('approval-token'), false)
})

test('skips AI review and diff retrieval for draft merge requests', async (context) => {
  const calls = await fakeGitLab(context, (call) => {
    if (call.url.pathname.endsWith('/merge_requests')) return { body: [{ ...mr, draft: true }], headers: { 'X-Next-Page': '' } }
    return defaultResponse(call)
  })
  process.env.AI_REVIEW_PROVIDER = 'groq'
  process.env.GROQ_API_KEY = 'unused-for-draft'
  const result = await listGitLabApprovals()
  assert.equal(result.mergeRequests[0].aiReview.status, 'skipped')
  assert.match(result.mergeRequests[0].aiReview.reason, /draft/i)
  assert.equal(calls.some((call) => call.url.pathname.endsWith('/diffs')), false)
})

test('returns approval counts without requesting AI review diffs', async (context) => {
  const calls = await fakeGitLab(context, (call) => {
    if (call.url.pathname.endsWith('/merge_requests')) return { body: [mr, { ...mr, iid: 2, draft: true }], headers: { 'X-Next-Page': '' } }
    return defaultResponse(call)
  })
  process.env.AI_REVIEW_PROVIDER = 'groq'
  process.env.GROQ_API_KEY = 'unused-for-summary'
  const result = await getGitLabApprovalSummary()
  assert.deepEqual({ pendingCount: result.pendingCount, readyCount: result.readyCount, draftCount: result.draftCount }, { pendingCount: 2, readyCount: 1, draftCount: 1 })
  assert.equal(calls.some((call) => call.url.pathname.endsWith('/diffs')), false)
})

test('falls back to the monitoring token and filters the optional target branch', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  delete process.env.GITLAB_APPROVAL_TOKEN
  process.env.GITLAB_APPROVAL_TARGET_BRANCH = 'release/11.8.5'
  const result = await listGitLabApprovals()
  assert.equal(result.mergeRequests.length, 1)
  assert.deepEqual(result.targetBranches, ['release/11.8.5'])
  assert.equal(calls.find((call) => call.url.pathname.endsWith('/merge_requests')).url.searchParams.get('target_branch'), 'release/11.8.5')
  assert(calls.every((call) => call.token === 'pipeline-token'))
})

test('lists comma-separated target branches once each', async (context) => {
  const calls = await fakeGitLab(context, (call) => {
    if (call.url.pathname.endsWith('/merge_requests')) {
      const targetBranch = call.url.searchParams.get('target_branch')
      return { body: [{ ...mr, iid: targetBranch === 'release/11.8.6' ? 2 : 1, target_branch: targetBranch }], headers: { 'X-Next-Page': '' } }
    }
    return defaultResponse(call)
  })
  process.env.GITLAB_APPROVAL_TARGET_BRANCH = 'release/11.8.5, release/11.8.6,release/11.8.5'
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'available')
  assert.deepEqual(result.targetBranches, ['release/11.8.5', 'release/11.8.6'])
  assert.deepEqual(result.mergeRequests.map((item) => [item.iid, item.targetBranch]), [[2, 'release/11.8.6'], [1, 'release/11.8.5']])
  assert.deepEqual(calls.filter((call) => call.url.pathname.endsWith('/merge_requests')).map((call) => call.url.searchParams.get('target_branch')), ['release/11.8.5', 'release/11.8.6'])
})

test('reports incomplete checks without claiming the approval queue is empty', async (context) => {
  await fakeGitLab(context, (call) => {
    if (call.url.pathname.endsWith('/merge_requests')) return { body: [mr, { ...mr, iid: 2 }], headers: { 'X-Next-Page': '' } }
    if (call.url.pathname.endsWith('/2/approval_state')) return { status: 403 }
    return defaultResponse(call)
  })
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.mergeRequests.map((item) => item.iid), [1])
  assert.match(result.warnings[0], /!2:.*denied/)
})

test('reports unavailable credentials instead of an empty successful queue', async (context) => {
  await fakeGitLab(context, () => ({ status: 401 }))
  const result = await listGitLabApprovals()
  assert.equal(result.status, 'unknown')
  assert.match(result.warnings[0], /denied/)
  assert.equal(result.user, undefined)
})

test('submits only an approval for the reviewed SHA and verifies the approving account', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  const result = await approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id })
  assert.equal(result.status, 'approved')
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => ({ path: call.url.pathname, body: call.body })), [{ path: '/api/v4/projects/21/merge_requests/1/approve', body: { sha } }])
})

test('approves a request targeting any configured release branch', async (context) => {
  const calls = await fakeGitLab(context, (call) => call.url.pathname.endsWith('/merge_requests/1')
    ? { body: { ...mr, target_branch: 'release/11.8.6' } }
    : defaultResponse(call))
  process.env.GITLAB_APPROVAL_TARGET_BRANCH = 'release/11.8.5,release/11.8.6'
  const result = await approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id })
  assert.equal(result.status, 'approved')
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

for (const scenario of [
  { name: 'changed commit', response: { ...mr, sha: 'b'.repeat(40) }, message: /changed/ },
  { name: 'closed request', response: { ...mr, state: 'closed' }, message: /no longer open/ },
  { name: 'draft request', response: { ...mr, draft: true }, message: /Draft/ },
  { name: 'approval processing', response: { ...mr, detailed_merge_status: 'approvals_syncing' }, message: /processing/ },
  { name: 'different account', path: '/user', response: { ...user, id: 8 }, message: /account changed/ },
  { name: 'already approved request', path: '/approvals', response: { approved_by: [{ user }] }, message: /no longer needs/ },
  { name: 'satisfied rule', path: '/approval_state', response: ruleState({ ...rule, approved: true }), message: /no longer needs/ },
  { name: 'ineligible user', path: '/approval_state', response: ruleState({ ...rule, eligible_approvers: [{ id: 8 }] }), message: /no longer needs/ },
  { name: 'removed first approval', path: '/approvals', response: { ...approvals, approved_by: [] }, message: /no longer needs/ },
  { name: 'incomplete normal approval', path: '/approval_state', response: { rules: [{ ...normalRule, approved: false }, rule] }, message: /no longer needs/ },
  { name: 'removed Code Freeze rule', path: '/approval_state', response: ruleState(), message: /no longer needs/ },
]) {
  test(`does not submit approval for a ${scenario.name}`, async (context) => {
    const calls = await fakeGitLab(context, (call) => call.url.pathname.endsWith(scenario.path || '/merge_requests/1') ? { body: scenario.response } : defaultResponse(call))
    await assert.rejects(approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id }), scenario.message)
    assert.equal(calls.some((call) => call.method === 'POST'), false)
  })
}

test('rejects requests outside the configured release branch', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  process.env.GITLAB_APPROVAL_TARGET_BRANCH = 'different-release'
  await assert.rejects(approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id }), /outside/)
  assert.equal(calls.some((call) => call.method === 'POST'), false)
})

test('handles GitLab rejecting a commit that changed during approval', async (context) => {
  await fakeGitLab(context, (call) => call.method === 'POST' ? { status: 409 } : defaultResponse(call))
  await assert.rejects(approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id }), (error) => error.status === 409 && /changed/.test(error.message))
})

test('blocks duplicate submissions and releases the lock after completion', async (context) => {
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const entered = new Promise((resolve) => { started = resolve })
  const calls = await fakeGitLab(context, async (call) => {
    if (call.method === 'POST') { started(); await gate }
    return defaultResponse(call)
  })
  const first = approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id })
  try {
    await entered
    await assert.rejects(approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id }), /already in progress/)
  } finally { release() }
  await first
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
  await approveGitLabMergeRequest(1, { projectId: '21', sha, userId: user.id })
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2)
})

test('approval routes require authentication, request verification, and a valid review payload', async (context) => {
  const calls = await fakeGitLab(context, defaultResponse)
  const previous = { AUTH_MODE: process.env.AUTH_MODE, DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME, DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD }
  process.env.AUTH_MODE = 'basic'
  process.env.DASHBOARD_USERNAME = 'operator'
  process.env.DASHBOARD_PASSWORD = 'test-password-long-enough'
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  context.after(async () => {
    await new Promise((resolve) => api.close(resolve))
    for (const [name, original] of Object.entries(previous)) {
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
  })
  const base = `http://127.0.0.1:${api.address().port}`
  const headers = { Authorization: `Basic ${Buffer.from('operator:test-password-long-enough').toString('base64')}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${base}/api/gitlab/approvals`)).status, 401)
  const endpoint = `${base}/api/gitlab/merge-requests/1/approve`
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401)
  assert.equal((await fetch(endpoint, { method: 'POST', headers })).status, 403)
  headers['X-Pulseboard-Request'] = '1'
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'invalid' })).status, 400)
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status, 400)
  assert.equal(calls.length, 0)
  const list = await fetch(`${base}/api/gitlab/approvals`, { headers })
  assert.equal((await list.json()).mergeRequests.length, 1)
  const summary = await fetch(`${base}/api/gitlab/approval-summary`, { headers })
  assert.deepEqual(Object.fromEntries(Object.entries(await summary.json()).filter(([key]) => ['pendingCount', 'readyCount', 'draftCount'].includes(key))), { pendingCount: 1, readyCount: 1, draftCount: 0 })
  const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ projectId: '21', sha, userId: user.id }) })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).status, 'approved')
})
