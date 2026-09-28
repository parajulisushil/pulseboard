import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { parse } from 'dotenv'

const MAX_BYTES = 128 * 1024
export class EnvironmentError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function validateEnvText(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES || content.includes('\0')) {
    throw new EnvironmentError(400, '.env must be text without null characters and at most 128 KB')
  }
  const text = content.replace(/\r\n?/g, '\n')
  const entry = /\s*(?:#[^\n]*(?:\n|$)|(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^'"`#\n][^#\n]*|)[ \t]*(?:#[^\n]*)?(?:\n|$))/y
  const keys = new Set()
  let offset = 0
  while (offset < text.length && text.slice(offset).trim()) {
    entry.lastIndex = offset
    const match = entry.exec(text)
    if (!match) throw new EnvironmentError(400, `Invalid .env syntax near line ${text.slice(0, offset).split('\n').length}`)
    if (match[1]) {
      if (keys.has(match[1]) || match[1] === '__proto__') throw new EnvironmentError(400, `Duplicate or unsupported variable: ${match[1]}`)
      keys.add(match[1])
    }
    offset = entry.lastIndex
  }
  return parse(content)
}

export async function readEnvironmentRequest(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new EnvironmentError(415, 'Expected application/json')
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BYTES * 2) throw new EnvironmentError(413, 'Request is too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new EnvironmentError(400, 'Invalid JSON') }
}

export function checkEnvironment(content, baseEnvironment) {
  const values = validateEnvText(content)
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./index.mjs', import.meta.url), ['--check-config'], {
      env: { ...baseEnvironment, ...values }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], windowsHide: true,
    })
    let result
    const timer = setTimeout(() => child.kill(), 15000)
    child.on('message', (message) => { result = message })
    child.once('error', () => { clearTimeout(timer); reject(new EnvironmentError(400, 'Unable to validate configuration')) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && result?.valid) resolve()
      else reject(new EnvironmentError(400, result?.error || 'Configuration validation failed or timed out'))
    })
  })
}

export function createEnvironmentStore(filePath, validate = async () => {}) {
  let busy = false
  const revision = (content) => createHash('sha256').update(content).digest('hex')
  async function read() {
    let content
    try { content = await readFile(filePath, 'utf8') }
    catch (error) {
      if (error.code !== 'ENOENT') throw new EnvironmentError(500, 'Unable to read .env; check file permissions')
      content = ''
    }
    return { content, revision: revision(content) }
  }
  return {
    read,
    async save(body) {
      if (busy) throw new EnvironmentError(409, 'Another configuration operation is in progress')
      busy = true
      try {
        validateEnvText(body?.content)
        if (typeof body.revision !== 'string' || body.revision !== (await read()).revision) {
          throw new EnvironmentError(409, '.env changed since this page loaded. Copy your edits, reload, and try again.')
        }
        await validate(body.content)
        if (body.revision !== (await read()).revision) throw new EnvironmentError(409, '.env changed during validation. Reload before saving.')
        // Write the existing inode: Docker file bind mounts cannot be renamed.
        try { await writeFile(filePath, body.content, { mode: 0o600 }) }
        catch { throw new EnvironmentError(500, 'Unable to save .env; check that the file is writable by the app') }
        return { content: body.content, revision: revision(body.content) }
      } finally { busy = false }
    },
    async prepareRestart(expectedRevision) {
      if (busy) throw new EnvironmentError(409, 'Another configuration operation is in progress')
      busy = true
      try {
        const current = await read()
        if (expectedRevision !== current.revision) throw new EnvironmentError(409, '.env changed. Reload before restarting.')
        await validate(current.content)
        // Keep writes locked until this process exits.
      } catch (error) { busy = false; throw error }
    },
  }
}
