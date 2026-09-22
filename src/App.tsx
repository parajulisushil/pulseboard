import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiRequest } from './api'
import GitLabApprovals from './GitLabApprovals'
import AdPasswords from './AdPasswords'
import DeploymentControls from './DeploymentControls'
import ScheduledJobs from './ScheduledJobs'
import './App.css'

type Service = { name: string; serviceKey?: string; status: 'running' | 'stopped' | 'unknown' }
type ServiceAction = 'start' | 'stop' | 'restart'
type DeploymentComparison = { name: string; deployed?: string; available?: string; status: 'current' | 'available' | 'unknown'; webUrl?: string }
type Deployment = {
  id?: number
  number?: string
  finishedAt?: string
  webUrl?: string
  buildTypeId: string
  buildTypeUrl?: string
  releaseVersion?: string
  branch?: string
  status: 'current' | 'available' | 'unknown'
  reason?: string
  canDeploy: boolean
  canSchedule?: boolean
  changedComponents: string[]
  comparisons: DeploymentComparison[]
}
type DiskVolume = { name: string; totalBytes: number; freeBytes: number; freePercent: number; status: 'healthy' | 'warning' | 'critical' }
type DiskSpace = { status: 'available' | 'unknown'; reason?: string; volumes: DiskVolume[] }
type RecentDatabaseError = {
  status: 'available' | 'empty' | 'unavailable'
  checkedAt: string
  errors?: RecentDatabaseError[]
  occurredAt?: string | null
  fields?: Record<string, string | null>
  truncated?: boolean
  reason?: string
  aiSummary?: {
    status: 'available' | 'unavailable'
    summary?: string
    likelyCause?: string
    suggestedAction?: string
    confidence?: 'low' | 'medium' | 'high'
    providerName?: string
    model?: string
    incomplete?: boolean
    reason?: string
  }
}
type TeamCityAgentStatus = { status: 'online' | 'offline' | 'unknown'; instances: number; connectedInstances: number; reason?: string; runningBuilds: TeamCityBuild[] }
type Server = {
  name: string
  ip: string
  remoteHost?: string
  checkPort?: number
  teamCityAgent?: boolean
  group: 'Test machines' | 'Infrastructure'
  environment: string
  location: string
  status: 'online' | 'offline' | 'unknown'
  releaseVersion?: string
  deployedBuilds?: Record<string, string>
  deployment?: Deployment
  services?: Service[]
  diskSpace?: DiskSpace
  recentDatabaseError?: RecentDatabaseError
  agentStatus?: TeamCityAgentStatus
}
type TeamCityBuild = { id?: number; number?: string; webUrl?: string; startDate?: string; buildTypeId?: string; state?: string; component?: string }
type TeamCityPendingSource = { buildTypeId: string; name: string; pendingChanges: number; webUrl?: string }
type TeamCityComponent = {
  key: 'console' | 'api' | 'web'
  label: string
  buildTypeId: string
  webUrl?: string
  checkedConfigurations: number
  pendingChanges: number
  pendingSources: TeamCityPendingSource[]
  truncated?: boolean
  builds: TeamCityBuild[]
  activeBuild?: TeamCityBuild
  status: string
  canTrigger: boolean
  reason?: string
}
type Integration = { provider: string; status: string; reason?: string; id?: number; ref?: string; webUrl?: string; branch?: string; pendingChanges?: number; builds?: TeamCityBuild[]; components?: TeamCityComponent[] }
type CurrentRelease = { value?: string; defaultValue?: string; isOverride?: boolean; pipeline?: string; environment?: string; reason?: string }
type IntegrationResponse = { currentRelease?: CurrentRelease; gitlab?: Integration; teamcity?: Integration }
type DashboardConfig = { autoRefreshSeconds: number; statusRequestTimeoutMs: number }
type InfrastructureMachine = { name: string; ip: string; online: boolean; latencyMs: number | null; lastChecked: string }
type InfrastructurePanel = { title: string; servers: InfrastructureMachine[] }
type InfrastructureStatus = { panels: InfrastructurePanel[]; onlineCount: number; totalCount: number; generatedAt: string; refreshSeconds: number }
type Notice = { message: string; tone: 'info' | 'error' }
type ApprovalSummary = { status: 'available' | 'partial' | 'unknown'; pendingCount: number; readyCount: number; draftCount: number }
type AdPasswordSummary = { status: 'available' | 'partial'; expiredCount: number; expiringCount: number; mustChangeCount: number }
type ScheduledJobSummaryItem = { status: 'scheduled' | 'running' | 'completed'; nextRunAt: string | null; lastStatus: 'success' | 'failed' | null }
type ScheduledJobSummary = { jobs: ScheduledJobSummaryItem[]; timeZone: string }
type Section = 'overview' | 'servers' | 'delivery' | 'infrastructure' | 'approvals' | 'ad' | 'jobs'

const sectionPaths: Record<Section, string> = { overview: '/', servers: '/test-machines', delivery: '/delivery-systems', infrastructure: '/infrastructure-status', approvals: '/approvals', ad: '/ad-passwords', jobs: '/scheduled-jobs' }
function sectionFromPath(pathname: string): Section {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/servers' || path === '/test-machines') return 'servers'
  if (path === '/delivery-systems') return 'delivery'
  if (path === '/infrastructure-status') return 'infrastructure'
  if (path === '/approvals') return 'approvals'
  if (path === '/ad-passwords') return 'ad'
  if (path === '/scheduled-jobs') return 'jobs'
  return 'overview'
}

function deploymentTimeLabel(value?: string) {
  if (!value) return 'No recent pipeline run'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return 'Pipeline time unavailable'
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'Pipeline ran just now'
  if (minutes < 60) return `Pipeline ran ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Pipeline ran ${hours}h ago`
  return `Pipeline ran ${Math.floor(hours / 24)}d ago`
}

function formatDiskSize(bytes: number) {
  const gibibytes = bytes / (1024 ** 3)
  if (gibibytes >= 1) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(gibibytes)} GB`
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(bytes / (1024 ** 2))} MB`
}

function deploymentStatusLabel(deployment: Deployment) {
  if (deployment.status === 'available') {
    const count = deployment.changedComponents.length
    return `${count} ${count === 1 ? 'component update' : 'component updates'} ready`
  }
  if (deployment.status === 'current') return 'Latest builds are deployed'
  return 'Build comparison unavailable'
}

function normalizedReleaseBranch(value?: string) {
  const normalized = String(value || '').trim()
  return normalized && !normalized.toLowerCase().startsWith('v') ? `v${normalized}` : normalized
}

function componentBuildActionKey(componentKey: string, branch?: string) {
  return `build:${componentKey}:${normalizedReleaseBranch(branch).toLowerCase() || 'unconfigured'}`
}

function App() {
  const [servers, setServers] = useState<Server[]>([])
  const [activeSection, setActiveSection] = useState<Section>(() => sectionFromPath(window.location.pathname))
  const [adResetPending, setAdResetPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [apiHealthy, setApiHealthy] = useState(false)
  const [lastRefresh, setLastRefresh] = useState('Not checked')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pendingActions, setPendingActions] = useState<string[]>([])
  const [refreshingServers, setRefreshingServers] = useState<string[]>([])
  const [integrations, setIntegrations] = useState<IntegrationResponse>({})
  const [integrationsLoading, setIntegrationsLoading] = useState(false)
  const [releaseInput, setReleaseInput] = useState('')
  const [infrastructure, setInfrastructure] = useState<InfrastructureStatus>()
  const [infrastructureLoading, setInfrastructureLoading] = useState(false)
  const [infrastructureError, setInfrastructureError] = useState<string>()
  const [infrastructureLastRefresh, setInfrastructureLastRefresh] = useState('Not checked')
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary>()
  const [adPasswordSummary, setAdPasswordSummary] = useState<AdPasswordSummary>()
  const [scheduledJobSummary, setScheduledJobSummary] = useState<ScheduledJobSummary>()
  const [approvalSummaryError, setApprovalSummaryError] = useState(false)
  const [adPasswordSummaryError, setAdPasswordSummaryError] = useState(false)
  const [scheduledJobSummaryError, setScheduledJobSummaryError] = useState(false)
  const [overviewSummaryLoading, setOverviewSummaryLoading] = useState(false)
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(30)
  const teamCityReleaseBranch = integrations.teamcity?.branch

  const noticeTimer = useRef<number | null>(null)
  const fullRefreshInFlight = useRef(false)
  const serverRefreshInFlight = useRef(new Set<string>())
  const serverRefreshIds = useRef(new Map<string, number>())
  const actionInFlight = useRef(new Set<string>())
  const actionPollTimers = useRef(new Map<string, number>())
  const overviewSummaryInFlight = useRef(false)
  const statusRequestTimeoutMs = useRef(240000)
  const integrationRefreshId = useRef(0)
  const selectedIntegrationRelease = useRef('')
  const lastSuccessfulIntegrationRelease = useRef('')
  const visibleIntegrationBranch = useRef('')
  const lastSuccessfulIntegrationBranch = useRef('')

  const showNotice = useCallback((message: string, tone: Notice['tone'] = 'info', durationMs = 3200) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice({ message, tone })
    noticeTimer.current = durationMs > 0 ? window.setTimeout(() => setNotice(null), durationMs) : null
  }, [])

  const refreshServers = useCallback(async (force = false) => {
    if (fullRefreshInFlight.current) return
    fullRefreshInFlight.current = true
    setLoading(true)
    try {
      const nextServers = await apiRequest<Server[]>(`/api/servers${force ? '?refresh=1' : ''}`, {}, statusRequestTimeoutMs.current)
      setServers(nextServers)
      setLastRefresh(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
      setApiHealthy(true)
    } catch (error) {
      setApiHealthy(false)
      showNotice(error instanceof Error ? error.message : 'Unable to load live server status', 'error')
    } finally {
      fullRefreshInFlight.current = false
      setLoading(false)
    }
  }, [showNotice])

  const refreshServer = useCallback(async (serverName: string) => {
    if (serverRefreshInFlight.current.has(serverName)) return
    serverRefreshInFlight.current.add(serverName)
    const refreshId = (serverRefreshIds.current.get(serverName) || 0) + 1
    serverRefreshIds.current.set(serverName, refreshId)
    setRefreshingServers((current) => [...current, serverName])
    try {
      const nextServer = await apiRequest<Server>(`/api/servers/${encodeURIComponent(serverName)}?refresh=1`, {}, statusRequestTimeoutMs.current)
      if (serverRefreshIds.current.get(serverName) !== refreshId) return
      setServers((current) => current.map((server) => server.name === nextServer.name ? nextServer : server))
      setLastRefresh(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
      setApiHealthy(true)
      showNotice(`${serverName} status refreshed`)
    } catch (error) {
      setApiHealthy(false)
      showNotice(error instanceof Error ? error.message : `Unable to check ${serverName}`, 'error')
    } finally {
      serverRefreshInFlight.current.delete(serverName)
      setRefreshingServers((current) => current.filter((name) => name !== serverName))
    }
  }, [showNotice])

  const refreshIntegrations = useCallback(async (releaseOverride?: string) => {
    const selectedRelease = releaseOverride !== undefined ? releaseOverride : selectedIntegrationRelease.current
    const refreshId = integrationRefreshId.current + 1
    integrationRefreshId.current = refreshId
    setIntegrationsLoading(true)
    try {
      const result = await apiRequest<IntegrationResponse>(`/api/integrations${selectedRelease ? `?release=${encodeURIComponent(selectedRelease)}` : ''}`)
      if (refreshId !== integrationRefreshId.current) return
      const successfulRelease = result.currentRelease?.isOverride ? result.currentRelease.value || selectedRelease : ''
      const successfulBranch = result.teamcity?.branch || normalizedReleaseBranch(result.currentRelease?.value)
      selectedIntegrationRelease.current = successfulRelease
      lastSuccessfulIntegrationRelease.current = successfulRelease
      visibleIntegrationBranch.current = successfulBranch
      lastSuccessfulIntegrationBranch.current = successfulBranch
      setIntegrations(result)
      setReleaseInput((current) => current || result.currentRelease?.value || '')
    } catch (error) {
      if (refreshId !== integrationRefreshId.current) return
      selectedIntegrationRelease.current = lastSuccessfulIntegrationRelease.current
      visibleIntegrationBranch.current = lastSuccessfulIntegrationBranch.current
      showNotice(error instanceof Error ? error.message : 'Unable to load pipeline status', 'error')
    } finally {
      if (refreshId === integrationRefreshId.current) setIntegrationsLoading(false)
    }
  }, [showNotice])

  const refreshInfrastructure = useCallback(async (force = false) => {
    setInfrastructureLoading(true)
    try {
      const result = await apiRequest<InfrastructureStatus>(`/api/infrastructure-status${force ? '?refresh=1' : ''}`, {}, 10000)
      setInfrastructure(result)
      setInfrastructureError(undefined)
      setInfrastructureLastRefresh(new Date(result.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
      setApiHealthy(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to check infrastructure status'
      setInfrastructureError(message)
      showNotice(message, 'error')
    } finally {
      setInfrastructureLoading(false)
    }
  }, [showNotice])

  const refreshOverviewSummaries = useCallback(async () => {
    if (overviewSummaryInFlight.current) return
    overviewSummaryInFlight.current = true
    setOverviewSummaryLoading(true)
    const [approvalsResult, adResult, scheduledJobsResult] = await Promise.allSettled([
      apiRequest<ApprovalSummary>('/api/gitlab/approval-summary', {}, 65000),
      apiRequest<AdPasswordSummary>('/api/ad/summary', {}, 80000),
      apiRequest<ScheduledJobSummary>('/api/scheduled-jobs'),
    ])
    if (approvalsResult.status === 'fulfilled') {
      setApprovalSummary(approvalsResult.value)
      setApprovalSummaryError(false)
    } else {
      setApprovalSummaryError(true)
    }
    if (adResult.status === 'fulfilled') {
      setAdPasswordSummary(adResult.value)
      setAdPasswordSummaryError(false)
    } else {
      setAdPasswordSummaryError(true)
    }
    if (scheduledJobsResult.status === 'fulfilled') {
      setScheduledJobSummary(scheduledJobsResult.value)
      setScheduledJobSummaryError(false)
    } else {
      setScheduledJobSummaryError(true)
    }
    overviewSummaryInFlight.current = false
    setOverviewSummaryLoading(false)
  }, [])

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refreshServers()
      void refreshIntegrations()
      void refreshInfrastructure()
      void apiRequest<DashboardConfig>('/api/config')
        .then((config) => {
          setAutoRefreshSeconds(config.autoRefreshSeconds)
          statusRequestTimeoutMs.current = config.statusRequestTimeoutMs
        })
        .catch((error) => showNotice(error instanceof Error ? error.message : 'Unable to load dashboard configuration', 'error'))
    }, 0)
    return () => window.clearTimeout(initialRefresh)
  }, [refreshInfrastructure, refreshIntegrations, refreshServers, showNotice])

  useEffect(() => {
    const intervalMs = autoRefreshSeconds * 1000
    const serverTimer = window.setInterval(() => void refreshServers(true), intervalMs)
    const integrationTimer = window.setInterval(() => void refreshIntegrations(), intervalMs)
    const infrastructureTimer = window.setInterval(() => void refreshInfrastructure(), intervalMs)
    return () => {
      window.clearInterval(serverTimer)
      window.clearInterval(integrationTimer)
      window.clearInterval(infrastructureTimer)
    }
  }, [autoRefreshSeconds, refreshInfrastructure, refreshIntegrations, refreshServers])

  useEffect(() => {
    if (activeSection !== 'overview') return
    const initial = window.setTimeout(() => void refreshOverviewSummaries(), 0)
    const interval = window.setInterval(() => void refreshOverviewSummaries(), Math.max(autoRefreshSeconds, 60) * 1000)
    return () => { window.clearTimeout(initial); window.clearInterval(interval) }
  }, [activeSection, autoRefreshSeconds, refreshOverviewSummaries])

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    actionPollTimers.current.forEach((timer) => window.clearTimeout(timer))
    actionPollTimers.current.clear()
  }, [])

  useEffect(() => {
    const handleHistoryNavigation = () => {
      const nextSection = sectionFromPath(window.location.pathname)
      if (adResetPending && nextSection !== 'ad') {
        window.history.pushState(null, '', sectionPaths.ad)
        return
      }
      setActiveSection(nextSection)
      const target = window.location.hash.slice(1)
      window.setTimeout(() => target ? document.getElementById(target)?.scrollIntoView({ block: 'start' }) : window.scrollTo({ top: 0 }), 0)
    }
    window.addEventListener('popstate', handleHistoryNavigation)
    return () => window.removeEventListener('popstate', handleHistoryNavigation)
  }, [adResetPending])

  useEffect(() => {
    const title = activeSection === 'ad' ? 'AD passwords' : activeSection === 'jobs' ? 'Scheduled jobs' : activeSection === 'servers' ? 'Test machines' : activeSection === 'delivery' ? 'Delivery systems' : activeSection === 'infrastructure' ? 'Infrastructure status' : activeSection[0].toUpperCase() + activeSection.slice(1)
    document.title = `${title} · Pulseboard`
    const target = window.location.hash.slice(1)
    window.setTimeout(() => target ? document.getElementById(target)?.scrollIntoView({ block: 'start' }) : window.scrollTo({ top: 0 }), 0)
  }, [activeSection])

  const clearPendingAction = useCallback((actionKey: string) => {
    actionInFlight.current.delete(actionKey)
    setPendingActions((current) => current.filter((key) => key !== actionKey))
    const timer = actionPollTimers.current.get(actionKey)
    if (timer) window.clearTimeout(timer)
    actionPollTimers.current.delete(actionKey)
  }, [])

  const pollTeamCityAction = useCallback((serverName: string, serviceName: string, action: ServiceAction, actionKey: string, buildId: number | string) => {
    let attempts = 0
    let transientFailures = 0
    const poll = async () => {
      attempts += 1
      try {
        const result = await apiRequest<{ status: string; reason?: string }>(`/api/teamcity/builds/${encodeURIComponent(String(buildId))}`)
        transientFailures = 0
        if (result.status === 'queued' || result.status === 'running') {
          if (attempts < 90) {
            showNotice(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${serviceName} on ${serverName} via TeamCity...`, 'info', 0)
            const timer = window.setTimeout(() => void poll(), 2000)
            actionPollTimers.current.set(actionKey, timer)
          } else {
            clearPendingAction(actionKey)
            showNotice(`TeamCity is still processing ${serviceName}; check the build status`, 'error')
          }
          return
        }
        clearPendingAction(actionKey)
        if (result.status === 'success') {
          showNotice(action === 'restart' ? `${serviceName} restarted successfully on ${serverName}` : `${serviceName} is ${action === 'start' ? 'running' : 'stopped'} on ${serverName}`)
          void refreshServer(serverName)
        } else {
          showNotice(result.reason || `Unable to ${action} ${serviceName}`, 'error')
        }
      } catch (error) {
        transientFailures += 1
        if (transientFailures < 3 && attempts < 90) {
          const timer = window.setTimeout(() => void poll(), 2000)
          actionPollTimers.current.set(actionKey, timer)
          return
        }
        clearPendingAction(actionKey)
        showNotice(error instanceof Error ? error.message : `Unable to read TeamCity status for ${serviceName}`, 'error')
      }
    }
    void poll()
  }, [clearPendingAction, refreshServer, showNotice])

  const handleServiceAction = useCallback(async (serverName: string, serviceName: string, action: ServiceAction) => {
    const actionKey = `${serverName}:${serviceName}`
    if (actionInFlight.current.has(actionKey)) return
    if (action === 'stop' && !window.confirm(`Stop ${serviceName} on ${serverName}?`)) return
    if (action === 'restart' && !window.confirm(`Restart IIS on ${serverName}? Web requests to this test server may be interrupted briefly.`)) return

    actionInFlight.current.add(actionKey)
    setPendingActions((current) => [...current, actionKey])
    try {
      const result = await apiRequest<{ status: string; reason?: string; buildId?: number | string }>(
        action === 'restart'
          ? `/api/servers/${encodeURIComponent(serverName)}/iis/restart`
          : `/api/servers/${encodeURIComponent(serverName)}/services/${encodeURIComponent(serviceName)}/${action}`,
        { method: 'POST', headers: { 'X-Pulseboard-Request': '1' } },
      )
      const expectedStatus = action === 'start' ? 'running' : action === 'stop' ? 'stopped' : 'restarted'
      if (result.status === expectedStatus) {
        clearPendingAction(actionKey)
        showNotice(action === 'restart' ? `IIS restarted successfully on ${serverName}` : `${serviceName} is ${result.status} on ${serverName}`)
        void refreshServer(serverName)
      } else if (result.status === 'queued' && result.buildId) {
        showNotice(`${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${serviceName} on ${serverName} via TeamCity...`, 'info', 0)
        pollTeamCityAction(serverName, serviceName, action, actionKey, result.buildId)
      } else {
        clearPendingAction(actionKey)
        showNotice(result.reason || `Unable to ${action} ${serviceName}`, 'error')
      }
    } catch (error) {
      clearPendingAction(actionKey)
      showNotice(error instanceof Error ? error.message : `Unable to ${action} ${serviceName}`, 'error')
    }
  }, [clearPendingAction, pollTeamCityAction, refreshServer, showNotice])

  const pollDeployment = useCallback((serverName: string, actionKey: string, buildId: number | string) => {
    let attempts = 0
    let transientFailures = 0
    const poll = async () => {
      attempts += 1
      try {
        const result = await apiRequest<{ status: string; reason?: string }>(`/api/teamcity/builds/${encodeURIComponent(String(buildId))}`)
        transientFailures = 0
        if (result.status === 'queued' || result.status === 'running') {
          if (attempts < 180) {
            showNotice(`Deploying the latest builds to ${serverName} via TeamCity...`, 'info', 0)
            const timer = window.setTimeout(() => void poll(), 3000)
            actionPollTimers.current.set(actionKey, timer)
          } else {
            clearPendingAction(actionKey)
            showNotice(`TeamCity is still deploying to ${serverName}; check the pipeline for progress`, 'error')
          }
          return
        }
        clearPendingAction(actionKey)
        if (result.status === 'success') {
          showNotice(`Deployment finished on ${serverName}.`)
          void refreshServer(serverName)
        } else {
          showNotice(result.reason || `Deployment to ${serverName} did not complete successfully`, 'error')
        }
      } catch (error) {
        transientFailures += 1
        if (transientFailures < 3 && attempts < 180) {
          const timer = window.setTimeout(() => void poll(), 3000)
          actionPollTimers.current.set(actionKey, timer)
          return
        }
        clearPendingAction(actionKey)
        showNotice(error instanceof Error ? error.message : `Unable to read deployment status for ${serverName}`, 'error')
      }
    }
    void poll()
  }, [clearPendingAction, refreshServer, showNotice])

  const handleDeployment = useCallback(async (server: Server) => {
    const deployment = server.deployment
    if (!deployment?.canDeploy) return
    const actionKey = `deploy:${server.name}`
    if (actionInFlight.current.has(actionKey)) return
    const changes = deployment.comparisons
      .filter((comparison) => comparison.status === 'available')
      .map((comparison) => `${comparison.name} ${comparison.deployed || 'unknown'} → ${comparison.available || 'latest'}`)
      .join(', ')
    const release = deployment.branch ? ` from ${deployment.branch}` : ''
    if (!window.confirm(`Deploy the latest builds${release} to ${server.name}?\n\n${changes}\n\nThis starts the TeamCity deployment pipeline and may log off active users.`)) return

    actionInFlight.current.add(actionKey)
    setPendingActions((current) => [...current, actionKey])
    try {
      const result = await apiRequest<{ status: string; reason?: string; buildId?: number | string }>(
        `/api/servers/${encodeURIComponent(server.name)}/deploy`,
        { method: 'POST', headers: { 'X-Pulseboard-Request': '1' } },
      )
      if (result.status === 'queued' && result.buildId) {
        showNotice(`Deployment to ${server.name} queued in TeamCity...`, 'info', 0)
        pollDeployment(server.name, actionKey, result.buildId)
      } else {
        clearPendingAction(actionKey)
        showNotice(result.reason || `Unable to queue deployment to ${server.name}`, 'error')
      }
    } catch (error) {
      clearPendingAction(actionKey)
      showNotice(error instanceof Error ? error.message : `Unable to queue deployment to ${server.name}`, 'error')
    }
  }, [clearPendingAction, pollDeployment, showNotice])

  const pollComponentBuild = useCallback((component: TeamCityComponent, branch: string, actionKey: string, buildId: number | string) => {
    let attempts = 0
    let transientFailures = 0
    const poll = async () => {
      attempts += 1
      try {
        const result = await apiRequest<{ status: string; reason?: string }>(`/api/teamcity/builds/${encodeURIComponent(String(buildId))}`)
        transientFailures = 0
        if (result.status === 'queued' || result.status === 'running') {
          if (attempts < 180) {
            if (normalizedReleaseBranch(visibleIntegrationBranch.current) === normalizedReleaseBranch(branch)) {
              showNotice(`${component.label} build is ${result.status} for ${branch}...`, 'info', 0)
            }
            const timer = window.setTimeout(() => void poll(), 3000)
            actionPollTimers.current.set(actionKey, timer)
          } else {
            clearPendingAction(actionKey)
            if (normalizedReleaseBranch(visibleIntegrationBranch.current) === normalizedReleaseBranch(branch)) {
              showNotice(`${component.label} is still building for ${branch}; check TeamCity for progress`, 'error')
            }
          }
          return
        }
        clearPendingAction(actionKey)
        if (normalizedReleaseBranch(visibleIntegrationBranch.current) === normalizedReleaseBranch(branch)) {
          if (result.status === 'success') showNotice(`${component.label} build completed successfully for ${branch}`)
          else showNotice(result.reason || `${component.label} build did not complete successfully for ${branch}`, 'error')
        }
        void refreshIntegrations()
      } catch (error) {
        transientFailures += 1
        if (transientFailures < 3 && attempts < 180) {
          const timer = window.setTimeout(() => void poll(), 3000)
          actionPollTimers.current.set(actionKey, timer)
          return
        }
        clearPendingAction(actionKey)
        if (normalizedReleaseBranch(visibleIntegrationBranch.current) === normalizedReleaseBranch(branch)) {
          showNotice(error instanceof Error ? error.message : `Unable to read ${component.label} build status`, 'error')
        }
      }
    }
    void poll()
  }, [clearPendingAction, refreshIntegrations, showNotice])

  const handleComponentBuild = useCallback(async (component: TeamCityComponent) => {
    if (!component.canTrigger) return
    const branch = teamCityReleaseBranch || 'CURRENT_RELEASE'
    const actionKey = componentBuildActionKey(component.key, branch)
    if (actionInFlight.current.has(actionKey)) return
    const pendingLabel = `${component.pendingChanges}${component.truncated ? '+' : ''} pending ${component.pendingChanges === 1 ? 'change' : 'changes'}`
    const sourceLabel = component.pendingSources.length > 1
      ? ` across ${component.pendingSources.length} configurations`
      : component.pendingSources[0]?.name ? ` in ${component.pendingSources[0].name}` : ''
    const dependencyWarning = component.key === 'console'
      ? `\n\nTeamCity will also run the required Console dependency builds.`
      : ''
    const customVersionWarning = integrations.currentRelease?.isOverride
      ? `\n\nCUSTOM VERSION: ${branch}\nConfigured release: ${integrations.currentRelease.defaultValue || 'not configured'}\n\nConfirm that you intend to queue this exact custom release.`
      : ''
    if (!window.confirm(`Trigger the ${component.label} build for ${branch}?\n\n${pendingLabel}${sourceLabel}.${dependencyWarning}${customVersionWarning}`)) return

    actionInFlight.current.add(actionKey)
    setPendingActions((current) => [...current, actionKey])
    try {
      const result = await apiRequest<{ status: string; reason?: string; buildId?: number | string; branch?: string }>(
        `/api/teamcity/components/${encodeURIComponent(component.key)}/trigger`,
        integrations.currentRelease?.isOverride
          ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulseboard-Request': '1' }, body: JSON.stringify({ release: branch }) }
          : { method: 'POST', headers: { 'X-Pulseboard-Request': '1' } },
      )
      if (result.status === 'queued' && result.buildId) {
        const queuedBranch = result.branch || branch
        showNotice(`${component.label} build queued for ${queuedBranch}...`, 'info', 0)
        void refreshIntegrations()
        pollComponentBuild(component, queuedBranch, actionKey, result.buildId)
      } else {
        clearPendingAction(actionKey)
        showNotice(result.reason || `Unable to queue the ${component.label} build`, 'error')
      }
    } catch (error) {
      clearPendingAction(actionKey)
      showNotice(error instanceof Error ? error.message : `Unable to queue the ${component.label} build`, 'error')
      void refreshIntegrations()
    }
  }, [clearPendingAction, integrations.currentRelease, pollComponentBuild, refreshIntegrations, showNotice, teamCityReleaseBranch])

  const handleReleaseCheck = async (event: FormEvent) => {
    event.preventDefault()
    const value = releaseInput.trim()
    if (!value) { showNotice('Enter a version to check.', 'error'); return }
    selectedIntegrationRelease.current = value
    visibleIntegrationBranch.current = normalizedReleaseBranch(value)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice(null)
    await refreshIntegrations(value)
  }

  const handleUseConfiguredRelease = async () => {
    selectedIntegrationRelease.current = ''
    visibleIntegrationBranch.current = normalizedReleaseBranch(integrations.currentRelease?.defaultValue)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice(null)
    setReleaseInput(integrations.currentRelease?.defaultValue || '')
    await refreshIntegrations('')
  }

  const testMachines = useMemo(() => servers.filter((server) => server.group === 'Test machines'), [servers])
  const deliveryServers = useMemo(() => servers.filter((server) => server.environment === 'CI' || server.teamCityAgent), [servers])
  const visibleServers = testMachines
  const onlineCount = testMachines.filter((server) => server.status === 'online').length
  const deliveryOnlineCount = deliveryServers.filter((server) => server.status === 'online').length
  const services = testMachines.flatMap((server) => server.services ?? [])
  const stoppedServices = services.filter((service) => service.status === 'stopped').length
  const unknownServices = services.filter((service) => service.status === 'unknown').length
  const diskVolumes = testMachines.flatMap((server) => server.diskSpace?.volumes ?? [])
  const diskAlerts = diskVolumes.filter((volume) => volume.status !== 'healthy')
  const criticalDiskCount = diskVolumes.filter((volume) => volume.status === 'critical').length
  const unknownDiskMachines = testMachines.filter((server) => server.services && server.diskSpace?.status !== 'available').length
  const deploymentComparisons = testMachines.filter((server) => server.deployment)
  const deploymentUpdates = testMachines.filter((server) => server.deployment?.status === 'available')
  const unknownDeployments = deploymentComparisons.filter((server) => server.deployment?.status === 'unknown').length
  const deploymentComponentUpdates = deploymentUpdates.reduce((total, server) => total + (server.deployment?.changedComponents.length || 0), 0)
  const availability = testMachines.length ? Math.round((onlineCount / testMachines.length) * 100) : null
  const teamCityComponents = integrations.teamcity?.components ?? []
  const knownTeamCityComponents = teamCityComponents.filter((component) => component.status !== 'unknown')
  const teamCityPendingDetail = knownTeamCityComponents.length
    ? teamCityComponents.map((component) => `${component.label} ${component.status === 'unknown' ? 'unavailable' : `${component.pendingChanges}${component.truncated ? '+' : ''}`}`).join(' · ')
    : integrations.teamcity ? 'Build data unavailable' : 'Loading build activity...'
  const scheduledJobs = scheduledJobSummary?.jobs ?? []
  const activeScheduledJobs = scheduledJobs.filter((job) => job.status === 'scheduled' || job.status === 'running').length
  const runningScheduledJobs = scheduledJobs.filter((job) => job.status === 'running').length
  const failedScheduledJobs = scheduledJobs.filter((job) => job.lastStatus === 'failed').length
  const nextScheduledRun = scheduledJobs
    .filter((job) => job.nextRunAt && !Number.isNaN(Date.parse(job.nextRunAt)))
    .sort((left, right) => Date.parse(left.nextRunAt!) - Date.parse(right.nextRunAt!))[0]?.nextRunAt
  const scheduledJobDetail = scheduledJobSummaryError
    ? 'Scheduled-job summary unavailable'
    : !scheduledJobSummary
      ? 'Checking scheduled automation'
      : runningScheduledJobs
        ? `${runningScheduledJobs} running${failedScheduledJobs ? ` · ${failedScheduledJobs} previous failures` : ''}`
        : nextScheduledRun
          ? `Next ${new Date(nextScheduledRun).toLocaleString([], { timeZone: scheduledJobSummary.timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${failedScheduledJobs ? ` · ${failedScheduledJobs} previous failures` : ''}`
          : scheduledJobs.length ? 'No future runs scheduled' : 'No automation configured'

  const navigateTo = (section: Section, target?: string) => {
    if (adResetPending) return
    const destination = `${sectionPaths[section]}${target ? `#${target}` : ''}`
    window.history.pushState(null, '', destination)
    setActiveSection(section)
    window.setTimeout(() => target ? document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : window.scrollTo({ top: 0, behavior: 'smooth' }), 0)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">+</span><span>Pulseboard</span></div>
        <div className="workspace-label">Workspace</div>
        <nav aria-label="Primary">
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'overview' ? 'active' : ''}`} onClick={() => navigateTo('overview')}><span>◈</span>Overview</button>
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'servers' ? 'active' : ''}`} onClick={() => navigateTo('servers')}><span>▦</span>Test machines <b>{testMachines.length}</b></button>
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'delivery' ? 'active' : ''}`} onClick={() => navigateTo('delivery')}><span>▰</span>Delivery systems <b>{deliveryServers.length}</b></button>
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'infrastructure' ? 'active' : ''}`} onClick={() => navigateTo('infrastructure')}><span>⌁</span>Infrastructure <b>{infrastructure?.totalCount ?? '—'}</b></button>
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'approvals' ? 'active' : ''}`} aria-label="GitLab approvals" onClick={() => navigateTo('approvals')}><span>✓</span>Approvals</button>
          <button type="button" disabled={adResetPending} className={`nav-item ${activeSection === 'jobs' ? 'active' : ''}`} aria-label="Scheduled jobs" onClick={() => navigateTo('jobs')}><span>◷</span>Scheduled jobs</button>
          <button type="button" className={`nav-item ${activeSection === 'ad' ? 'active' : ''}`} aria-label="AD passwords" onClick={() => navigateTo('ad')}><span>⚿</span>AD passwords</button>
        </nav>
        <div className="sidebar-bottom"><div className="account-dot">OP</div><div><strong>Operations</strong><small>Protected workspace</small></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Operations <span>/</span> <strong>{activeSection === 'ad' ? 'AD passwords' : activeSection === 'jobs' ? 'Scheduled jobs' : activeSection === 'servers' ? 'Test machines' : activeSection === 'delivery' ? 'Delivery systems' : activeSection === 'infrastructure' ? 'Infrastructure status' : activeSection === 'approvals' ? 'Approvals' : 'Overview'}</strong></div>
          <div className="top-actions">
            <span className={`live-indicator ${apiHealthy ? '' : 'disconnected'}`}><i />{apiHealthy ? 'Live monitoring' : 'Connection unavailable'}</span>
            <div className="avatar" aria-hidden="true">OP</div>
          </div>
        </header>

        <div className="content-wrap">
          {activeSection === 'ad' && <AdPasswords onResetPending={setAdResetPending} />}
          {activeSection === 'jobs' && <ScheduledJobs />}
          {activeSection === 'overview' && <>
          <section id="overview" className="page-heading">
            <div><p className="eyebrow">Operations workspace</p><h1>Workspace overview</h1><p className="subheading">A summary of server health, scheduled automation, release approvals, and account operations.</p></div>
            <button type="button" className="refresh-button" disabled={loading || overviewSummaryLoading} onClick={() => { void refreshServers(true); void refreshIntegrations(); void refreshOverviewSummaries() }} title="Refresh all overview summaries"><span>↻</span> Refresh <small>{loading || overviewSummaryLoading ? 'checking...' : lastRefresh}</small></button>
          </section>

          <section className="overview-page-grid" aria-label="Workspace areas">
            <button type="button" className="overview-page-card servers" onClick={() => navigateTo('servers')}>
              <span className="stat-icon green" aria-hidden="true">▦</span>
              <span className="overview-page-copy"><small>Test machines</small><strong>{onlineCount}<span> / {testMachines.length} online</span></strong><span>{availability === null ? 'Waiting for machine status' : `${availability}% availability across the daily test environment`}</span></span>
              <span className="overview-page-action">Open test machines →</span>
            </button>
            <button type="button" className="overview-page-card infrastructure" onClick={() => navigateTo('infrastructure')}>
              <span className="stat-icon green" aria-hidden="true">⌁</span>
              <span className="overview-page-copy"><small>Engineering infrastructure</small><strong>{infrastructure?.onlineCount ?? '…'}<span> / {infrastructure?.totalCount ?? '…'} online</span></strong><span>{infrastructureError || 'ICMP availability across engineering systems'}</span></span>
              <span className="overview-page-action">Open infrastructure →</span>
            </button>
            <button type="button" className="overview-page-card delivery" onClick={() => navigateTo('delivery')}>
              <span className="stat-icon amber" aria-hidden="true">▰</span>
              <span className="overview-page-copy"><small>Delivery systems</small><strong>{deliveryOnlineCount}<span> / {deliveryServers.length} online</span></strong><span>{teamCityPendingDetail}</span></span>
              <span className="overview-page-action">Open delivery systems →</span>
            </button>
            <button type="button" className="overview-page-card approvals" onClick={() => navigateTo('approvals')}>
              <span className="stat-icon blue" aria-hidden="true">✓</span>
              <span className="overview-page-copy"><small>Approvals pending</small><strong>{approvalSummaryError ? '—' : approvalSummary?.pendingCount ?? '…'}<span> merge requests</span></strong><span>{approvalSummaryError ? 'Approval summary unavailable' : approvalSummary ? `${approvalSummary.readyCount} ready · ${approvalSummary.draftCount} draft` : 'Checking Code Freeze approvals'}</span></span>
              <span className="overview-page-action">Open approvals →</span>
            </button>
            <button type="button" className="overview-page-card jobs" onClick={() => navigateTo('jobs')}>
              <span className="stat-icon amber" aria-hidden="true">◷</span>
              <span className="overview-page-copy"><small>Scheduled jobs</small><strong>{scheduledJobSummaryError ? '—' : scheduledJobSummary ? scheduledJobs.length : '…'}<span> configured</span></strong><span>{scheduledJobDetail}{scheduledJobSummary && scheduledJobs.length ? ` · ${activeScheduledJobs} active` : ''}</span></span>
              <span className="overview-page-action">Open scheduled jobs →</span>
            </button>
            <button type="button" className="overview-page-card ad" onClick={() => navigateTo('ad')}>
              <span className="stat-icon purple" aria-hidden="true">⚿</span>
              <span className="overview-page-copy"><small>AD passwords</small><strong>{adPasswordSummaryError ? '—' : adPasswordSummary?.expiredCount ?? '…'}<span> expired</span></strong><span>{adPasswordSummaryError ? 'AD password summary unavailable' : adPasswordSummary ? `${adPasswordSummary.expiringCount} expiring within 7 days${adPasswordSummary.mustChangeCount ? ` · ${adPasswordSummary.mustChangeCount} must change` : ''}` : 'Checking expired and expiring users'}</span></span>
              <span className="overview-page-action">Open AD passwords →</span>
            </button>
          </section>

          <div className="section-header overview-summary-heading">
            <div><h2>Test environment snapshot</h2><p>Live health and delivery signals from the Test machines page.</p></div>
            <button type="button" className="stat-detail-link" onClick={() => navigateTo('servers')}>View machine details →</button>
          </div>
          <section className="stats-grid" aria-label="Infrastructure summary">
            <div className="stat-card"><span className="stat-icon green">⌁</span><div><small>Test machines online</small><strong>{onlineCount}<span> / {testMachines.length}</span></strong><p className={availability === 100 ? 'positive' : availability === null ? 'muted' : 'warning'}>{availability === null ? 'Waiting for data' : `${availability}% availability`}</p></div></div>
            <div className="stat-card"><span className="stat-icon amber">◇</span><div><small>Services stopped</small><strong>{stoppedServices}<span> need attention</span></strong><p className={stoppedServices ? 'warning' : 'muted'}>{unknownServices ? `${unknownServices} status unknown` : stoppedServices ? 'Requires action' : 'No stopped services'}</p></div></div>
            <div className="stat-card"><span className="stat-icon blue">⇧</span><div><small>Deployments available</small><strong>{deploymentUpdates.length}<span> machines</span></strong><p className={deploymentUpdates.length ? 'warning' : unknownDeployments ? 'muted' : deploymentComparisons.length ? 'positive' : 'muted'}>{deploymentUpdates.length ? `${deploymentComponentUpdates} component updates ready` : unknownDeployments ? `${unknownDeployments} machine comparisons unavailable` : deploymentComparisons.length ? 'All detected builds current' : 'Waiting for data'}</p></div></div>
            <div className="stat-card"><span className="stat-icon purple">◒</span><div><small>Disk space alerts</small><strong>{diskAlerts.length}<span> volumes</span></strong><p className={criticalDiskCount ? 'critical' : diskAlerts.length ? 'warning' : diskVolumes.length ? 'positive' : 'muted'}>{criticalDiskCount ? `${criticalDiskCount} critically low` : diskAlerts.length ? 'Low free space' : unknownDiskMachines ? `${unknownDiskMachines} machines unavailable` : diskVolumes.length ? 'Capacity healthy' : loading ? 'Checking disk capacity' : 'Disk data unavailable'}</p></div></div>
          </section>
          </>}

          {activeSection === 'infrastructure' && <>
          <section className="page-heading">
            <div><p className="eyebrow">Engineering estate</p><h1>Infrastructure status</h1><p className="subheading">ICMP availability and response time for servers used across Engineering.</p></div>
            <button type="button" className="refresh-button" disabled={infrastructureLoading} onClick={() => void refreshInfrastructure(true)} title="Run a fresh ping check for every infrastructure server"><span>↻</span> Refresh <small>{infrastructureLoading ? 'checking...' : infrastructureLastRefresh}</small></button>
          </section>
          <section className="infrastructure-summary" aria-label="Infrastructure availability summary">
            <div><span className="stat-icon green" aria-hidden="true">⌁</span><div><small>Servers online</small><strong>{infrastructure?.onlineCount ?? '—'} <span>/ {infrastructure?.totalCount ?? '—'}</span></strong></div></div>
            <p>{infrastructureError || (infrastructure ? `Last completed ${new Date(infrastructure.generatedAt).toLocaleString()} · refreshes every ${infrastructure.refreshSeconds} seconds` : 'Checking infrastructure...')}</p>
          </section>
          {infrastructureError && !infrastructure && <div className="loading-state infrastructure-error" role="alert">{infrastructureError}</div>}
          {infrastructure?.panels.map((panel) => <section className="infrastructure-panel" key={panel.title}>
            <div className="section-header compact"><div><h2>{panel.title}</h2><p>{panel.servers.filter((server) => server.online).length} of {panel.servers.length} online</p></div></div>
            <div className="infrastructure-grid" aria-live="polite">
              {panel.servers.map((server) => <article className={`infrastructure-card ${server.online ? 'online' : 'offline'}`} key={server.name}>
                <div className="infrastructure-card-heading"><span className={`server-status ${server.online ? 'online' : 'offline'}`} aria-label={server.online ? 'online' : 'offline'} /><h3>{server.name}</h3><strong>{server.online ? 'Online' : 'Offline'}</strong></div>
                <p>{server.ip}</p>
                <div><span>{server.latencyMs === null ? 'No response' : `${server.latencyMs} ms`}</span><time dateTime={server.lastChecked}>{new Date(server.lastChecked).toLocaleTimeString()}</time></div>
              </article>)}
            </div>
          </section>)}
          </>}

          {activeSection === 'approvals' && <>
          <section className="page-heading">
            <div><p className="eyebrow">Release governance</p><h1>Merge request approvals</h1><p className="subheading">Review Code Freeze requests and critical AI suggestions before approving.</p></div>
          </section>
          <GitLabApprovals autoRefreshSeconds={autoRefreshSeconds} refreshKey={0} onNotice={showNotice} />
          </>}

          {activeSection === 'delivery' && <>
          <section className="page-heading">
            <div><p className="eyebrow">CI/CD operations</p><h1>Delivery systems</h1><p className="subheading">Check release activity, pipelines, runners, and build agents in one place.</p></div>
            <button type="button" className="refresh-button" disabled={loading || integrationsLoading} onClick={() => { void refreshServers(true); void refreshIntegrations() }} title={`Auto-refreshes every ${autoRefreshSeconds} seconds`}><span>↻</span> Refresh <small>{loading || integrationsLoading ? 'checking...' : lastRefresh}</small></button>
          </section>

          <form className="delivery-version-form" onSubmit={(event) => void handleReleaseCheck(event)}>
            <div><label htmlFor="delivery-version">Release version</label><p>Check GitLab and TeamCity activity for a version without changing the configured release.</p></div>
            <input id="delivery-version" required value={releaseInput} onChange={(event) => setReleaseInput(event.target.value)} placeholder={integrations.currentRelease?.defaultValue || 'v11.8.5.0'} aria-describedby="delivery-version-help" />
            <button type="submit" disabled={integrationsLoading}>{integrationsLoading ? 'Checking…' : 'Check version'}</button>
            <button type="button" className="secondary" disabled={integrationsLoading || !integrations.currentRelease?.isOverride} onClick={() => void handleUseConfiguredRelease()}>Use configured</button>
            <small id="delivery-version-help">Configured in .env: <b>{integrations.currentRelease?.defaultValue || 'Not configured'}</b>{integrations.currentRelease?.isOverride ? ` · Viewing ${integrations.currentRelease.value}` : ' · Currently selected'}</small>
          </form>

          <section className="delivery-hosts">
            <div className="section-header compact"><div><h2>Runners &amp; agents</h2><p>Availability and active work for CI/CD hosts.</p></div></div>
            <div className="server-list">
              {deliveryServers.map((server) => {
                const isRefreshing = refreshingServers.includes(server.name)
                return <article className={`server-card ${server.status}`} key={server.name}>
                  <div className="server-main">
                    <span className={`server-status ${server.status}`} aria-label={server.status} />
                    <div><h3>{server.name}</h3><p>{server.ip} <span>·</span> {server.location}</p></div>
                    <span className="env-tag">{server.environment}</span>
                    <span className="server-state">{server.status === 'online' ? 'Online' : server.status === 'offline' ? 'Offline' : 'Unknown'}</span>
                    <button type="button" className="server-refresh-button" disabled={isRefreshing} onClick={() => void refreshServer(server.name)} title={`Refresh ${server.name}`}><span>↻</span>{isRefreshing ? 'Checking...' : 'Refresh'}</button>
                  </div>
                  {server.agentStatus ? <div className="agent-area">
                    <div className="agent-summary"><span>TeamCity agents</span><strong>{server.agentStatus.instances ? `${server.agentStatus.connectedInstances} / ${server.agentStatus.instances} connected` : 'Status unavailable'}</strong></div>
                    {server.agentStatus.runningBuilds.length ? server.agentStatus.runningBuilds.map((build) => build.webUrl
                      ? <a className="agent-build" href={build.webUrl} target="_blank" rel="noopener noreferrer" key={build.id}><span className="service-dot running" /><span><strong>Build {build.number || build.id}</strong><small>{build.buildTypeId}</small></span><time>running</time></a>
                      : <div className="agent-build" key={build.id}><span className="service-dot running" /><span><strong>Build {build.number || build.id}</strong><small>{build.buildTypeId}</small></span><time>running</time></div>) : <div className="agent-idle">{server.agentStatus.reason || 'No build currently running'}</div>}
                  </div> : <div className="delivery-host-note">GitLab runner host availability check</div>}
                </article>
              })}
              {!loading && !deliveryServers.length && <div className="loading-state">No delivery hosts are configured.</div>}
            </div>
          </section>

          <section className="integrations delivery-integrations">
            <div className="section-header compact"><div><h2>Build &amp; pipeline activity</h2><p>Activity for {integrations.currentRelease?.value || 'the configured release'}.</p></div>{integrations.currentRelease?.isOverride && <span className="check-only-badge">Custom version · confirmation required</span>}</div>
            <div className="integration-grid">
              <div className="integration-card">
                <div className="integration-heading"><span className="integration-logo gitlab">▰</span><div><h3>GitLab pipelines</h3><p>{integrations.gitlab?.ref || integrations.currentRelease?.value || 'Selected release pipeline'}</p></div><span className={`connection-dot ${integrations.gitlab?.status === 'unknown' ? 'disconnected' : ''}`} /></div>
                <div className="build-line"><span className={`build-badge ${integrations.gitlab?.status === 'running' ? 'running' : 'success'}`}>{integrations.gitlab?.status === 'running' ? '●' : integrations.gitlab?.status === 'unknown' ? '!' : '✓'}</span><div><strong>{integrations.gitlab?.id ? `Pipeline #${integrations.gitlab.id}` : integrations.gitlab?.reason || 'Loading pipeline...'}</strong><small>{integrations.gitlab?.status || 'checking'}</small></div><time>{integrations.gitlab?.status === 'running' ? 'running' : ''}</time></div>
                {integrations.gitlab?.status === 'running' && <div className="progress"><span /></div>}
              </div>
              <div id="teamcity-builds" className="integration-card" tabIndex={-1}>
                <div className="integration-heading"><span className="integration-logo teamcity">▰</span><div><h3>TeamCity builds</h3><p>{integrations.teamcity?.branch || 'Pending changes by release branch'}</p></div><span className={`connection-dot ${integrations.teamcity?.status === 'unknown' ? 'disconnected' : ''}`} /></div>
                <div className="teamcity-components">
                  {integrations.teamcity?.components?.length ? integrations.teamcity.components.map((component) => {
                    const actionKey = componentBuildActionKey(component.key, teamCityReleaseBranch)
                    const isPending = pendingActions.includes(actionKey)
                    const pendingCount = `${component.pendingChanges}${component.truncated ? '+' : ''}`
                    return <div className={`teamcity-component ${component.status}`} key={component.key}>
                      <div className="teamcity-component-main">
                        <span className={`build-badge ${component.status === 'queued' || component.status === 'running' ? 'running' : component.pendingChanges ? 'pending' : component.status === 'unknown' ? 'unknown' : 'success'}`}>{component.status === 'queued' || component.status === 'running' ? '●' : component.pendingChanges ? '↑' : component.status === 'unknown' ? '!' : '✓'}</span>
                        <div className="teamcity-component-copy">
                          {component.webUrl ? <a href={component.webUrl} target="_blank" rel="noopener noreferrer">{component.label}</a> : <strong>{component.label}</strong>}
                          <small>{component.reason || (component.activeBuild ? `Build ${component.activeBuild.number || component.activeBuild.id || ''} ${component.activeBuild.state || 'active'}` : component.pendingChanges ? `${pendingCount} pending ${component.pendingChanges === 1 ? 'change' : 'changes'}` : `No pending changes · ${component.checkedConfigurations} ${component.checkedConfigurations === 1 ? 'configuration' : 'configurations'} checked`)}</small>
                        </div>
                        {component.activeBuild?.webUrl && <a className="teamcity-active-link" href={component.activeBuild.webUrl} target="_blank" rel="noopener noreferrer">{component.activeBuild.state || 'active'}</a>}
                        {(component.canTrigger || isPending) && <button type="button" className="teamcity-trigger-button" disabled={isPending} onClick={() => void handleComponentBuild(component)}>{isPending ? 'Tracking...' : 'Trigger build'}</button>}
                      </div>
                      {component.pendingSources.length > 0 && <div className="teamcity-pending-sources">{component.pendingSources.map((source) => `${source.name} (${source.pendingChanges})`).join(' · ')}</div>}
                    </div>
                  }) : <div className="build-line"><span className="build-badge success">{integrations.teamcity?.status === 'unknown' ? '!' : '✓'}</span><div><strong>{integrations.teamcity?.reason || 'Loading build activity...'}</strong><small>{integrations.teamcity?.status || 'checking'}</small></div></div>}
                </div>
              </div>
            </div>
          </section>
          </>}

          {activeSection === 'servers' && <>
          <section className="page-heading">
            <div><p className="eyebrow">Daily test environment</p><h1>Test machines</h1><p className="subheading">Monitor daily-use machines, services, deployments, and storage.</p></div>
            <button type="button" className="refresh-button" disabled={loading} onClick={() => void refreshServers(true)} title={`Auto-refreshes every ${autoRefreshSeconds} seconds`}><span>↻</span> Refresh <small>{loading ? 'checking...' : lastRefresh}</small></button>
          </section>
          <div id="server-health" className="section-header">
            <div><h2>Test machine health</h2><p>Monitor availability, services, and deployed versions.</p></div>
          </div>

          <section className="server-list" aria-live="polite">
            {loading && !testMachines.length ? <div className="loading-state">Checking test machine health...</div> : visibleServers.map((server) => {
              const isRefreshing = refreshingServers.includes(server.name)
              return (
                <article className={`server-card ${server.status}`} key={server.name}>
                  <div className="server-main">
                    <span className={`server-status ${server.status}`} aria-label={server.status} />
                    <div><h3>{server.name}</h3><p>{server.ip} <span>·</span> {server.location}</p></div>
                    <span className="env-tag">{server.environment}</span>
                    <span className="server-state">{server.status === 'online' ? 'Online' : server.status === 'offline' ? 'Offline' : 'Unknown'}</span>
                    {server.group === 'Test machines' && <button type="button" className="server-refresh-button" disabled={isRefreshing} onClick={() => void refreshServer(server.name)} title={`Refresh ${server.name} machine and service status`} aria-label={`Refresh ${server.name} machine and service status`}><span>↻</span>{isRefreshing ? 'Checking...' : server.status === 'offline' ? 'Retry' : 'Refresh'}</button>}
                  </div>
                  {server.group === 'Test machines' && <section className="server-version-panel" aria-label={`${server.name} deployed version`}>
                    <div className="server-version-heading"><span>Deployed version</span><small>{deploymentTimeLabel(server.deployment?.finishedAt)}</small></div>
                    <div className="server-version-grid">
                      <div className="server-release-version"><small>Release</small><strong>{server.releaseVersion || 'Unavailable'}</strong></div>
                      {server.deployedBuilds ? Object.entries(server.deployedBuilds).map(([name, build]) => <div className="server-component-version" key={name}><small>{name}</small><strong>{build}</strong></div>) : <div className="server-component-version unavailable"><small>Component builds</small><strong>Unavailable</strong></div>}
                    </div>
                  </section>}
                  {server.services ? (
                    <div className="service-area">
                      {server.deployment && (() => {
                        const deploymentKey = `deploy:${server.name}`
                        const isDeploying = pendingActions.includes(deploymentKey)
                        return (
                          <div className={`deployment-readiness ${server.deployment.status}`}>
                            <div className="deployment-summary">
                              <div><span>TeamCity comparison{server.deployment.branch ? ` · ${server.deployment.branch}` : ''}</span><strong>{deploymentStatusLabel(server.deployment)}</strong></div>
                              {server.deployment.buildTypeUrl && <a href={server.deployment.buildTypeUrl} target="_blank" rel="noopener noreferrer">Pipeline ↗</a>}
                            </div>
                            <div className="build-comparison-list">
                              {server.deployment.comparisons.map((comparison) => (
                                <div className={`build-comparison ${comparison.status}`} key={comparison.name}>
                                  <span>{comparison.name}</span>
                                  <span><b>{comparison.deployed || '—'}</b><i>→</i>{comparison.webUrl && comparison.available ? <a href={comparison.webUrl} target="_blank" rel="noopener noreferrer">{comparison.available}</a> : <b>{comparison.available || '—'}</b>}</span>
                                  <em>{comparison.status === 'available' ? 'Update' : comparison.status === 'current' ? 'Current' : 'Unknown'}</em>
                                </div>
                              ))}
                            </div>
                            {server.deployment.status === 'available' && (
                              <div className="deployment-action">
                                <small>{server.deployment.changedComponents.join(', ')} {server.deployment.changedComponents.length === 1 ? 'has' : 'have'} a newer successful build{server.deployment.branch ? ` on ${server.deployment.branch}` : ''}.</small>
                              </div>
                            )}
                            {server.deployment.status === 'unknown' && <div className="deployment-unknown">{server.deployment.reason || 'The installed or TeamCity build numbers could not be read.'}</div>}
                            {(server.deployment.canSchedule || server.deployment.canDeploy) && <DeploymentControls serverName={server.name} canDeploy={server.deployment.canDeploy} deploying={isDeploying} onDeploy={() => void handleDeployment(server)} onComplete={refreshServer} builds={integrations.teamcity?.builds} />}
                          </div>
                        )
                      })()}
                      <div className="disk-space">
                        <div className="disk-heading"><span>Disk space</span><small>{server.diskSpace?.status === 'available' ? `${server.diskSpace.volumes.length} fixed ${server.diskSpace.volumes.length === 1 ? 'volume' : 'volumes'}` : 'Unavailable'}</small></div>
                        {server.diskSpace?.volumes.length ? server.diskSpace.volumes.map((volume) => {
                          const usedPercent = Math.max(0, Math.min(100, 100 - volume.freePercent))
                          return (
                            <div className="disk-row" key={volume.name}>
                              <span className="disk-name">{volume.name}</span>
                              <div className="disk-meter" role="meter" aria-label={`${server.name} ${volume.name} disk used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPercent}><span className={volume.status} style={{ width: `${usedPercent}%` }} /></div>
                              <span className={`disk-free ${volume.status}`}>{formatDiskSize(volume.freeBytes)} free <small>({volume.freePercent}%)</small></span>
                              <span className="disk-total">of {formatDiskSize(volume.totalBytes)}</span>
                            </div>
                          )
                        }) : <div className="disk-unavailable">Disk capacity was not reported by the status job.</div>}
                      </div>
                      <div className="services">
                        <div className="service-row iis-control">
                          <span className="service-dot unknown" aria-hidden="true" />
                          <span className="service-name">IIS web server</span>
                          <span className="service-status unknown">web control</span>
                          <button type="button" className="service-action-button restart" disabled={server.status !== 'online' || pendingActions.includes(`${server.name}:IIS`)} onClick={() => void handleServiceAction(server.name, 'IIS', 'restart')} title={server.status === 'online' ? 'Restart IIS' : 'Unavailable while the machine is offline'}>{pendingActions.includes(`${server.name}:IIS`) ? 'Restarting...' : 'Restart IIS'}</button>
                        </div>
                        {server.services.map((service) => {
                        const action: ServiceAction | null = service.status === 'running' ? 'stop' : service.status === 'stopped' ? 'start' : null
                        const actionKey = `${server.name}:${service.name}`
                        const isPending = pendingActions.includes(actionKey)
                        return (
                          <div className="service-row" key={service.name}>
                            <span className={`service-dot ${service.status}`} aria-hidden="true" />
                            <span className="service-name">{service.name}</span>
                            <span className={`service-status ${service.status}`}>{service.status}</span>
                            {action && <button type="button" className={`service-action-button ${action}`} disabled={server.status !== 'online' || isPending} onClick={() => void handleServiceAction(server.name, service.name, action)}>{isPending ? `${action === 'start' ? 'Starting' : 'Stopping'}...` : `${action === 'start' ? 'Start' : 'Stop'} service`}</button>}
                          </div>
                        )
                      })}</div>
                      {server.recentDatabaseError && <div className={`database-error ${server.recentDatabaseError.status}`}>
                        <div className="database-error-heading"><span>Recent PCD database errors</span><time>Checked {new Date(server.recentDatabaseError.checkedAt).toLocaleString()}</time></div>
                        {server.recentDatabaseError.status === 'available' && server.recentDatabaseError.errors?.length ? <div className="database-error-list">
                          {server.recentDatabaseError.aiSummary && <section className={`database-ai-summary ${server.recentDatabaseError.aiSummary.status}`} aria-label="AI summary of newest PCD error">
                            <div className="database-ai-summary-heading"><strong>AI summary of newest error</strong>{server.recentDatabaseError.aiSummary.status === 'available' && <span>{server.recentDatabaseError.aiSummary.confidence} confidence</span>}</div>
                            {server.recentDatabaseError.aiSummary.status === 'available' ? <>
                              <p>{server.recentDatabaseError.aiSummary.summary}</p>
                              <dl><div><dt>Likely cause</dt><dd>{server.recentDatabaseError.aiSummary.likelyCause}</dd></div><div><dt>Suggested action</dt><dd>{server.recentDatabaseError.aiSummary.suggestedAction}</dd></div></dl>
                              <small>{server.recentDatabaseError.aiSummary.providerName} · {server.recentDatabaseError.aiSummary.model}{server.recentDatabaseError.aiSummary.incomplete ? ' · Source fields were truncated' : ''} · Verify before acting</small>
                            </> : <p>{server.recentDatabaseError.aiSummary.reason}</p>}
                          </section>}
                          {server.recentDatabaseError.errors.map((error, index) => <details key={`${error.occurredAt || 'unknown'}-${index}`}>
                            <summary>Exception {index + 1}{error.occurredAt ? ` · ${new Date(error.occurredAt).toLocaleString()}` : ''}</summary>
                            {error.fields && <dl>{Object.entries(error.fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? 'NULL'}</dd></div>)}</dl>}
                            {error.reason && <p>{error.reason}</p>}
                            {error.truncated && <p>Only the first 30 columns are displayed.</p>}
                          </details>)}
                        </div> : <p>{server.recentDatabaseError.reason}</p>}
                      </div>}
                    </div>
                  ) : <div className="no-app"><span>⊘</span> No application deployed <small>Availability check only</small></div>}
                </article>
              )
            })}
            {!loading && visibleServers.length === 0 && <div className="loading-state">No test machines are configured.</div>}
          </section>
          </>}
        </div>
      </main>

      {notice && <div className={`toast ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}><span>{notice.tone === 'error' ? '!' : '✓'}</span>{notice.message}</div>}
    </div>
  )
}

export default App
