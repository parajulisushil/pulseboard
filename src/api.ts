import { featureForUrl, recordError, recordResponseErrors } from './errorCenter.ts'

export async function apiRequest<T>(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
  } catch (error) {
    // Caller cancellation and the expected reconnect polling after a restart are not failures.
    if (!options.signal?.aborted && !url.startsWith('/api/environment/status')) {
      const timedOut = timeout.aborted
      recordError({ feature: featureForUrl(url), message: timedOut ? `Request timed out after ${timeoutMs / 1000} seconds` : 'Could not connect to Pulseboard', category: timedOut ? 'Timeout' : 'Connection error', details: { Method: options.method || 'GET', Endpoint: url.split('?')[0], ...(timedOut ? { 'Timeout (ms)': timeoutMs } : {}) } })
    }
    throw error
  }
  const body = await response.json().catch(() => undefined) as { error?: string; reason?: string } | T | undefined
  if (!response.ok) {
    const errorBody = body as { error?: string; reason?: string } | undefined
    const message = errorBody?.error || errorBody?.reason || `Request failed with status ${response.status}`
    if (!url.startsWith('/api/environment/status')) {
      const requestId = response.headers.get('X-Request-Id')
      recordError({ feature: featureForUrl(url), message, category: 'HTTP error', details: { Method: options.method || 'GET', Endpoint: url.split('?')[0], 'HTTP status': response.status, ...(requestId ? { 'Request ID': requestId } : {}) } })
    }
    throw new Error(message)
  }
  recordResponseErrors(url, body)
  return body as T
}
