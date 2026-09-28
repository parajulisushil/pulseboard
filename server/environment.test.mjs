import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { createEnvironmentStore, validateEnvText } from './environment.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
async function temporaryDirectory(context, autoCleanup = true) {
  const data = path.join(projectRoot, 'data')
  await mkdir(data, { recursive: true })
  const directory = await mkdtemp(path.join(data, 'environment-test-'))
  if (autoCleanup) context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('validates dotenv syntax without losing literal secrets, comments or multiline values', () => {
  assert.deepEqual(validateEnvText('# settings\r\nA=\r\nB=hello # comment\r\nC="a#b"\r\nD=DOMAIN\\user\r\nE=\'line 1\nline 2\'\n'), {
    A: '', B: 'hello', C: 'a#b', D: 'DOMAIN\\user', E: 'line 1\nline 2',
  })
  for (const invalid of ['A=1\nA=2', 'no assignment', 'A="unterminated', 'A=\0', '__proto__=bad', 'A="ok" junk', 'A=' + 'x'.repeat(131072)]) {
    assert.throws(() => validateEnvText(invalid), { status: 400 })
  }
})

test('saves exact text, rejects stale writes, preserves file on validation failure and locks restart', async (context) => {
  const directory = await temporaryDirectory(context)
  const filePath = path.join(directory, '.env')
  const store = createEnvironmentStore(filePath, async (text) => { if (text.includes('BAD=')) throw new Error('Invalid runtime setting') })
  const initial = await store.read()
  const content = '# preserve me\r\nTOKEN="abc#def"\r\n'
  const saved = await store.save({ content, revision: initial.revision })
  assert.equal(await readFile(filePath, 'utf8'), content)
  await assert.rejects(store.save({ content: 'A=2', revision: initial.revision }), { status: 409 })
  await assert.rejects(store.save({ content: 'BAD=true', revision: saved.revision }), /Invalid runtime/)
  assert.equal(await readFile(filePath, 'utf8'), content)
  await assert.rejects(store.prepareRestart('old'), { status: 409 })
  await store.prepareRestart(saved.revision)
  await assert.rejects(store.save({ content: 'A=2', revision: saved.revision }), { status: 409 })
})

test('supervised API authenticates settings, validates saves, and restarts with saved values', { timeout: 45000 }, async (context) => {
  const directory = await temporaryDirectory(context, false)
  await cp(path.join(projectRoot, 'server'), path.join(directory, 'server'), { recursive: true, filter: (source) => !source.endsWith('.test.mjs') })
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const content = `API_HOST=127.0.0.1\nAPI_PORT=${port}\nAUTH_MODE=basic\nDASHBOARD_USERNAME=test\nDASHBOARD_PASSWORD=a-long-test-password\nAUTO_REFRESH_SECONDS=30\nCODE_FREEZE_APPLIED=false\n`
  await writeFile(path.join(directory, '.env'), content)
  const child = fork(path.join(directory, 'server', 'start.mjs'), [], {
    cwd: directory, env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  })
  context.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'close')
      child.send({ type: 'shutdown' })
      await exited
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  const base = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Basic ${Buffer.from('test:a-long-test-password').toString('base64')}`, 'X-Pulseboard-Request': '1', 'Content-Type': 'application/json' }
  const waitFor = async (predicate) => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      try { if (await predicate()) return } catch { /* Worker starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail('Worker did not become ready')
  }
  await waitFor(async () => (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok)
  for (const [suffix, method] of [['', 'GET'], ['', 'PUT'], ['/restart', 'POST']]) {
    assert.equal((await fetch(`${base}/api/environment${suffix}`, { method })).status, 401)
    assert.equal((await fetch(`${base}/api/environment${suffix}`, { method, headers: { Authorization: headers.Authorization } })).status, 403)
  }
  const response = await fetch(`${base}/api/environment`, { headers })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const initial = await response.json()
  assert.equal(initial.content, content)
  assert.equal(initial.restartSupported, true)
  assert.equal(initial.restartRequired, false)
  assert.equal((await fetch(`${base}/api/environment`, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  const save = (text, revision) => fetch(`${base}/api/environment`, { method: 'PUT', headers, body: JSON.stringify({ content: text, revision }) })
  const invalid = await save(content.replace('AUTO_REFRESH_SECONDS=30', 'AUTO_REFRESH_SECONDS=1'), initial.revision)
  assert.equal(invalid.status, 400)
  assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), content)
  const savedResponse = await save(content.replace('AUTO_REFRESH_SECONDS=30', 'AUTO_REFRESH_SECONDS=45'), initial.revision)
  assert.equal(savedResponse.status, 200)
  const saved = await savedResponse.json()
  assert.equal(saved.restartRequired, true)
  assert.equal((await save(content, initial.revision)).status, 409)
  assert.equal((await (await fetch(`${base}/api/config`, { headers })).json()).autoRefreshSeconds, 30)
  const restarted = await fetch(`${base}/api/environment/restart`, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision }) })
  assert.equal(restarted.status, 202)
  const { instanceId } = await restarted.json()
  await waitFor(async () => {
    const response = await fetch(`${base}/api/environment/status`, { headers, signal: AbortSignal.timeout(500) })
    return response.ok && (await response.json()).instanceId !== instanceId
  })
  assert.equal((await (await fetch(`${base}/api/config`, { headers })).json()).autoRefreshSeconds, 45)
  assert.equal((await (await fetch(`${base}/api/environment`, { headers })).json()).restartRequired, false)
})
