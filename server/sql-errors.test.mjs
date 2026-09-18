import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqlErrorReader, mapRecentSqlError, mapRecentSqlErrors, recentSqlErrorQuery, sqlErrorChecksEnabled, sqlErrorLimit } from './sql-errors.mjs'

const server = { name: 'Dev-QC03', ip: '172.31.33.96', group: 'Test machines' }
const enabled = {
  SQL_ERROR_CHECKS_ENABLED: 'true', SQL_USERNAME: 'readonly-user', SQL_PASSWORD: 'private-password',
  SQL_PCD_DATABASE: 'PCD', SQL_PORT: '1433', SQL_ENCRYPT: 'true', SQL_TRUST_SERVER_CERTIFICATE: 'false',
}

function fixture({ env = enabled, rows = [{ Id: 22, ErrorDate: new Date('2026-09-08T08:30:00Z'), Message: 'Latest error' }], queryError } = {}) {
  const calls = { configs: [], queries: [], connects: 0, closes: 0 }
  const reader = createSqlErrorReader({
    env, now: () => new Date('2026-09-08T09:00:00Z'),
    createPool: (config) => {
      calls.configs.push(config)
      return {
        async connect() { calls.connects++ },
        request() { return { query: async (query) => { calls.queries.push(query); if (queryError) throw queryError; return { recordset: rows || [] } } } },
        async close() { calls.closes++ },
      }
    },
  })
  return { reader, calls }
}

test('reads five recent PCD exceptions by default with a bounded read-only query', async () => {
  const { reader, calls } = fixture()
  const result = await reader(server)
  assert.equal(result.status, 'available')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].occurredAt, '2026-09-08T08:30:00.000Z')
  assert.equal(result.errors[0].fields.Message, 'Latest error')
  assert.deepEqual(calls.queries, ['SELECT TOP (5) * FROM tbl_ex_exceptionloginfo ORDER BY 1 DESC'])
  assert.equal(recentSqlErrorQuery(enabled), calls.queries[0])
  assert.equal(calls.configs[0].server, server.ip)
  assert.equal(calls.configs[0].database, 'PCD')
  assert.equal(calls.configs[0].options.readOnlyIntent, true)
  assert.equal(calls.configs[0].options.encrypt, true)
  assert.equal(calls.configs[0].options.trustServerCertificate, false)
  assert.equal(calls.connects, 1)
  assert.equal(calls.closes, 1)
  assert(!JSON.stringify(result).includes('private-password'))
})

test('uses per-machine SQL hostname before a shared hostname or inventory IP', async () => {
  const machine = fixture({ env: { ...enabled, SQL_SERVER: 'shared.test', SQL_SERVER_DEV_QC03: 'qc03-db.test' } })
  await machine.reader(server)
  assert.equal(machine.calls.configs[0].server, 'qc03-db.test')
  const shared = fixture({ env: { ...enabled, SQL_SERVER: 'shared.test' } })
  await shared.reader(server)
  assert.equal(shared.calls.configs[0].server, 'shared.test')
})

test('reports disabled, incomplete, invalid, empty, and failed checks without exposing diagnostics', async () => {
  for (const env of [{}, { SQL_ERROR_CHECKS_ENABLED: 'false' }, { SQL_ERROR_CHECKS_ENABLED: 'true' }, { ...enabled, SQL_PORT: 'bad' }, { ...enabled, SQL_ENCRYPT: 'maybe' }, { ...enabled, SQL_ERROR_LIMIT: '51' }]) {
    const { reader, calls } = fixture({ env })
    const result = await reader(server)
    assert.equal(result.status, 'unavailable')
    assert.equal(calls.connects, 0)
  }
  const empty = fixture({ rows: [] })
  assert.equal((await empty.reader(server)).status, 'empty')
  assert.equal(empty.calls.closes, 1)
  const failed = fixture({ queryError: new Error('private SQL diagnostic private-password') })
  const result = await failed.reader(server)
  assert.equal(result.status, 'unavailable')
  assert(!JSON.stringify(result).includes('private'))
  assert.equal(failed.calls.closes, 1)
})

test('configures the recent error count from 1 to 50 and maps every returned row', async () => {
  const rows = [
    { Id: 3, ErrorDate: new Date('2026-09-08T08:30:00Z'), Message: 'Newest' },
    { Id: 2, ErrorDate: new Date('2026-09-08T08:20:00Z'), Message: 'Previous' },
    { Id: 1, ErrorDate: new Date('2026-09-08T08:10:00Z'), Message: 'Oldest' },
  ]
  const configured = fixture({ env: { ...enabled, SQL_ERROR_LIMIT: '3' }, rows })
  const result = await configured.reader(server)
  assert.equal(result.errors.length, 3)
  assert.deepEqual(result.errors.map((error) => error.fields.Message), ['Newest', 'Previous', 'Oldest'])
  assert.deepEqual(configured.calls.queries, ['SELECT TOP (3) * FROM tbl_ex_exceptionloginfo ORDER BY 1 DESC'])
  assert.equal(sqlErrorLimit({}), 5)
  assert.equal(sqlErrorLimit({ SQL_ERROR_LIMIT: '1' }), 1)
  assert.equal(sqlErrorLimit({ SQL_ERROR_LIMIT: '50' }), 50)
  for (const value of ['0', '51', '1.5', 'invalid']) assert.throws(() => sqlErrorLimit({ SQL_ERROR_LIMIT: value }), /whole number from 1 to 50/)
  assert.equal(mapRecentSqlErrors([], new Date('2026-09-08T09:00:00Z')).status, 'empty')
})

test('maps dates, nulls, big integers, binary data, long values, and configured time columns safely', () => {
  const fields = { Id: 4n, Happened: 'not a date', CustomWhen: '2026-09-08T08:00:00Z', Empty: null, Data: Buffer.alloc(8), Detail: 'x'.repeat(5000) }
  const mapped = mapRecentSqlError(fields, new Date('2026-09-08T09:00:00Z'), 'customwhen')
  assert.equal(mapped.occurredAt, '2026-09-08T08:00:00.000Z')
  assert.equal(mapped.fields.Id, '4')
  assert.equal(mapped.fields.Empty, null)
  assert.equal(mapped.fields.Data, '[binary value omitted: 8 bytes]')
  assert.equal(mapped.fields.Detail.length, 4000)
  assert.match(mapRecentSqlError({ Id: 1 }).reason, /No date\/time column/)
  assert.match(mapRecentSqlError({ Id: 1, CustomWhen: 'not a date' }, new Date(), 'CustomWhen').reason, /configured time column/)
  assert.equal(sqlErrorChecksEnabled(enabled), true)
  assert.equal(sqlErrorChecksEnabled({}), false)
})

test('adds an AI summary for only the newest error without hiding raw errors when summary generation fails', async () => {
  const rows = [
    { Id: 2, ErrorDate: new Date('2026-09-08T08:30:00Z'), Message: 'Newest' },
    { Id: 1, ErrorDate: new Date('2026-09-08T08:20:00Z'), Message: 'Older' },
  ]
  const calls = []
  const reader = createSqlErrorReader({
    env: { ...enabled, AI_ERROR_SUMMARIES_ENABLED: 'true' },
    now: () => new Date('2026-09-08T09:00:00Z'),
    createPool: () => ({ async connect() {}, request: () => ({ query: async () => ({ recordset: rows }) }), async close() {} }),
    summarizeTopError: async (machine, topError) => {
      calls.push({ machine, topError })
      return { status: 'available', summary: 'Newest error summarized.' }
    },
  })
  const result = await reader(server)
  assert.equal(result.errors.length, 2)
  assert.equal(result.aiSummary.summary, 'Newest error summarized.')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].topError.fields.Message, 'Newest')

  const failedReader = createSqlErrorReader({
    env: { ...enabled, AI_ERROR_SUMMARIES_ENABLED: 'true' },
    createPool: () => ({ async connect() {}, request: () => ({ query: async () => ({ recordset: rows }) }), async close() {} }),
    summarizeTopError: async () => { throw new Error('secret provider detail') },
  })
  const failed = await failedReader(server)
  assert.equal(failed.status, 'available')
  assert.equal(failed.errors.length, 2)
  assert.deepEqual(failed.aiSummary, { status: 'unavailable', reason: 'AI summary unavailable.' })
})
