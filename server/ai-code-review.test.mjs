import assert from 'node:assert/strict'
import test from 'node:test'
import { aiReviewSettings, reviewChangesWithAI } from './ai-code-review.mjs'

const mr = { title: 'Release fix', source_branch: 'fix/release', target_branch: 'release/11.8.5', sha: 'a'.repeat(40) }
const settings = { provider: 'openai', providerName: 'OpenAI', endpoint: 'https://api.openai.com/v1/responses', apiKey: 'secret-key', model: 'review-model' }

test('requests a non-stored structured review and returns only critical suggestions', async () => {
  let sent
  const result = await reviewChangesWithAI({
    mr, diff: 'diff --git a/app.js b/app.js\n+danger()', incomplete: true, settings,
    request: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) }
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ criticalSuggestions: [{ title: 'Deletes production data', explanation: 'The new call deletes every tenant record.', file: 'app.js', line: 10 }] }) }] }] }) }
    },
  })
  assert.equal(sent.url, 'https://api.openai.com/v1/responses')
  assert.equal(sent.options.headers.Authorization, 'Bearer secret-key')
  assert.equal(sent.body.store, false)
  assert.equal(sent.body.text.format.type, 'json_schema')
  assert.match(sent.body.instructions, /high-confidence CRITICAL findings/)
  assert.deepEqual(result.criticalSuggestions, [{ title: 'Deletes production data', explanation: 'The new call deletes every tenant record.', file: 'app.js', line: 10 }])
  assert.equal(result.incomplete, true)
})

test('accepts a clean review and rejects malformed model output', async () => {
  const clean = await reviewChangesWithAI({
    mr, diff: '+safe()', settings,
    request: async () => ({ ok: true, json: async () => ({ status: 'completed', output_text: '{"criticalSuggestions":[]}' }) }),
  })
  assert.deepEqual(clean.criticalSuggestions, [])
  await assert.rejects(reviewChangesWithAI({
    mr, diff: '+unsafe()', settings,
    request: async () => ({ ok: true, json: async () => ({ status: 'completed', output_text: '{"criticalSuggestions":[{"title":"Maybe"}]}' }) }),
  }), /Invalid AI review/)
})

test('configures Groq automatically and uses its Responses endpoint', async (context) => {
  const names = ['AI_PROVIDER', 'AI_REVIEW_PROVIDER', 'AI_REVIEW_MODEL', 'GROQ_API_KEY', 'GROQ_REVIEW_MODEL', 'OPENAI_API_KEY']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  context.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]))
  names.forEach((name) => { delete process.env[name] })
  process.env.GROQ_API_KEY = 'groq-key'
  const groq = aiReviewSettings()
  assert.deepEqual(groq, {
    provider: 'groq', providerName: 'Groq', endpoint: 'https://api.groq.com/openai/v1/responses',
    apiKey: 'groq-key', model: 'openai/gpt-oss-120b',
  })
  let sent
  await reviewChangesWithAI({
    mr, diff: '+safe()', settings: groq,
    request: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) }
      return { ok: true, json: async () => ({ status: 'completed', output_text: '{"criticalSuggestions":[]}' }) }
    },
  })
  assert.equal(sent.url, 'https://api.groq.com/openai/v1/responses')
  assert.equal(sent.body.model, 'openai/gpt-oss-120b')
  assert.equal(sent.body.store, false)
  assert.equal(sent.body.text.verbosity, undefined)
  assert.equal(sent.body.text.format.strict, true)
})

test('rejects unsupported providers and identifies missing provider keys', (context) => {
  const names = ['AI_PROVIDER', 'AI_REVIEW_PROVIDER', 'GROQ_API_KEY', 'OPENAI_API_KEY']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  context.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]))
  names.forEach((name) => { delete process.env[name] })
  process.env.AI_REVIEW_PROVIDER = 'other'
  assert.match(aiReviewSettings().error, /either openai or groq/)
  process.env.AI_REVIEW_PROVIDER = 'groq'
  assert.match(aiReviewSettings().error, /GROQ_API_KEY/)
})

test('retries temporary rate limits using Retry-After', async () => {
  let requests = 0
  const waits = []
  const result = await reviewChangesWithAI({
    mr, diff: '+safe()', settings,
    request: async () => {
      requests += 1
      if (requests === 1) return {
        ok: false, status: 429, headers: { get: (name) => name === 'retry-after' ? '2' : null },
        json: async () => ({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' } }),
      }
      return { ok: true, json: async () => ({ status: 'completed', output_text: '{"criticalSuggestions":[]}' }) }
    },
    pause: async (milliseconds) => { waits.push(milliseconds) },
  })
  assert.equal(requests, 2)
  assert.deepEqual(waits, [2000])
  assert.equal(result.status, 'reviewed')
})

test('does not retry quota and billing rate-limit errors', async () => {
  let requests = 0
  await assert.rejects(reviewChangesWithAI({
    mr, diff: '+safe()', settings,
    request: async () => {
      requests += 1
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { code: 'credit_balance_exhausted' } }) }
    },
    pause: async () => { throw new Error('must not wait') },
  }), /credits are exhausted/)
  assert.equal(requests, 1)
})
