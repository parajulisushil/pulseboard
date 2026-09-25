import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function approvalNotificationSettings(env = process.env) {
  const enabled = env.CODE_FREEZE_APPLIED?.trim().toLowerCase() === 'true'
  if (!enabled) return { enabled: false }
  const intervalSeconds = Number(env.GITLAB_APPROVAL_POLL_SECONDS || 60)
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) throw new Error('GITLAB_APPROVAL_POLL_SECONDS must be between 10 and 3600.')
  let webhook, appUrl
  try {
    webhook = new URL(env.DISCORD_WEBHOOK_URL)
    appUrl = new URL(env.PULSEBOARD_PUBLIC_URL)
  } catch { throw new Error('Code Freeze alerts require DISCORD_WEBHOOK_URL and PULSEBOARD_PUBLIC_URL.') }
  if (webhook.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(webhook.hostname)
    || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(webhook.pathname) || webhook.username || webhook.password) throw new Error('DISCORD_WEBHOOK_URL must be a Discord HTTPS webhook URL.')
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('PULSEBOARD_PUBLIC_URL must be the phone-accessible Pulseboard origin, without credentials or a path.')
  const userId = env.DISCORD_APPROVAL_USER_ID?.trim()
  if (userId && !/^\d{17,20}$/.test(userId)) throw new Error('DISCORD_APPROVAL_USER_ID must be a numeric Discord user ID.')
  webhook.searchParams.set('wait', 'true')
  return { enabled, intervalSeconds, webhook: webhook.href, appUrl: appUrl.origin, userId }
}

export function createApprovalNotifier({ filePath, listApprovals, settings = approvalNotificationSettings, fetchImpl = fetch, audit = () => {} }) {
  let timer, running, stopped = true, sent
  async function persist() {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(`${filePath}.tmp`, JSON.stringify({ version: 1, sent: [...sent] }), { mode: 0o600 })
    await rename(`${filePath}.tmp`, filePath)
  }
  async function check() {
    const config = settings()
    if (!config.enabled) return
    if (!sent) {
      try {
        const stored = JSON.parse(await readFile(filePath, 'utf8'))
        if (stored.version !== 1 || !Array.isArray(stored.sent) || stored.sent.some((key) => typeof key !== 'string')) throw new Error('Invalid notification state')
        sent = new Set(stored.sent)
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Approval notification state could not be read.')
        sent = new Set()
      }
    }
    const result = await listApprovals({ includeAiReview: false })
    // Never forget notifications based on an incomplete GitLab response.
    if (result.status !== 'available') throw new Error('Approval notification check was incomplete; retrying on the next poll.')
    const ready = result.mergeRequests.filter((mr) => mr.canApprove)
    const keyFor = (mr) => `${result.user.id}:${mr.projectId}:${mr.iid}:${mr.sha}`
    // Retain blocked/draft requests too, so temporary processing does not cause duplicate alerts.
    const current = new Set(result.mergeRequests.map(keyFor))
    sent = new Set([...sent].filter((key) => current.has(key)))
    await persist()
    for (const mr of ready) {
      const key = keyFor(mr)
      if (sent.has(key)) continue
      const link = `${config.appUrl}/approvals#mr-${mr.projectId}-${mr.iid}`
      let response
      try {
        response = await fetchImpl(config.webhook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            content: `${config.userId ? `<@${config.userId}> ` : ''}Code Freeze approval needed\n${String(mr.projectName).slice(0, 200)} !${mr.iid}: ${String(mr.title).slice(0, 300)}\nOpen Pulseboard to review and approve: ${link}`,
            allowed_mentions: { parse: [], users: config.userId ? [config.userId] : [] },
          }),
        })
      } catch { throw new Error('Discord approval notification could not be delivered.') }
      if (!response.ok) throw new Error(`Discord approval notification failed (HTTP ${response.status}); retrying on the next poll.`)
      sent.add(key)
      await persist()
      audit('approval_notification_sent', { projectId: mr.projectId, iid: mr.iid })
    }
  }
  function tick() {
    if (!running) running = check().catch((error) => audit('approval_notification_failed', { error: error.message })).finally(() => { running = undefined })
    return running
  }
  async function loop() {
    await tick()
    if (!stopped) {
      timer = setTimeout(loop, settings().intervalSeconds * 1000)
      timer.unref()
    }
  }
  return {
    tick,
    start() { if (!stopped || !settings().enabled) return; stopped = false; void loop() },
    stop() { stopped = true; clearTimeout(timer) },
  }
}
