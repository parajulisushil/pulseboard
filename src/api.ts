export async function apiRequest<T>(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
  const body = await response.json().catch(() => undefined) as { error?: string; reason?: string } | T | undefined
  if (!response.ok) {
    const errorBody = body as { error?: string; reason?: string } | undefined
    throw new Error(errorBody?.error || errorBody?.reason || `Request failed with status ${response.status}`)
  }
  return body as T
}
