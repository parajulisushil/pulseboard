export function currentRefreshTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function refreshTimeLabel(lastRefresh: string, loading: boolean, failed: boolean) {
  return loading ? 'checking...' : `${failed ? 'Failed · ' : ''}Last: ${lastRefresh}`
}

export function refreshTimeTitle(lastRefresh: string) {
  return `Last successful refresh in your browser's local time: ${lastRefresh}`
}
