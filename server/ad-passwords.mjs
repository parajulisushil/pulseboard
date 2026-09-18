import { randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AndFilter, Attribute, Change, Client, EqualityFilter } from 'ldapts'

const DAY_MS = 86400000
const FILETIME_EPOCH = 116444736000000000n
const NEVER_EXPIRES = 9223372036854775807n
const EXPIRY_ATTRIBUTE = 'msDS-UserPasswordExpiryTimeComputed'
const USER_FILTER = '(objectCategory=person)(objectClass=user)'
const ATTRIBUTES = ['objectGUID', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail', 'userAccountControl', 'pwdLastSet', EXPIRY_ATTRIBUTE]

export class AdPasswordError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'AdPasswordError'
    this.status = status
  }
}

function scalar(entry, name) {
  const key = Object.keys(entry).find((key) => key.toLowerCase() === name.toLowerCase())
  const value = entry[key]
  return Array.isArray(value) ? value[0] : value
}

function integer(value) {
  if (value === undefined || value === null || !/^-?\d+$/.test(String(value))) return null
  return BigInt(String(value))
}

function filetimeDate(value) {
  if (value === null || value <= 0n || value >= NEVER_EXPIRES) return null
  const date = new Date(Number((value - FILETIME_EPOCH) / 10000n))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function mapAdUser(entry, now = new Date()) {
  const flags = integer(scalar(entry, 'userAccountControl'))
  const lastSet = integer(scalar(entry, 'pwdLastSet'))
  const expiry = integer(scalar(entry, EXPIRY_ATTRIBUTE))
  // AD's computed attribute includes the user's effective (including fine-grained) policy.
  const neverExpires = expiry === NEVER_EXPIRES || (flags !== null && (flags & 0x53800n) !== 0n)
  let expiryStatus = 'unknown'
  let expiresAt = null
  let daysRemaining = null
  if (neverExpires) expiryStatus = 'never'
  else if (expiry === 0n || lastSet === 0n) expiryStatus = 'must_change'
  else {
    expiresAt = filetimeDate(expiry)
    if (expiresAt) {
      const remaining = Date.parse(expiresAt) - now.getTime()
      expiryStatus = remaining <= 0 ? 'expired' : 'scheduled'
      daysRemaining = remaining <= 0 ? Math.floor(remaining / DAY_MS) : Math.ceil(remaining / DAY_MS)
    }
  }
  const guid = scalar(entry, 'objectGUID')
  const id = Buffer.isBuffer(guid) && guid.length === 16 ? guid.toString('hex') : null
  const accountName = String(scalar(entry, 'sAMAccountName') || '')
  return {
    id, accountName,
    displayName: String(scalar(entry, 'displayName') || accountName),
    principalName: String(scalar(entry, 'userPrincipalName') || ''),
    email: String(scalar(entry, 'mail') || ''),
    enabled: flags === null ? null : (flags & 2n) === 0n,
    expiryStatus, expiresAt, daysRemaining,
    passwordLastSet: filetimeDate(lastSet),
    canReset: Boolean(id && accountName),
  }
}

export function escapeAdFilter(value) {
  return value.replace(/[\\*()\0]/g, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

export function generateAdPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?+-_=']
  const alphabet = groups.join('')
  const characters = groups.map((group) => group[randomInt(group.length)])
  while (characters.length < 12) characters.push(alphabet[randomInt(alphabet.length)])
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1)
    ;[characters[index], characters[other]] = [characters[other], characters[index]]
  }
  return characters.join('')
}

function booleanSetting(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (!['true', 'false'].includes(value)) throw new AdPasswordError(`${name} must be true or false.`, 503)
  return value === 'true'
}

async function configuration(env) {
  if (!env.AD_SERVER?.trim() || !env.AD_BASE_DN?.trim() || !env.AD_BIND_USER?.trim() || !env.AD_BIND_PASSWORD) {
    throw new AdPasswordError('Active Directory is not configured. Set AD_SERVER, AD_BASE_DN, AD_BIND_USER, and AD_BIND_PASSWORD in the API environment, then restart the API.', 503)
  }
  const host = env.AD_SERVER.trim()
  const port = Number(env.AD_PORT || 636)
  if (!/^[a-z\d.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdPasswordError('AD_SERVER must be a hostname and AD_PORT must be a valid port.', 503)
  }
  if (!booleanSetting(env, 'AD_USE_SSL', true) || (env.AD_AUTH || 'SIMPLE').trim().toUpperCase() !== 'SIMPLE') {
    throw new AdPasswordError('AD passwords require AD_USE_SSL=true and AD_AUTH=SIMPLE (use a UPN for AD_BIND_USER).', 503)
  }
  if (env.AD_BIND_USER.includes('\\\\')) {
    throw new AdPasswordError('AD_BIND_USER contains doubled backslashes. In .env, use one literal backslash for DOMAIN\\username, or use the account UPN (username@domain).', 503)
  }
  const tlsOptions = { minVersion: 'TLSv1.2', rejectUnauthorized: booleanSetting(env, 'LDAP_VERIFY_CERT', true) }
  if (env.LDAP_CA_CERT_FILE?.trim()) {
    try { tlsOptions.ca = await readFile(env.LDAP_CA_CERT_FILE.trim()) }
    catch { throw new AdPasswordError('LDAP_CA_CERT_FILE could not be read by the API.', 503) }
  }
  return {
    url: `ldaps://${host}:${port}`, baseDn: env.AD_BASE_DN.trim(),
    bindUser: env.AD_BIND_USER.trim(), bindPassword: env.AD_BIND_PASSWORD, tlsOptions,
    forceChange: booleanSetting(env, 'FORCE_CHANGE_AT_NEXT_LOGON', false),
    unlock: booleanSetting(env, 'UNLOCK_ACCOUNT_AFTER_RESET', true),
  }
}

function replace(type, value) {
  return new Change({ operation: 'replace', modification: new Attribute({ type, values: [value] }) })
}

function ldapError(error, stage) {
  if (error instanceof AdPasswordError) return error
  // Never return LDAP exception text: it may contain connection credentials or request values.
  const code = Number(error?.code)
  if (code === 49) return new AdPasswordError('AD rejected the bind credentials. Check AD_BIND_USER and AD_BIND_PASSWORD.', 503)
  if (code === 50) return new AdPasswordError('The configured AD account does not have permission for this operation.', 403)
  if (stage === 'reset' && [19, 53].includes(code)) return new AdPasswordError('AD rejected the password reset. Check password complexity, history, minimum length, and reset permissions.', 422)
  if (stage === 'reset' && code === 32) return new AdPasswordError('This AD user no longer exists at the selected location. Search again.', 409)
  if (stage === 'reset') return new AdPasswordError('AD did not confirm the password reset. The outcome may be unknown; check the account before attempting another reset.')
  if (stage === 'connect') {
    if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED'].includes(error?.code)) {
      return new AdPasswordError('The AD server\'s LDAPS certificate is not trusted. Set LDAP_CA_CERT_FILE to the trusted CA certificate, or use LDAP_VERIFY_CERT=false to match the standalone script\'s self-signed setup. Restart the API after changing .env.', 503)
    }
    if (error?.code === 'CERT_HAS_EXPIRED') return new AdPasswordError('The AD server\'s LDAPS certificate has expired. Renew the certificate on the domain controller.', 503)
    if (error?.code === 'CERT_NOT_YET_VALID') return new AdPasswordError('The AD server\'s LDAPS certificate is not yet valid. Check the system clock and certificate validity dates.', 503)
    if (error?.code === 'ERR_TLS_CERT_ALTNAME_INVALID') return new AdPasswordError('AD_SERVER does not match the hostname on the LDAPS certificate. Use the domain controller hostname covered by that certificate.', 503)
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return new AdPasswordError('AD_SERVER could not be resolved in DNS. Check the hostname and connection to the AD network or VPN.', 503)
    if (error?.code === 'ECONNREFUSED') return new AdPasswordError('The AD server refused the LDAPS connection. Check AD_PORT (normally 636) and that LDAPS is enabled on the domain controller.', 503)
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code) || error?.message === 'Connection timeout') return new AdPasswordError('The LDAPS connection to AD timed out. Check the network or VPN and firewall access to AD_PORT (normally 636).', 503)
    if (['EACCES', 'EPERM', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code)) return new AdPasswordError('The API cannot reach the AD server over LDAPS. Check network access, firewall rules, and connection permissions for the API process.', 503)
    return new AdPasswordError('Unable to connect or bind to AD over LDAPS. Check the server, credentials, network, and trusted CA certificate.', 503)
  }
  return new AdPasswordError('The AD user lookup could not be completed. Check the connection, search base, and directory read permissions.')
}

export function createAdPasswordService({ env = process.env, createClient = (options) => new Client(options), now = () => new Date() } = {}) {
  const resetLocks = new Set()
  const userListCache = new Map()

  async function withConnection(operation) {
    const config = await configuration(env)
    const client = createClient({ url: config.url, timeout: 15000, connectTimeout: 10000, tlsOptions: config.tlsOptions })
    let expired = false
    const timer = setTimeout(() => { expired = true; void client.unbind().catch(() => {}) }, 60000)
    timer.unref()
    const checkDeadline = () => { if (expired) throw new AdPasswordError('The AD operation timed out. Refresh to check its current state.') }
    try {
      try { await client.bind(config.bindUser, config.bindPassword) }
      catch (error) { throw ldapError(error, 'connect') }
      return await operation(client, config, checkDeadline)
    } finally {
      clearTimeout(timer)
      // A disconnect failure must never turn a confirmed password reset into a failed reset.
      await client.unbind().catch(() => {})
    }
  }

  async function search(client, config, filter, checkDeadline) {
    const entries = []
    let referrals = false
    try {
      for await (const page of client.searchPaginated(config.baseDn, {
        scope: 'sub', filter, attributes: ATTRIBUTES, explicitBufferAttributes: ['objectGUID'],
        paged: { pageSize: 500 }, timeLimit: 30,
      })) {
        checkDeadline()
        entries.push(...page.searchEntries)
        referrals ||= Boolean(page.searchReferences?.length)
      }
    } catch (error) { throw ldapError(error, 'search') }
    return { entries, referrals }
  }

  async function listUsers({ view = 'expiring', query = '', force = false } = {}) {
    if (!['expiring', 'search'].includes(view) || typeof query !== 'string' || query.length > 200) {
      throw new AdPasswordError('Choose expiring or search and use a search of at most 200 characters.', 400)
    }
    query = query.trim()
    if (view === 'search' && !query) throw new AdPasswordError('Enter a name, username, or email to search.', 400)
    const cacheKey = `${view}:${query}`
    const requestedAt = now()
    const cached = userListCache.get(cacheKey)
    if (!force && cached && cached.expiresAt > requestedAt.getTime()) return cached.promise
    const safe = escapeAdFilter(query)
    const nameFilter = query ? `(|${['givenName', 'sn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail'].map((attribute) => `(${attribute}=*${safe}*)`).join('')})` : ''
    const enabledFilter = view === 'expiring' ? '(!(userAccountControl:1.2.840.113556.1.4.803:=2))' : ''
    const pending = withConnection(async (client, config, checkDeadline) => {
      const { entries, referrals } = await search(client, config, `(&${USER_FILTER}${enabledFilter}${nameFilter})`, checkDeadline)
      const checkedAt = now()
      const windowEnd = new Date(checkedAt.getTime() + 7 * DAY_MS)
      const allUsers = entries.map((entry) => mapAdUser(entry, checkedAt))
      const warnings = []
      if (referrals) warnings.push('AD returned referrals that were not followed. Results cover only users read from the configured search base.')
      const unknown = allUsers.filter((user) => user.expiryStatus === 'unknown').length
      if (unknown) warnings.push(`Password expiry could not be determined for ${unknown} user(s).`)
      const users = view === 'expiring'
        ? allUsers.filter((user) => user.enabled === true && (
          user.expiryStatus === 'expired' || user.expiryStatus === 'must_change' ||
          (user.expiryStatus === 'scheduled' && Date.parse(user.expiresAt) <= windowEnd.getTime())
        ))
        : allUsers
      const expiryPriority = { expired: 0, must_change: 1, scheduled: 2 }
      users.sort((a, b) => view === 'expiring'
        ? expiryPriority[a.expiryStatus] - expiryPriority[b.expiryStatus] ||
          (a.expiresAt && b.expiresAt ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt) : 0) ||
          a.accountName.localeCompare(b.accountName)
        : a.displayName.localeCompare(b.displayName))
      return {
        status: warnings.length ? 'partial' : 'available', view, query, users, warnings,
        checkedAt: checkedAt.toISOString(), windowEnd: windowEnd.toISOString(),
        resetDefaults: { forceChangeAtNextLogon: config.forceChange, unlockAccount: config.unlock },
      }
    })
    userListCache.set(cacheKey, { expiresAt: requestedAt.getTime() + DAY_MS, promise: pending })
    try {
      return await pending
    } catch (error) {
      if (userListCache.get(cacheKey)?.promise === pending) userListCache.delete(cacheKey)
      throw error
    }
  }

  async function resetPassword({ userId, accountName, password } = {}) {
    if (typeof userId !== 'string' || !/^[a-f\d]{32}$/i.test(userId) || typeof accountName !== 'string' || !accountName || accountName.length > 256) {
      throw new AdPasswordError('Select one AD user from a fresh search before resetting a password.', 400)
    }
    if (password !== undefined && (typeof password !== 'string' || (password !== '' && (Array.from(password).length !== 12 || !password.isWellFormed() || Array.from(password).some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127))))) {
      throw new AdPasswordError('The new password must contain exactly 12 characters without control characters, or be empty to generate one.', 400)
    }
    const key = userId.toLowerCase()
    if (resetLocks.has(key)) throw new AdPasswordError('A password reset for this user is already in progress.', 409)
    resetLocks.add(key)
    try {
      return await withConnection(async (client, config, checkDeadline) => {
        // Keep the GUID binary: ldapts' string filter parser re-encodes bytes >= 0x80 as UTF-8.
        const filter = new AndFilter({ filters: [
          new EqualityFilter({ attribute: 'objectCategory', value: 'person' }),
          new EqualityFilter({ attribute: 'objectClass', value: 'user' }),
          new EqualityFilter({ attribute: 'objectGUID', value: Buffer.from(key, 'hex') }),
        ] })
        const { entries } = await search(client, config, filter, checkDeadline)
        if (!entries.length) throw new AdPasswordError('The selected AD user could not be found in the configured search base. Search again.', 409)
        if (entries.length !== 1) throw new AdPasswordError('AD returned multiple entries for the selected user’s ID. No password was reset. Search again.', 409)
        const entry = entries[0]
        const user = mapAdUser(entry, now())
        if (user.id !== key || user.accountName !== accountName || !entry.dn) throw new AdPasswordError('The selected AD account changed. Search again before resetting.', 409)
        const newPassword = password || generateAdPassword()
        checkDeadline()
        try { await client.modify(entry.dn, replace('unicodePwd', Buffer.from(`"${newPassword}"`, 'utf16le'))) }
        catch (error) { throw ldapError(error, 'reset') }
        userListCache.clear()
        const warnings = []
        let forceChangeAtNextLogon = false
        let accountUnlocked = false
        if (config.forceChange) {
          try { checkDeadline(); await client.modify(entry.dn, replace('pwdLastSet', '0')); forceChangeAtNextLogon = true }
          catch { warnings.push('Password was reset, but requiring a change at next sign-in could not be confirmed.') }
        }
        if (config.unlock) {
          try { checkDeadline(); await client.modify(entry.dn, replace('lockoutTime', '0')); accountUnlocked = true }
          catch { warnings.push('Password was reset, but unlocking the account could not be confirmed.') }
        }
        return {
          status: 'reset', user: { id: user.id, accountName: user.accountName, displayName: user.displayName },
          password: newPassword, generated: !password, resetAt: now().toISOString(),
          forceChangeAtNextLogon, accountUnlocked, warnings,
        }
      })
    } finally { resetLocks.delete(key) }
  }

  return { listUsers, resetPassword }
}

export const adPasswords = createAdPasswordService()

export async function readAdResetRequest(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AdPasswordError('Expected a JSON password reset request.', 400)
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new AdPasswordError('Password reset request is too large.', 413)
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
    return body
  } catch { throw new AdPasswordError('Invalid JSON password reset request.', 400) }
}
