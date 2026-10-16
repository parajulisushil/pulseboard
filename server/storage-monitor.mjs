import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { approvalNotificationSettings } from './approval-notifications.mjs'

export function storageNotificationSettings(env = process.env) {
  if (env.STORAGE_DISCORD_ALERTS_ENABLED?.trim().toLowerCase() !== 'true') return { enabled: false }
  try { return approvalNotificationSettings({ ...env, CODE_FREEZE_APPLIED: 'true', GITLAB_APPROVAL_POLL_SECONDS: '300' }) }
  catch (error) { throw new Error(error.message.replace('Code Freeze alerts', 'Storage alerts')) }
}

export function classifyStorage(totalBytes, freeBytes, env = process.env) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) throw new Error('Invalid volume capacity')
  const percent = freeBytes / totalBytes * 100
  return {
    totalBytes, freeBytes, freePercent: Number(percent.toFixed(1)),
    status: percent < Number(env.DISK_CRITICAL_PERCENT_FREE || 10) ? 'critical' : percent < Number(env.DISK_WARNING_PERCENT_FREE || 20) ? 'warning' : 'healthy',
  }
}

export function createStorageMonitor({ inventory, checkVolumes, filePath, settings = storageNotificationSettings, fetchImpl = fetch, audit = () => {}, intervalMs = 300000, now = () => new Date() }) {
  let snapshot = {}, running, timer, stopped = true, notified
  async function persist() {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(`${filePath}.tmp`, JSON.stringify(notified), { mode: 0o600 })
    await rename(`${filePath}.tmp`, filePath)
  }
  async function notify(server, storage) {
    const config = settings()
    if (!config.enabled || storage.status === 'unknown') return
    if (!notified) {
      try {
        notified = JSON.parse(await readFile(filePath, 'utf8'))
        if (!notified || typeof notified !== 'object' || Array.isArray(notified)) throw new Error('Invalid state')
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Storage notification history could not be read')
        notified = {}
      }
    }
    const key = `${server.remoteHost || server.name}:${storage.drive}`
    const previous = notified[key]
    if (previous === storage.status || (!previous && storage.status === 'healthy')) return
    const freeGb = (storage.freeBytes / 1024 ** 3).toFixed(1)
    const response = await fetchImpl(config.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        content: `${config.userId ? `<@${config.userId}> ` : ''}${storage.label}: ${storage.status === 'healthy' ? 'recovered' : storage.status.toUpperCase()}\n${server.remoteHost || server.name} ${storage.drive} (${storage.share})\n${freeGb} GB free (${storage.freePercent}%)\n${config.appUrl}/infrastructure-status#storage-${encodeURIComponent(server.name)}`,
        allowed_mentions: { parse: [], users: config.userId ? [config.userId] : [] },
      }),
    })
    if (!response.ok) throw new Error(`Storage notification failed (HTTP ${response.status})`)
    notified[key] = storage.status
    await persist()
    audit('storage_notification_sent', { server: server.name, drive: storage.drive, status: storage.status })
  }
  async function check() {
    const servers = (await inventory()).filter((server) => server.storage)
    const next = {}
    await Promise.all(servers.map(async (server) => {
      let storage
      try {
        const volumes = await checkVolumes(server)
        const volume = volumes.find((item) => item.name.toUpperCase() === server.storage.drive.toUpperCase())
        if (!volume) throw new Error('Capacity was not reported')
        storage = { ...server.storage, ...classifyStorage(volume.totalBytes, volume.freeBytes), checkedAt: now().toISOString() }
      } catch {
        storage = { ...server.storage, status: 'unknown', checkedAt: now().toISOString(), reason: 'Disk capacity unavailable. Check the TeamCity status build, FS02 remoting permissions, and the configured drive.' }
      }
      next[server.name] = storage
    }))
    snapshot = next
    // Serialize notifications because their history is persisted in a shared file.
    for (const server of servers) {
      try { await notify(server, next[server.name]) }
      catch (error) { audit('storage_notification_failed', { server: server.name, error: error.message }) }
    }
  }
  function tick() {
    if (!running) running = check().catch(() => audit('storage_check_failed', {})).finally(() => { running = undefined })
    return running
  }
  async function loop() {
    await tick()
    if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref() }
  }
  return {
    tick,
    async getStatus() {
      const result = {}
      for (const server of (await inventory()).filter((item) => item.storage)) {
        const stored = snapshot[server.name]
        result[server.name] = stored && now().getTime() - Date.parse(stored.checkedAt) <= intervalMs + 240000
          ? stored
          : { ...server.storage, status: 'unknown', reason: stored ? 'Storage data is stale. Waiting for a successful background check.' : 'Waiting for the first background storage check.' }
      }
      return result
    },
    start() { if (!stopped) return; stopped = false; void loop() },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
