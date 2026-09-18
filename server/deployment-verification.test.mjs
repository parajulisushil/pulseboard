import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLoginPage, deploymentLoginUrl, verifyDeployment } from './deployment-verification.mjs'

const server = { name: 'Dev-QC03', services: [{ name: 'Search' }, { name: 'Export' }, { name: 'Distributed' }] }
function browserFixture({ httpStatus = 200, missingForm = false, navigationFails = false } = {}) {
  const calls = { closed: 0, visited: [] }
  return {
    calls,
    launch: async () => ({
      newPage: async (options) => {
        assert.equal(options.ignoreHTTPSErrors, false)
        return {
          setDefaultTimeout: () => {},
          goto: async (url, options) => {
            calls.visited.push(url)
            assert.equal(options.waitUntil, 'domcontentloaded')
            assert.equal(options.timeout, 20000)
            if (navigationFails) throw new Error('private network details')
            return { ok: () => httpStatus === 200, status: () => httpStatus }
          },
          locator: (selector) => {
            assert.equal(selector, 'input[type="password"]:visible')
            return { first: () => ({ waitFor: async (options) => {
              assert.equal(options.state, 'visible')
              assert.equal(options.timeout, 20000)
              if (missingForm) throw new Error('Timeout: password field not visible')
            } }) }
          },
        }
      },
      close: async () => { calls.closed++ },
    }),
  }
}

test('checks the supplied SPA login route and waits for its visible form', async () => {
  const f = browserFixture()
  const result = await checkLoginPage(server, f)
  assert.equal(result.status, 'passed')
  assert.deepEqual(f.calls.visited, ['https://dev-qc03.veniosystems.com/VenioWeb/OnDemand/AppPlus/#/login'])
  assert.equal(f.calls.closed, 1)
  assert.equal(deploymentLoginUrl({ ...server, loginUrl: 'https://custom.test/#/login' }), 'https://custom.test/#/login')
})

test('HTTP errors, missing login form, and navigation failures never pass and always close the browser', async () => {
  for (const options of [{ httpStatus: 503 }, { missingForm: true }, { navigationFails: true }]) {
    const f = browserFixture(options)
    const result = await checkLoginPage(server, f)
    assert.equal(result.status, 'failed')
    assert(!result.reason.includes('private network details'))
    assert.equal(f.calls.closed, 1)
  }
  const result = await checkLoginPage(server, { launch: async () => { throw new Error('private path') } })
  assert.equal(result.status, 'unknown')
  assert.match(result.reason, /setup:browser/)
})

test('verification requires the login page and every configured service to pass', async () => {
  const healthy = server.services.map(({ name }) => ({ name, status: 'running' }))
  for (const [readings, passed] of [
    [healthy, true], [healthy.slice(1), false], [[], false],
    [healthy.map((item, index) => index ? item : { ...item, status: 'stopped' }), false],
    [healthy.map((item, index) => index ? item : { ...item, status: 'paused' }), false],
  ]) {
    const result = await verifyDeployment(server, { ...browserFixture(), readServices: async () => readings })
    assert.equal(result.status, passed ? 'passed' : 'needs_attention')
    assert.equal(result.services.length, 3)
    assert.equal(result.allServicesRunning, passed)
  }
  const unavailable = await verifyDeployment(server, { ...browserFixture(), readServices: async () => { throw new Error('private credentials') } })
  assert.equal(unavailable.status, 'needs_attention')
  assert(unavailable.services.every((service) => service.status === 'unknown'))
  const noServices = await verifyDeployment({ ...server, services: [] }, { ...browserFixture(), readServices: async () => [] })
  assert.equal(noServices.allServicesRunning, false)
  const noLogin = await verifyDeployment(server, { ...browserFixture({ missingForm: true }), readServices: async () => healthy })
  assert.equal(noLogin.status, 'needs_attention')
})
