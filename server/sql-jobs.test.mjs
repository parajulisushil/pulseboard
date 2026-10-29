import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createScheduledJobManager, calculateNextRun } from './scheduled-jobs.mjs'

const input = () => ({ name: 'Orders', language: 'sql', scriptContent: 'select 1', schedule: { type: 'interval', minutes: 5 }, sql: { server: 'db.example', port: 1433, database: 'orders', username: 'reader', password: 'secret-password', webhookType: 'discord', webhookUrl: 'https://discord.com/api/webhooks/123/secret' } })
async function setup(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulseboard-sql-job-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'jobs.json')
  const now = new Date('2026-01-01T00:00:00Z')
  return { filePath, manager: createScheduledJobManager({ filePath, now: () => now, ...extra }) }
}
async function completed(manager) {
  for (let i = 0; i < 100; i++) { const [job] = await manager.list(); if (job.status !== 'running') return job; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('Job did not finish')
}

test('SQL secrets are never returned and are preserved on edits', async (t) => {
  const { manager, filePath } = await setup(t)
  const created = await manager.create(input())
  assert.equal(created.nextRunAt, '2026-01-01T00:05:00.000Z')
  for (const visible of [created, await manager.get(created.id), ...(await manager.list())]) {
    assert.equal(visible.sql.password, undefined); assert.equal(visible.sql.webhookUrl, undefined)
    assert.equal(visible.sql.hasPassword, true); assert.equal(visible.sql.hasWebhook, true)
  }
  const updated = input(); updated.sql.password = ''; updated.sql.webhookUrl = ''; updated.name = 'Edited'
  await manager.update(created.id, updated)
  const stored = JSON.parse(await readFile(filePath, 'utf8')).jobs[0]
  assert.equal(stored.sql.password, 'secret-password'); assert.equal(stored.sql.webhookUrl, input().sql.webhookUrl)
  assert.equal(calculateNextRun({ type: 'manual' }), null)
  const invalid = input(); invalid.sql.webhookUrl = 'https://example.com/api/webhooks/123/secret'
  await assert.rejects(manager.create(invalid), { status: 400 })
})

test('SQL runs are bounded, sent to Discord, and intervals resume after completion', async (t) => {
  let sent; let config
  const { manager } = await setup(t, {
    createSqlPool: (value) => { config = value; return { connect: async () => {}, close: async () => {}, request: () => {
      const request = new EventEmitter(); request.query = async () => { request.emit('recordset', { id: {} }); for (let i = 0; i < 105; i++) request.emit('row', { id: i }); return { rowsAffected: [] } }; return request
    } } },
    fetch: async (url, options) => { sent = { url, ...options }; return { ok: true } },
  })
  const job = await manager.create(input()); await manager.runNow(job.id)
  const result = await completed(manager)
  assert.equal(result.lastStatus, 'success'); assert.match(result.lastOutput, /105 row\(s\).*limited/)
  assert.equal(result.nextRunAt, '2026-01-01T00:05:00.000Z'); assert.equal(config.password, 'secret-password')
  assert.equal(sent.url, input().sql.webhookUrl); assert.match(JSON.parse(sent.body).content, /SQL job: Orders/)
  assert.deepEqual(JSON.parse(sent.body).allowed_mentions, { parse: [] })
})

test('webhook failures keep query output and report delivery failure', async (t) => {
  const { manager } = await setup(t, {
    createSqlPool: () => ({ connect: async () => {}, close: async () => {}, request: () => { const request = new EventEmitter(); request.query = async () => { request.emit('recordset', { answer: {} }); request.emit('row', { answer: 42 }); return {} }; return request } }),
    fetch: async () => ({ ok: false }),
  })
  const job = await manager.create(input()); await manager.runNow(job.id)
  const result = await completed(manager)
  assert.equal(result.lastStatus, 'failed'); assert.match(result.lastOutput, /42/); assert.match(result.lastError, /webhook delivery failed/)
})
