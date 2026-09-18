import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { BerReader, BerWriter, FilterParser } from 'ldapts'
import { adPasswords, AdPasswordError, createAdPasswordService, escapeAdFilter, generateAdPassword, mapAdUser, readAdResetRequest } from './ad-passwords.mjs'
import { api } from './index.mjs'

const NOW = new Date('2026-09-07T10:00:00Z')
const DAY = 86400000
const GUID = '00112233445566778899aabbccddeeff'
const PASSWORD = 'Custom12!Abc'
const filetime = (date) => String(BigInt(new Date(date).getTime()) * 10000n + 116444736000000000n)
const entry = (overrides = {}) => ({
  dn: 'CN=Test User,OU=People,DC=example,DC=test', objectGUID: Buffer.from(GUID, 'hex'),
  displayName: 'Test User', sAMAccountName: 'test.user', userPrincipalName: 'test.user@example.test',
  mail: 'test.user@example.test', userAccountControl: '512', pwdLastSet: filetime('2026-08-07T10:00:00Z'),
  'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() + DAY), ...overrides,
})
const environment = () => ({ AD_SERVER: 'dc.example.test', AD_BASE_DN: 'DC=example,DC=test', AD_BIND_USER: 'operator@example.test', AD_BIND_PASSWORD: 'bind-secret' })

function harness({ entries = [entry()], env = environment(), clock = () => NOW, ...overrides } = {}) {
  const calls = { bindings: [], searches: [], modifications: [], options: [], unbound: 0 }
  const client = {
    async bind(...args) { calls.bindings.push(args) },
    async *searchPaginated(base, options) { calls.searches.push({ base, options }); yield { searchEntries: entries, searchReferences: [] } },
    async modify(dn, change) { calls.modifications.push({ dn, change }) },
    async unbind() { calls.unbound++ },
    ...overrides,
  }
  const service = createAdPasswordService({ env, now: clock, createClient: (options) => { calls.options.push(options); return client } })
  return { service, client, calls, env }
}

test('generates exactly 12 unpredictable characters with all four character classes', () => {
  const passwords = new Set(Array.from({ length: 200 }, generateAdPassword))
  assert.equal(passwords.size, 200)
  for (const password of passwords) {
    assert.equal(password.length, 12)
    for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%&*?+_=-]/]) assert.match(password, pattern)
  }
})

test('interprets exact FILETIME values and AD expiry sentinel states', () => {
  const mapped = mapAdUser(entry(), NOW)
  assert.equal(mapped.expiresAt, '2026-09-08T10:00:00.000Z')
  assert.equal(mapped.daysRemaining, 1)
  assert.equal(mapped.id, GUID)
  assert.equal(mapped.enabled, true)
  assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() + 1) }), NOW).daysRemaining, 1)
  assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW) }), NOW).expiryStatus, 'expired')
  assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() - 1) }), NOW).daysRemaining, -1)
  for (const value of ['9223372036854775807', ['9223372036854775807']]) assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': value }), NOW).expiryStatus, 'never')
  assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': '0' }), NOW).expiryStatus, 'must_change')
  assert.equal(mapAdUser(entry({ pwdLastSet: '0', userAccountControl: '66048' }), NOW).expiryStatus, 'never')
  assert.equal(mapAdUser(entry({ pwdLastSet: '0', 'msDS-UserPasswordExpiryTimeComputed': undefined }), NOW).expiryStatus, 'must_change')
  for (const value of [undefined, '', 'invalid', '-1', '9999999999999999999']) assert.equal(mapAdUser(entry({ 'msDS-UserPasswordExpiryTimeComputed': value }), NOW).expiryStatus, 'unknown')
  assert.equal(mapAdUser(entry({ userAccountControl: '514' }), NOW).enabled, false)
  assert.equal(mapAdUser(entry({ objectGUID: undefined }), NOW).canReset, false)
  assert.equal(mapAdUser({ SAMACCOUNTNAME: ['case.test'], USERACCOUNTCONTROL: ['512'], 'MSDS-USERPASSWORDEXPIRYTIMECOMPUTED': ['0'] }, NOW).accountName, 'case.test')
})

test('default list includes expired and must-change users before seven-day expiries across all pages', async () => {
  let pages = 0
  const { service, calls } = harness({
    async *searchPaginated(base, options) {
      assert.equal(base, 'DC=example,DC=test')
      assert.equal(options.paged.pageSize, 500)
      assert.deepEqual(options.explicitBufferAttributes, ['objectGUID'])
      assert(!options.filter.includes('msDS-UserPasswordExpiryTimeComputed'))
      assert(options.filter.includes('1.2.840.113556.1.4.803:=2'))
      pages++; yield { searchEntries: [entry({ displayName: 'Last', 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() + 7 * DAY) })] }
      pages++; yield { searchEntries: [
        entry({ displayName: 'First' }),
        entry({ userAccountControl: '514' }),
        entry({ displayName: 'Expired now', 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW) }),
        entry({ displayName: 'Expired earlier', 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() - 30 * DAY) }),
        entry({ displayName: 'Disabled expired', userAccountControl: '514', 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() - DAY) }),
        entry({ 'msDS-UserPasswordExpiryTimeComputed': filetime(NOW.getTime() + 7 * DAY + 1) }),
        entry({ 'msDS-UserPasswordExpiryTimeComputed': '9223372036854775807' }),
        entry({ displayName: 'Must change', 'msDS-UserPasswordExpiryTimeComputed': '0' }),
        entry({ displayName: 'Last set zero', pwdLastSet: '0' }),
        entry({ displayName: 'Disabled must change', userAccountControl: '514', pwdLastSet: '0' }),
      ] }
    },
  })
  const result = await service.listUsers()
  assert.equal(pages, 2)
  assert.deepEqual(result.users.map((user) => user.displayName), ['Expired earlier', 'Expired now', 'Must change', 'Last set zero', 'First', 'Last'])
  assert.equal(result.status, 'available')
  assert.equal(result.windowEnd, '2026-09-14T10:00:00.000Z')
  assert.equal(calls.unbound, 1)
  assert.equal(calls.options[0].url, 'ldaps://dc.example.test:636')
  assert.equal(calls.options[0].tlsOptions.rejectUnauthorized, true)
  assert(!JSON.stringify(result).includes('bind-secret'))
})

test('search escapes LDAP metacharacters and includes disabled/never-expiring users', async () => {
  const { service, calls } = harness({ entries: [entry({ userAccountControl: '514' }), entry({ 'msDS-UserPasswordExpiryTimeComputed': '9223372036854775807' })] })
  assert.equal(escapeAdFilter('a*)(x=\0)\\'), 'a\\2a\\29\\28x=\\00\\29\\5c')
  const result = await service.listUsers({ view: 'search', query: ' *)(mail=*) ' })
  assert.equal(result.users.length, 2)
  const filter = calls.searches[0].options.filter
  for (const attribute of ['givenName', 'sn', 'displayName', 'sAMAccountName', 'userPrincipalName', 'mail']) assert(filter.includes(`(${attribute}=*\\2a\\29\\28mail=\\2a\\29*)`))
  assert(!filter.includes('1.2.840.113556.1.4.803'))
  await assert.rejects(service.listUsers({ view: 'search', query: ' ' }), { status: 400 })
  await assert.rejects(service.listUsers({ view: 'bad' }), { status: 400 })
  await assert.rejects(service.listUsers({ query: 'a'.repeat(201) }), { status: 400 })
})

test('caches AD user lists for one day unless forced and clears the cache after a reset', async () => {
  let current = NOW
  const { service, calls } = harness({ clock: () => current })
  const first = await service.listUsers()
  assert.equal((await service.listUsers()).checkedAt, first.checkedAt)
  assert.equal(calls.bindings.length, 1)
  current = new Date(NOW.getTime() + DAY - 1)
  await service.listUsers()
  assert.equal(calls.bindings.length, 1)
  current = new Date(NOW.getTime() + DAY)
  await service.listUsers()
  assert.equal(calls.bindings.length, 2)
  await service.listUsers({ force: true })
  assert.equal(calls.bindings.length, 3)
  await service.resetPassword({ userId: GUID, accountName: 'test.user' })
  await service.listUsers()
  assert.equal(calls.bindings.length, 5)
})

test('reports missing expiry and referrals; failed later pages never masquerade as a complete list', async () => {
  const { service } = harness({ async *searchPaginated() { yield { searchEntries: [entry({ 'msDS-UserPasswordExpiryTimeComputed': undefined })], searchReferences: ['ldap://other.test'] } } })
  const result = await service.listUsers()
  assert.equal(result.status, 'partial')
  assert.equal(result.warnings.length, 2)
  assert.equal(result.users.length, 0)
  const failed = harness({ async *searchPaginated() { yield { searchEntries: [entry()] }; throw new Error('private LDAP diagnostic') } })
  await assert.rejects(failed.service.listUsers(), (error) => error instanceof AdPasswordError && !error.message.includes('private LDAP diagnostic'))
  assert.equal(failed.calls.unbound, 1)
})

test('rejects missing configuration, plaintext/NTLM, and invalid TLS settings before connection', async () => {
  for (const overrides of [{ AD_BIND_PASSWORD: '' }, { AD_USE_SSL: 'false' }, { AD_AUTH: 'NTLM' }, { LDAP_VERIFY_CERT: 'typo' }, { AD_PORT: 'abc' }, { AD_SERVER: 'ldap://host' }]) {
    const { service, calls } = harness({ env: { ...environment(), ...overrides } })
    await assert.rejects(service.listUsers(), { status: 503 })
    assert.equal(calls.options.length, 0)
  }
  const failed = harness({ async bind() { throw Object.assign(new Error('bind-secret'), { code: 49 }) } })
  await assert.rejects(failed.service.listUsers(), (error) => error.status === 503 && !error.message.includes('bind-secret'))
  assert.equal(failed.calls.unbound, 1)
})

test('distinguishes LDAPS certificate and network failures without exposing raw diagnostics', async () => {
  for (const [code, pattern] of [
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /certificate is not trusted/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /LDAP_CA_CERT_FILE/],
    ['CERT_HAS_EXPIRED', /certificate has expired/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /does not match the hostname/],
    ['ENOTFOUND', /DNS/], ['ECONNREFUSED', /refused/],
    ['ETIMEDOUT', /timed out/], ['EACCES', /cannot reach/],
  ]) {
    const { service, calls } = harness({ async bind() { throw Object.assign(new Error('private diagnostic bind-secret'), { code }) } })
    await assert.rejects(service.listUsers(), (error) => error.status === 503 && pattern.test(error.message) && !error.message.includes('bind-secret'))
    assert.equal(calls.unbound, 1)
  }
})

test('rejects Python-style doubled domain separators before attempting authentication', async () => {
  const invalid = harness({ env: { ...environment(), AD_BIND_USER: String.raw`DOMAIN\\username` } })
  await assert.rejects(invalid.service.listUsers(), (error) => error.status === 503 && /one literal backslash/.test(error.message))
  assert.equal(invalid.calls.options.length, 0)
  const valid = harness({ env: { ...environment(), AD_BIND_USER: String.raw`DOMAIN\username`, LDAP_VERIFY_CERT: 'false' } })
  await valid.service.listUsers()
  assert.equal(valid.calls.bindings[0][0], String.raw`DOMAIN\username`)
  assert.equal(valid.calls.options[0].tlsOptions.rejectUnauthorized, false)
})

test('reset resolves GUID in search base and writes quoted UTF-16LE password; custom password is preserved', async () => {
  const { service, calls } = harness()
  const result = await service.resetPassword({ userId: GUID, accountName: 'test.user', password: PASSWORD })
  assert.equal(result.password, PASSWORD)
  assert.equal(result.generated, false)
  assert.equal(result.accountUnlocked, true)
  assert.equal(result.forceChangeAtNextLogon, false)
  assert.equal(calls.modifications.length, 2)
  const modification = calls.modifications[0]
  assert.equal(modification.dn, entry().dn)
  assert.equal(modification.change.operation, 'replace')
  assert.equal(modification.change.modification.type, 'unicodePwd')
  assert.deepEqual(modification.change.modification.values, [Buffer.from(`"${PASSWORD}"`, 'utf16le')])
  assert.equal(calls.modifications[1].change.modification.type, 'lockoutTime')
  const guidFilter = calls.searches[0].options.filter.filters.find((filter) => filter.attribute === 'objectGUID')
  assert.deepEqual(guidFilter.value, Buffer.from(GUID, 'hex'))
})

test('blank and omitted passwords generate a 12-character password only for the selected account', async () => {
  for (const password of ['', undefined]) {
    const { service } = harness()
    const result = await service.resetPassword({ userId: GUID, accountName: 'test.user', password })
    assert.equal(result.password.length, 12)
    assert.equal(result.generated, true)
  }
})

test('reset after a two-user search preserves the selected GUID bytes on the LDAP wire', async () => {
  const directory = [entry(), entry({
    dn: 'CN=Other User,OU=People,DC=example,DC=test',
    objectGUID: Buffer.from('fffe80aabbccddeeff00282a295c7f01', 'hex'),
    sAMAccountName: 'test.user2', displayName: 'Test User 2',
  })]
  const { service, calls } = harness({
    async *searchPaginated(base, options) {
      assert.equal(base, 'DC=example,DC=test')
      if (typeof options.filter === 'string' && options.filter.includes('(displayName=*test*)')) {
        yield { searchEntries: directory, searchReferences: ['ldap://other.test'] }
        return
      }
      // Exercise ldapts' real serialization, including the old string-filter path.
      const filter = typeof options.filter === 'string' ? FilterParser.parseString(options.filter) : options.filter
      const writer = new BerWriter()
      filter.write(writer)
      const reader = new BerReader(writer.buffer)
      reader.readSequence(0xa0)
      const assertions = new Map()
      while (reader.remain) {
        reader.readSequence(0xa3)
        assertions.set(reader.readString(), reader.readString(0x04, true))
      }
      assert.equal(assertions.get('objectCategory').toString(), 'person')
      assert.equal(assertions.get('objectClass').toString(), 'user')
      assert.equal(assertions.get('objectGUID').length, 16)
      yield { searchEntries: directory.filter((user) => user.objectGUID.equals(assertions.get('objectGUID'))) }
    },
  })
  const result = await service.listUsers({ view: 'search', query: 'test' })
  assert.equal(result.users.length, 2)
  assert.equal(result.status, 'partial')
  for (const selected of result.users) {
    const reset = await service.resetPassword({ userId: selected.id, accountName: selected.accountName })
    assert.equal(reset.user.id, selected.id)
    assert.equal(reset.user.accountName, selected.accountName)
  }
  assert.deepEqual(calls.modifications.filter(({ change }) => change.modification.type === 'unicodePwd').map(({ dn }) => dn), directory.map(({ dn }) => dn))
})

test('invalid inputs and changed/deleted/ambiguous identities cannot write a password', async () => {
  const { service, calls } = harness()
  for (const password of [null, 1, {}, 'short', 'a'.repeat(13), 'a'.repeat(11) + '\n', 'a'.repeat(11) + '\ud800']) {
    await assert.rejects(service.resetPassword({ userId: GUID, accountName: 'test.user', password }), { status: 400 })
  }
  await assert.rejects(service.resetPassword({ userId: 'injected', accountName: 'test.user' }), { status: 400 })
  await assert.rejects(service.resetPassword({ userId: GUID, accountName: 'renamed' }), { status: 409 })
  assert.equal(calls.modifications.length, 0)
  for (const entries of [[], [entry(), entry()], [entry({ objectGUID: Buffer.alloc(16) })]]) {
    const scenario = harness({ entries })
    await assert.rejects(scenario.service.resetPassword({ userId: GUID, accountName: 'test.user' }), { status: 409 })
    assert.equal(scenario.calls.modifications.length, 0)
  }
})

test('confirmed resets retain the new password when follow-up operations or disconnect fail', async () => {
  const { service } = harness({
    env: { ...environment(), FORCE_CHANGE_AT_NEXT_LOGON: 'true' },
    async modify(dn, change) { if (change.modification.type !== 'unicodePwd') throw new Error('write denied') },
    async unbind() { throw new Error('socket closed') },
  })
  const result = await service.resetPassword({ userId: GUID, accountName: 'test.user', password: PASSWORD })
  assert.equal(result.status, 'reset')
  assert.equal(result.password, PASSWORD)
  assert.equal(result.warnings.length, 2)
  assert.equal(result.accountUnlocked, false)
  assert.equal(result.forceChangeAtNextLogon, false)
  const successful = harness({ env: { ...environment(), FORCE_CHANGE_AT_NEXT_LOGON: 'true', UNLOCK_ACCOUNT_AFTER_RESET: 'false' } })
  const success = await successful.service.resetPassword({ userId: GUID, accountName: 'test.user' })
  assert.equal(success.forceChangeAtNextLogon, true)
  assert.equal(success.accountUnlocked, false)
  assert.deepEqual(successful.calls.modifications.map(({ change }) => change.modification.type), ['unicodePwd', 'pwdLastSet'])
})

test('reset errors are sanitized, do not retry, and do not perform follow-up writes', async () => {
  for (const [code, status] of [[19, 422], [53, 422], [50, 403], [32, 409], [undefined, 502]]) {
    let writes = 0
    const { service } = harness({ async modify() { writes++; throw Object.assign(new Error(PASSWORD), { code }) } })
    await assert.rejects(service.resetPassword({ userId: GUID, accountName: 'test.user', password: PASSWORD }), (error) => error.status === status && !error.message.includes(PASSWORD))
    assert.equal(writes, 1)
  }
})

test('concurrent resets for the same GUID are rejected and locks are released afterward', async () => {
  let release
  let started
  const waiting = new Promise((resolve) => { release = resolve })
  const writing = new Promise((resolve) => { started = resolve })
  const { service } = harness({ async modify() { started(); await waiting } })
  const first = service.resetPassword({ userId: GUID, accountName: 'test.user' })
  await writing
  await assert.rejects(service.resetPassword({ userId: GUID.toUpperCase(), accountName: 'test.user' }), { status: 409 })
  release()
  await first
  assert.equal((await service.resetPassword({ userId: GUID, accountName: 'test.user' })).status, 'reset')
})

test('request parser requires a bounded JSON object', async () => {
  const request = (body, type = 'application/json') => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': type } })
  assert.deepEqual(await readAdResetRequest(request('{"password":""}')), { password: '' })
  for (const body of ['null', '[]', '"string"', '{invalid']) await assert.rejects(readAdResetRequest(request(body)), { status: 400 })
  await assert.rejects(readAdResetRequest(request('{}', 'text/plain')), { status: 400 })
  await assert.rejects(readAdResetRequest(request('x'.repeat(4097))), { status: 413 })
})

test('AD endpoints require authentication and verified reset requests; passwords never enter logs', async (context) => {
  const previous = Object.fromEntries(['AUTH_MODE', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD'].map((name) => [name, process.env[name]]))
  Object.assign(process.env, { AUTH_MODE: 'basic', DASHBOARD_USERNAME: 'operator', DASHBOARD_PASSWORD: 'long-test-api-password' })
  const logs = []
  context.mock.method(console, 'log', (message) => logs.push(message))
  context.mock.method(console, 'warn', (message) => logs.push(message))
  const list = context.mock.method(adPasswords, 'listUsers', async (criteria) => ({
    status: 'available', users: [{ expiryStatus: 'expired' }, { expiryStatus: 'scheduled' }, { expiryStatus: 'must_change' }],
    warnings: [], checkedAt: '2026-09-10T00:00:00.000Z', ...criteria,
  }))
  const reset = context.mock.method(adPasswords, 'resetPassword', async () => ({ status: 'reset', user: { id: GUID, accountName: 'test.user' }, password: PASSWORD, warnings: [] }))
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const base = `http://127.0.0.1:${api.address().port}`
  context.after(async () => {
    await new Promise((resolve) => api.close(resolve))
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  })
  const authorization = `Basic ${Buffer.from('operator:long-test-api-password').toString('base64')}`
  assert.equal((await fetch(`${base}/api/ad/users`)).status, 401)
  assert.equal((await fetch(`${base}/api/ad/reset-password`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/api/ad/reset-password`, { method: 'POST', headers: { authorization } })).status, 403)
  assert.equal(reset.mock.callCount(), 0)
  const users = await fetch(`${base}/api/ad/users?view=search&q=test`, { headers: { authorization } })
  assert.equal(users.status, 200)
  assert.deepEqual(list.mock.calls[0].arguments, [{ view: 'search', query: 'test' }])
  const refreshedUsers = await fetch(`${base}/api/ad/users?view=search&q=test&refresh=1`, { headers: { authorization } })
  assert.equal(refreshedUsers.status, 200)
  assert.deepEqual(list.mock.calls[1].arguments, [{ view: 'search', query: 'test', force: true }])
  const summary = await fetch(`${base}/api/ad/summary`, { headers: { authorization } })
  assert.deepEqual(await summary.json(), { status: 'available', expiredCount: 1, expiringCount: 1, mustChangeCount: 1, warnings: [], checkedAt: '2026-09-10T00:00:00.000Z' })
  const response = await fetch(`${base}/api/ad/reset-password`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-pulseboard-request': '1' },
    body: JSON.stringify({ userId: GUID, accountName: 'test.user', password: PASSWORD }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).password, PASSWORD)
  assert(logs.some((line) => line.includes('ad_password_reset')))
  assert(logs.every((line) => !line.includes(PASSWORD)))
})
