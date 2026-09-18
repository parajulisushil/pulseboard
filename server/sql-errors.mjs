import mssql from 'mssql'
import { cachedSqlErrorSummary } from './ai-error-summary.mjs'

const { ConnectionPool } = mssql

const DEFAULT_ERROR_LIMIT = 5
const MAX_ERROR_LIMIT = 50
const MAX_FIELDS = 30
const MAX_VALUE_LENGTH = 4000

function booleanSetting(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

export function sqlErrorLimit(env = process.env) {
  const limit = Number(env.SQL_ERROR_LIMIT || DEFAULT_ERROR_LIMIT)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ERROR_LIMIT) throw new Error(`SQL_ERROR_LIMIT must be a whole number from 1 to ${MAX_ERROR_LIMIT}.`)
  return limit
}

export function recentSqlErrorQuery(env = process.env) {
  return `SELECT TOP (${sqlErrorLimit(env)}) * FROM tbl_ex_exceptionloginfo ORDER BY 1 DESC`
}

export function sqlConnectionConfig(server, env = process.env, { requireEnabled = true } = {}) {
  if (requireEnabled && !sqlErrorChecksEnabled(env)) return undefined
  if (!env.SQL_USERNAME?.trim() || !env.SQL_PASSWORD || !env.SQL_PCD_DATABASE?.trim()) return undefined
  const port = Number(env.SQL_PORT || 1433)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SQL_PORT must be a valid port.')
  const serverKey = server.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const sqlHost = env[`SQL_SERVER_${serverKey}`]?.trim() || env.SQL_SERVER?.trim() || server.databaseHost || server.ip
  return {
    user: env.SQL_USERNAME.trim(), password: env.SQL_PASSWORD, database: env.SQL_PCD_DATABASE.trim(),
    server: sqlHost, port,
    connectionTimeout: 10000, requestTimeout: 10000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 5000 },
    options: {
      encrypt: booleanSetting(env, 'SQL_ENCRYPT', true),
      trustServerCertificate: booleanSetting(env, 'SQL_TRUST_SERVER_CERTIFICATE', false),
      appName: 'Pulseboard recent error check', useUTC: true, readOnlyIntent: true,
    },
  }
}

function displayValue(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  if (Buffer.isBuffer(value)) return `[binary value omitted: ${value.length} bytes]`
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, MAX_VALUE_LENGTH) }
    catch { return '[value could not be displayed]' }
  }
  return String(value).slice(0, MAX_VALUE_LENGTH)
}

export function mapRecentSqlError(row, checkedAt = new Date(), configuredTimeColumn) {
  if (!row) return { status: 'empty', checkedAt: checkedAt.toISOString(), reason: 'No exception log rows were found.' }
  const entries = Object.entries(row).slice(0, MAX_FIELDS)
  const isValidDate = (value) => value !== null && Number.isFinite(Date.parse(value instanceof Date ? value.toISOString() : String(value)))
  const requested = configuredTimeColumn && entries.find(([name, value]) => name.toLowerCase() === configuredTimeColumn.toLowerCase() && isValidDate(value))
  const dateEntry = requested || (!configuredTimeColumn && entries.find(([name, value]) => /(?:date|time|created|logged|occurred)/i.test(name) && isValidDate(value)))
  const occurredAt = dateEntry ? new Date(dateEntry[1]).toISOString() : null
  return {
    status: 'available', checkedAt: checkedAt.toISOString(), occurredAt,
    fields: Object.fromEntries(entries.map(([name, value]) => [name, displayValue(value)])),
    truncated: Object.keys(row).length > MAX_FIELDS,
    ...(!occurredAt ? { reason: configuredTimeColumn ? `The configured time column “${configuredTimeColumn}” was not found or was not a valid date.` : 'No date/time column could be identified in the latest row.' } : {}),
  }
}

export function mapRecentSqlErrors(rows, checkedAt = new Date(), configuredTimeColumn) {
  if (!rows?.length) return { status: 'empty', checkedAt: checkedAt.toISOString(), errors: [], reason: 'No exception log rows were found.' }
  return {
    status: 'available', checkedAt: checkedAt.toISOString(),
    errors: rows.map((row) => mapRecentSqlError(row, checkedAt, configuredTimeColumn)),
  }
}

export function createSqlErrorReader({ env = process.env, createPool = (config) => new ConnectionPool(config), now = () => new Date(), summarizeTopError = cachedSqlErrorSummary } = {}) {
  return async function readRecentSqlError(server) {
    let config
    try {
      config = sqlConnectionConfig(server, env)
      if (config) sqlErrorLimit(env)
    }
    catch (error) { return { status: 'unavailable', checkedAt: now().toISOString(), reason: error.message } }
    if (!config) return {
      status: 'unavailable', checkedAt: now().toISOString(),
      reason: env.SQL_ERROR_CHECKS_ENABLED?.trim().toLowerCase() === 'true'
        ? 'SQL error checks need SQL_USERNAME, SQL_PASSWORD, and SQL_PCD_DATABASE.'
        : 'SQL error checks are disabled.',
    }
    const pool = createPool(config)
    try {
      await pool.connect()
      const result = await pool.request().query(recentSqlErrorQuery(env))
      const mapped = mapRecentSqlErrors(result.recordset, now(), env.SQL_ERROR_TIME_COLUMN?.trim())
      if (mapped.errors.length && env.AI_ERROR_SUMMARIES_ENABLED?.trim().toLowerCase() === 'true') {
        try { mapped.aiSummary = await summarizeTopError(server, mapped.errors[0], { env }) }
        catch { mapped.aiSummary = { status: 'unavailable', reason: 'AI summary unavailable.' } }
      }
      return mapped
    } catch {
      return { status: 'unavailable', checkedAt: now().toISOString(), reason: 'The recent SQL error could not be read. Check the SQL host, PCD database, credentials, permissions, encryption, and firewall.' }
    } finally {
      await pool.close().catch(() => {})
    }
  }
}

export const sqlErrorChecksEnabled = (env = process.env) => env.SQL_ERROR_CHECKS_ENABLED?.trim().toLowerCase() === 'true'
export const readRecentSqlError = createSqlErrorReader()
