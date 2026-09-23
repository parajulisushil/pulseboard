import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readFile } from 'node:fs/promises'

const DEFAULT_REFRESH_SECONDS = 60
const PING_TIMEOUT_SECONDS = 1

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
}

export function validateInfrastructureInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error('Infrastructure inventory must be a non-empty array')
  const names = new Set()
  for (const [index, server] of inventory.entries()) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error(`Infrastructure server ${index} must be an object`)
    requireText(server.name, `Infrastructure server ${index} name`)
    requireText(server.ip, `${server.name} ip`)
    requireText(server.panel, `${server.name} panel`)
    if (server.instanceId !== undefined && !/^i-[0-9a-f]{8,17}$/i.test(server.instanceId)) throw new Error(`${server.name} instanceId must be a valid EC2 instance ID`)
    if (server.awsRegion !== undefined && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(server.awsRegion)) throw new Error(`${server.name} awsRegion must be a valid AWS region`)
    if (server.ec2Control !== undefined && typeof server.ec2Control !== 'boolean') throw new Error(`${server.name} ec2Control must be a boolean`)
    if (server.ec2Control === true && !server.instanceId) throw new Error(`${server.name} must have an instanceId when ec2Control is enabled`)
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,127}$/.test(server.name)) throw new Error(`${server.name} contains unsupported characters`)
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/.test(server.ip)) throw new Error(`${server.name} ip contains unsupported characters`)
    if (server.panel.length > 80 || /[\r\n]/.test(server.panel)) throw new Error(`${server.name} panel contains unsupported characters`)
    const normalizedName = server.name.trim().toLowerCase()
    if (names.has(normalizedName)) throw new Error(`Duplicate infrastructure server name: ${server.name}`)
    names.add(normalizedName)
  }
  return inventory
}

export async function readInfrastructureInventory(filePath) {
  return validateInfrastructureInventory(JSON.parse(await readFile(filePath, 'utf8')))
}

export function pingArguments(platform = process.platform) {
  return platform === 'win32'
    ? ['-n', '1', '-w', String(PING_TIMEOUT_SECONDS * 1000)]
    : ['-c', '1', '-W', String(PING_TIMEOUT_SECONDS)]
}

export function pingHost(ip, { platform = process.platform, execute = execFile } = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    execute('ping', [...pingArguments(platform), ip], {
      timeout: (PING_TIMEOUT_SECONDS + 2) * 1000,
      windowsHide: true,
    }, (error) => {
      const online = !error
      resolve({ online, latencyMs: online ? Math.round((performance.now() - startedAt) * 10) / 10 : null })
    })
  })
}

export function groupInfrastructureStatuses(inventory, statuses, generatedAt = new Date().toISOString()) {
  const panels = []
  const panelsByTitle = new Map()
  for (const server of inventory) {
    if (!panelsByTitle.has(server.panel)) {
      const panel = { title: server.panel, servers: [] }
      panelsByTitle.set(server.panel, panel)
      panels.push(panel)
    }
    const status = statuses.get(server.name)
    panelsByTitle.get(server.panel).servers.push({
      name: server.name,
      ip: server.ip,
      instanceId: server.instanceId,
      awsRegion: server.awsRegion,
      ec2Control: server.ec2Control === true,
      online: status?.online ?? false,
      latencyMs: status?.latencyMs ?? null,
      lastChecked: status?.lastChecked ?? generatedAt,
    })
  }
  const servers = panels.flatMap((panel) => panel.servers)
  return {
    panels,
    onlineCount: servers.filter((server) => server.online).length,
    totalCount: servers.length,
    generatedAt,
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
  }
}

export function createInfrastructureMonitor({ inventoryPath, checkHost = pingHost, now = () => new Date(), refreshSeconds = DEFAULT_REFRESH_SECONDS }) {
  let cached
  let inFlight

  async function refresh() {
    const inventory = await readInfrastructureInventory(inventoryPath)
    const checkedAt = now().toISOString()
    const results = await Promise.all(inventory.map(async (server) => {
      const result = await checkHost(server.ip)
      return [server.name, {
        name: server.name,
        ip: server.ip,
        instanceId: server.instanceId,
        awsRegion: server.awsRegion,
        ec2Control: server.ec2Control === true,
        online: result.online,
        latencyMs: result.latencyMs,
        lastChecked: checkedAt,
      }]
    }))
    const response = groupInfrastructureStatuses(inventory, new Map(results), now().toISOString())
    cached = { response, expiresAt: Date.now() + refreshSeconds * 1000 }
    return response
  }

  return {
    async getStatus({ force = false } = {}) {
      if (!force && cached?.expiresAt > Date.now()) return cached.response
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = undefined })
      return inFlight
    },
  }
}
