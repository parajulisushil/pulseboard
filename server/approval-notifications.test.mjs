import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { approvalNotificationSettings, createApprovalNotifier } from './approval-notifications.mjs'

const env = { CODE_FREEZE_APPLIED: 'true', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token', PULSEBOARD_PUBLIC_URL: 'https://pulse.example.com', DISCORD_APPROVAL_USER_ID: '123456789012345678' }
const mr = { projectId: '21', iid: 1, sha: 'a'.repeat(40), canApprove: true, projectName: 'Release', title: '@everyone fix' }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'approval-alerts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const state = { result: { status: 'available', user: { id: 7 }, mergeRequests: [mr] }, ok: true, calls: [], logs: [], checks: 0 }
  const options = {
    filePath: path.join(directory, 'state.json'), settings: () => approvalNotificationSettings(env),
    listApprovals: async (options) => { assert.equal(options.includeAiReview, false); state.checks++; return state.result },
    fetchImpl: async (url, request) => { state.calls.push({ url, body: JSON.parse(request.body) }); return { ok: state.ok, status: state.ok ? 200 : 429 } },
    audit: (event, details) => state.logs.push({ event, details }),
  }
  return { state, options, monitor: createApprovalNotifier(options) }
}

test('configuration requires a valid webhook and phone origin only during freeze', () => {
  assert.deepEqual(approvalNotificationSettings({}), { enabled: false })
  const config = approvalNotificationSettings(env)
  assert.equal(new URL(config.webhook).searchParams.get('wait'), 'true')
  assert.equal(config.intervalSeconds, 60)
  for (const invalid of [{ DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1/token' }, { PULSEBOARD_PUBLIC_URL: 'javascript:alert(1)' }, { PULSEBOARD_PUBLIC_URL: 'https://user:pass@example.com' }, { GITLAB_APPROVAL_POLL_SECONDS: '0' }, { DISCORD_APPROVAL_USER_ID: 'everyone' }]) {
    assert.throws(() => approvalNotificationSettings({ ...env, ...invalid }))
  }
})

test('notifies with a direct link, preserves deduplication across restart and re-alerts for a new commit', async (t) => {
  const { state, options, monitor } = await fixture(t)
  await Promise.all([monitor.tick(), monitor.tick()])
  assert.equal(state.checks, 1)
  assert.equal(state.calls.length, 1)
  assert.match(state.calls[0].body.content, /https:\/\/pulse.example.com\/approvals#mr-21-1/)
  assert.deepEqual(state.calls[0].body.allowed_mentions, { parse: [], users: [env.DISCORD_APPROVAL_USER_ID] })
  await createApprovalNotifier(options).tick()
  assert.equal(state.calls.length, 1)
  state.result.mergeRequests = [{ ...mr, sha: 'b'.repeat(40) }, { ...mr, projectId: '22' }]
  await monitor.tick()
  assert.equal(state.calls.length, 3)
})

test('failed sends retry and partial GitLab results do not erase notification history', async (t) => {
  const { state, monitor } = await fixture(t)
  state.ok = false
  await monitor.tick()
  assert.equal(state.logs[0].event, 'approval_notification_failed')
  state.ok = true
  await monitor.tick()
  state.result = { ...state.result, status: 'partial', mergeRequests: [] }
  await monitor.tick()
  state.result = { ...state.result, status: 'available', mergeRequests: [mr] }
  await monitor.tick()
  assert.equal(state.calls.length, 2)
})

test('drafts wait until ready; requests that leave and return can alert again', async (t) => {
  const { state, monitor } = await fixture(t)
  state.result.mergeRequests = [{ ...mr, canApprove: false }]
  await monitor.tick()
  assert.equal(state.calls.length, 0)
  state.result.mergeRequests = [mr]
  await monitor.tick()
  state.result.mergeRequests = [{ ...mr, canApprove: false }]
  await monitor.tick()
  state.result.mergeRequests = [mr]
  await monitor.tick()
  assert.equal(state.calls.length, 1)
  state.result.mergeRequests = []
  await monitor.tick()
  state.result.mergeRequests = [mr]
  await monitor.tick()
  assert.equal(state.calls.length, 2)
})

test('disabled monitoring does no work; corrupt state prevents sending', async (t) => {
  const { state, options, monitor } = await fixture(t)
  await createApprovalNotifier({ ...options, settings: () => ({ enabled: false }) }).tick()
  assert.equal(state.checks, 0)
  await writeFile(options.filePath, 'invalid json')
  await monitor.tick()
  assert.equal(state.calls.length, 0)
  assert.equal(state.logs[0].event, 'approval_notification_failed')
})
