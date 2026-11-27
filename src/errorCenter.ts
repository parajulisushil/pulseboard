export type ErrorEntry = {
  id: string
  feature: string
  message: string
  category: string
  firstSeen: string
  lastSeen: string
  count: number
  details: Record<string, string | number>
}
type ErrorInput = { feature: string; message: string; category: string; details?: Record<string, string | number> }

const maxEntries = 100
let entries: ErrorEntry[] = []
const listeners = new Set<() => void>()

export function getErrors() { return entries }
export function subscribeErrors(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function clearErrors() { entries = []; listeners.forEach((listener) => listener()) }

export function recordError(input: ErrorInput) {
  const details = input.details || {}
  // Request IDs and timestamps identify occurrences, rather than the underlying problem.
  const keyDetails = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'Request ID').sort(([a], [b]) => a.localeCompare(b)))
  const key = JSON.stringify([input.feature, input.message, input.category, keyDetails])
  const now = new Date().toISOString()
  const previous = entries.find((entry) => entry.id === key)
  const entry: ErrorEntry = previous
    ? { ...previous, lastSeen: now, count: previous.count + 1, details }
    : { ...input, details, id: key, firstSeen: now, lastSeen: now, count: 1 }
  entries = [entry, ...entries.filter((item) => item.id !== key)].slice(0, maxEntries)
  listeners.forEach((listener) => listener())
}

export function featureForUrl(url: string) {
  const path = url.split('?')[0]
  if (path.startsWith('/api/teamcity') || path === '/api/integrations') return 'Delivery systems'
  if (path.startsWith('/api/gitlab')) return 'GitLab approvals'
  if (path.startsWith('/api/ad/')) return 'AD passwords'
  if (path.startsWith('/api/scheduled-jobs')) return 'Scheduled jobs'
  if (path.startsWith('/api/ec2') || path.startsWith('/api/infrastructure')) return 'Infrastructure'
  if (path.startsWith('/api/deployment') || path.startsWith('/api/servers')) return 'Test machines'
  if (path.startsWith('/api/environment')) return 'Environment'
  return 'Dashboard'
}

// Only copy known diagnostic fields, never request bodies, response payloads or query strings.
export function recordResponseErrors(url: string, body: unknown) {
  const feature = featureForUrl(url)
  let visited = 0
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 8 || visited++ >= 1000) return
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return }
    const item = value as Record<string, unknown>
    const message = typeof item.reason === 'string' && item.reason ? item.reason : typeof item.message === 'string' ? item.message : ''
    if (['unknown', 'unavailable', 'failed', 'failure'].includes(String(item.status)) && message) {
      const details: Record<string, string | number> = {}
      const diagnostic = item.errorDetails && typeof item.errorDetails === 'object' ? item.errorDetails as Record<string, unknown> : {}
      for (const [key, label] of Object.entries({ operation: 'Operation', buildTypeId: 'Configuration', buildId: 'Build ID', branch: 'Branch', timeoutMs: 'Timeout (ms)', httpStatus: 'HTTP status', code: 'Connection code' })) {
        const field = diagnostic[key]
        if (typeof field === 'string' || typeof field === 'number') details[label] = field
      }
      if (typeof item.label === 'string') details.Component = item.label
      else if (typeof item.name === 'string') details.Item = item.name
      recordError({ feature, message, category: typeof diagnostic.type === 'string' ? diagnostic.type : 'Reported failure', details })
    }
    for (const [key, child] of Object.entries(item)) if (key !== 'errorDetails') visit(child, depth + 1)
  }
  visit(body, 0)
}
