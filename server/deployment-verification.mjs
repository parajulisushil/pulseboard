export function deploymentLoginUrl(server) {
  const host = server.name.trim().replace(/\s+/g, '-').toLowerCase()
  return server.loginUrl || `https://${host}.veniosystems.com/VenioWeb/OnDemand/AppPlus/#/login`
}

async function launchBrowser() {
  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true, timeout: 15000 })
}

export async function checkLoginPage(server, { launch = launchBrowser } = {}) {
  const url = deploymentLoginUrl(server)
  let browser
  try {
    browser = await launch()
  } catch {
    return { status: 'unknown', url, reason: 'Login browser could not start. Install Chromium on the API host with npm run setup:browser and check its runtime dependencies.' }
  }
  try {
    // A fresh context has no saved login; only check the form, without submitting credentials.
    const page = await browser.newPage({ ignoreHTTPSErrors: false })
    page.setDefaultTimeout(20000)
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    if (!response?.ok()) return { status: 'failed', url, reason: `Login page returned ${response ? `HTTP ${response.status()}` : 'no HTTP response'}.` }
    await page.locator('input[type="password"]:visible').first().waitFor({ state: 'visible', timeout: 20000 })
    return { status: 'passed', url, reason: 'Login page loaded and its password field is visible.' }
  } catch {
    return { status: 'failed', url, reason: 'Login page could not load or show its password field within the timeout. Check the application, network, and HTTPS certificate.' }
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function verifyDeployment(server, { readServices, launch, now = () => new Date() }) {
  const [loginResult, serviceResult] = await Promise.allSettled([
    checkLoginPage(server, { launch }), readServices(server),
  ])
  const login = loginResult.status === 'fulfilled' ? loginResult.value : { status: 'unknown', reason: 'Login page check could not be completed.' }
  const readings = serviceResult.status === 'fulfilled' ? serviceResult.value : []
  const services = (server.services || []).map((service) => {
    const reading = readings?.find((item) => item.name === service.name)
    return { name: service.name, status: ['running', 'stopped'].includes(reading?.status) ? reading.status : 'unknown' }
  })
  const allServicesRunning = services.length > 0 && services.every((service) => service.status === 'running')
  return {
    status: login.status === 'passed' && allServicesRunning ? 'passed' : 'needs_attention',
    checkedAt: now().toISOString(), login, services, allServicesRunning,
    servicesReason: !services.length ? 'No application services are configured for this server.'
      : allServicesRunning ? 'All configured application services are running.'
      : services.some((service) => service.status === 'stopped') ? 'One or more application services are stopped.'
      : 'One or more application service statuses could not be confirmed.',
  }
}
