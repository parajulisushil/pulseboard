import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mssql from 'mssql'
import { mapRecentSqlErrors, recentSqlErrorQuery, sqlConnectionConfig } from './sql-errors.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const inventoryPath = process.env.INVENTORY_PATH
  ? path.resolve(root, '..', process.env.INVENTORY_PATH)
  : path.resolve(root, '..', 'config', 'servers.json')

function redact(value) {
  let result = String(value ?? '')
  for (const secret of [process.env.SQL_PASSWORD]) {
    if (secret) result = result.split(secret).join('[REDACTED]')
  }
  return result
}

function diagnosticError(error) {
  const fields = ['name', 'message', 'code', 'number', 'state', 'class', 'lineNumber', 'serverName', 'procName']
  const details = Object.fromEntries(fields.flatMap((field) => error?.[field] === undefined ? [] : [[field, redact(error[field])]]))
  if (error?.originalError && error.originalError !== error) details.originalError = diagnosticError(error.originalError)
  if (Array.isArray(error?.precedingErrors)) details.precedingErrors = error.precedingErrors.map(diagnosticError)
  return details
}

function tcpCheck(host, port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setTimeout(10000)
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('timeout', () => { socket.destroy(); reject(Object.assign(new Error('TCP connection timed out after 10 seconds.'), { code: 'ETIMEDOUT' })) })
    socket.once('error', reject)
  })
}

function hint(error) {
  const code = String(error?.code || error?.originalError?.code || '').toUpperCase()
  const number = Number(error?.number ?? error?.originalError?.number)
  const message = String(error?.message || '')
  if (/TLS ServerName to an IP address is not permitted/i.test(message)) return 'Set the per-machine SQL hostname in .env, for example SQL_SERVER_DEV_QC03=dev-qc03.ad.veniosystems.com. Keep the IP only when SQL_ENCRYPT=false.'
  if (['ETIMEOUT', 'ESOCKET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'Check SQL_PORT, TCP/IP on SQL Server, Windows Firewall, routing, and whether SQL Server is listening on this address.'
  if (code === 'ELOGIN' || number === 18456) return 'SQL Server rejected the login. Check SQL_USERNAME/SQL_PASSWORD, SQL authentication mode, and access to SQL_PCD_DATABASE.'
  if (number === 4060) return 'The login succeeded but cannot open SQL_PCD_DATABASE. Check the database name and user mapping.'
  if (number === 208) return 'The database was opened, but tbl_ex_exceptionloginfo was not found for this login. Check the PCD database and default schema/table name.'
  if (number === 229) return 'The login lacks SELECT permission on tbl_ex_exceptionloginfo.'
  if (/certificate|self signed|unable to verify/i.test(message)) return 'SQL TLS validation failed. Install the issuing CA on the API host, or temporarily test with SQL_TRUST_SERVER_CERTIFICATE=true.'
  return 'Use the code, number, and message above to identify whether this is connectivity, login, database, or query access.'
}

const requestedName = process.argv.slice(2).join(' ').trim()
if (!requestedName) {
  console.error('Usage: npm run check:sql -- Dev-QC03')
  process.exitCode = 2
} else {
  let pool
  try {
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
    const server = inventory.find((item) => item.name.toLowerCase() === requestedName.toLowerCase())
    if (!server || server.group !== 'Test machines') throw new Error(`Test server “${requestedName}” was not found in ${inventoryPath}.`)
    const missing = ['SQL_USERNAME', 'SQL_PASSWORD', 'SQL_PCD_DATABASE'].filter((name) => !process.env[name]?.trim())
    if (missing.length) throw new Error(`Missing .env settings: ${missing.join(', ')}`)
    const config = sqlConnectionConfig(server, process.env, { requireEnabled: false })
    console.log(`Target: ${server.name} (${config.server}:${config.port})`)
    console.log(`Database: ${config.database}`)
    console.log(`SQL user: ${config.user}`)
    console.log(`TLS: encrypt=${config.options.encrypt}, trustServerCertificate=${config.options.trustServerCertificate}`)
    console.log('[1/2] Testing TCP connection...')
    await tcpCheck(config.server, config.port)
    console.log('[1/2] TCP connection succeeded.')
    console.log('[2/2] Connecting to SQL Server and reading recent exceptions...')
    pool = await new mssql.ConnectionPool(config).connect()
    const result = await pool.request().query(recentSqlErrorQuery(process.env))
    console.log(`[2/2] Query succeeded. Rows returned: ${result.recordset?.length || 0}`)
    console.dir(mapRecentSqlErrors(result.recordset, new Date(), process.env.SQL_ERROR_TIME_COLUMN?.trim()), { depth: 6, colors: true })
  } catch (error) {
    console.error('SQL diagnostic failed:')
    console.error(JSON.stringify(diagnosticError(error), null, 2))
    console.error(`Hint: ${hint(error)}`)
    process.exitCode = 1
  } finally {
    if (pool) await pool.close().catch(() => {})
  }
}
