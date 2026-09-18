import assert from 'node:assert/strict'
import test from 'node:test'
import { aiErrorSummarySettings, summarizeSqlErrorWithAI } from './ai-error-summary.mjs'

const settings = { provider: 'openai', providerName: 'OpenAI', endpoint: 'https://api.openai.com/v1/responses', apiKey: 'secret-key', model: 'summary-model' }
const server = { name: 'Dev-QC03' }
const error = { occurredAt: '2026-09-08T08:30:00.000Z', fields: { Message: 'Login failed', Source: 'PCD API' } }

test('summarizes the newest PCD error with a non-stored structured request', async () => {
  let sent
  const result = await summarizeSqlErrorWithAI({
    server, error, settings,
    request: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) }
      return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify({ summary: 'A login operation failed.', likelyCause: 'The supplied fields indicate an authentication failure.', suggestedAction: 'Check the relevant account and authentication logs.', confidence: 'medium' }) }) }
    },
  })
  assert.equal(sent.url, settings.endpoint)
  assert.equal(sent.options.headers.Authorization, 'Bearer secret-key')
  assert.equal(sent.body.store, false)
  assert.equal(sent.body.text.format.name, 'pcd_error_summary')
  assert.match(sent.body.instructions, /untrusted data/)
  assert.match(sent.body.input, /Message: Login failed/)
  assert.equal(result.status, 'available')
  assert.equal(result.confidence, 'medium')
  assert.equal(result.summary, 'A login operation failed.')
})

test('rejects malformed model output and requires explicit opt-in', async () => {
  await assert.rejects(summarizeSqlErrorWithAI({
    server, error, settings,
    request: async () => ({ ok: true, json: async () => ({ status: 'completed', output_text: '{"summary":"Too little data"}' }) }),
  }), /Invalid AI error summary/)
  assert.match(aiErrorSummarySettings({}).error, /disabled/)
})

test('caps source error data sent to the provider', async () => {
  let body
  const result = await summarizeSqlErrorWithAI({
    server, error: { fields: { Detail: 'x'.repeat(30000) } }, settings,
    request: async (_url, options) => {
      body = JSON.parse(options.body)
      return { ok: true, json: async () => ({ status: 'completed', output_text: JSON.stringify({ summary: 'Large error detail.', likelyCause: 'Unknown from the available data.', suggestedAction: 'Inspect the complete local exception.', confidence: 'low' }) }) }
    },
  })
  assert(body.input.length < 20200)
  assert.equal(result.incomplete, true)
})
