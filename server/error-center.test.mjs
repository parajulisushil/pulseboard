import assert from 'node:assert/strict'
import test from 'node:test'
import { apiRequest } from '../src/api.ts'
import { clearErrors, getErrors, recordError, recordResponseErrors } from '../src/errorCenter.ts'

test('collects TeamCity and other feature failures and groups repeated reports', () => {
  clearErrors()
  const result = { teamcity: { components: [{ label: 'Console', status: 'unknown', reason: 'TeamCity request timed out after 10 seconds', errorDetails: { type: 'Timeout', operation: 'Read pending changes', buildTypeId: 'Setup', branch: 'v1', timeoutMs: 10000, checkedAt: 'ignored' } }] } }
  recordResponseErrors('/api/integrations?release=v1', result)
  recordResponseErrors('/api/integrations?release=v1', result)
  recordResponseErrors('/api/infrastructure-status', { panels: [{ name: 'Host', status: 'unknown', reason: 'Unable to read status' }] })
  assert.equal(getErrors().length, 2)
  assert.equal(getErrors()[0].feature, 'Infrastructure')
  assert.equal(getErrors()[1].count, 2)
  assert.equal(getErrors()[1].details.Operation, 'Read pending changes')
  assert.equal(getErrors()[1].details.Configuration, 'Setup')
  assert.equal(getErrors()[1].details['Timeout (ms)'], 10000)
  assert.equal(getErrors()[1].details.Component, 'Console')
  assert.equal(getErrors()[1].details.checkedAt, undefined)
})

test('bounds history and clears it', () => {
  clearErrors()
  for (let i = 0; i < 105; i++) recordError({ feature: 'Dashboard', message: `Failure ${i}`, category: 'Error' })
  assert.equal(getErrors().length, 100)
  assert.equal(getErrors()[0].message, 'Failure 104')
  clearErrors()
  assert.deepEqual(getErrors(), [])
})


test('records HTTP failures across features with request IDs and without query parameters', async (context) => {
  clearErrors()
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'Unable to load jobs' }), { status: 503, headers: { 'X-Request-Id': 'request-123' } }))
  await assert.rejects(apiRequest('/api/scheduled-jobs?secret=hidden'), /Unable to load jobs/)
  assert.equal(getErrors()[0].feature, 'Scheduled jobs')
  assert.equal(getErrors()[0].details['Request ID'], 'request-123')
  assert.equal(getErrors()[0].details['HTTP status'], 503)
  assert.equal(getErrors()[0].details.Endpoint, '/api/scheduled-jobs')
  assert.doesNotMatch(JSON.stringify(getErrors()), /hidden/)
})

test('ignores intentional caller cancellation', async (context) => {
  clearErrors()
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.signal.aborted) throw options.signal.reason
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  })
  const controller = new AbortController()
  const request = apiRequest('/api/ad/users', { signal: controller.signal })
  controller.abort()
  await assert.rejects(request)
  assert.equal(getErrors().length, 0)
})
