import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { controlEc2Instance, ec2ControlEnabled, validateEc2ControlConfig } from './ec2-control.mjs'

const environment = {
  EC2_CONTROL_ENABLED: 'true',
  EC2_CONTROL_URL: 'https://example.test/ec2-control',
  EC2_CONTROL_SIGNING_SECRET: 'test-signing-secret',
  EC2_CONTROL_USER_ID: 'U0123456789',
  EC2_CONTROL_TIMEOUT_MS: '5000',
}

test('validates optional EC2 control configuration', () => {
  assert.equal(ec2ControlEnabled({ EC2_CONTROL_ENABLED: 'TRUE' }), true)
  assert.doesNotThrow(() => validateEc2ControlConfig({ EC2_CONTROL_ENABLED: 'false' }))
  assert.throws(() => validateEc2ControlConfig({ EC2_CONTROL_ENABLED: 'true' }), /are required/)
  assert.throws(() => validateEc2ControlConfig({ ...environment, EC2_CONTROL_TIMEOUT_MS: '0' }), /between 1000 and 60000/)
})

test('calls the existing Lambda contract with a timestamped signature', async () => {
  let request
  const now = 1_800_000_000_000
  const result = await controlEc2Instance('i-024be3ccef4134447', 'start', {
    environment,
    now: () => now,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return new Response('Processing your request to start the EC2 instance: Dev-QC01', { status: 200 })
    },
  })
  const expectedBody = 'user_id=U0123456789&text=start+i-024be3ccef4134447'
  const expectedTimestamp = String(now / 1000)
  const expectedSignature = `v0=${createHmac('sha256', environment.EC2_CONTROL_SIGNING_SECRET)
    .update(`v0:${expectedTimestamp}:${expectedBody}`)
    .digest('hex')}`
  assert.equal(request.url, environment.EC2_CONTROL_URL)
  assert.equal(request.options.body, expectedBody)
  assert.equal(request.options.headers['X-Application-Request-Timestamp'], expectedTimestamp)
  assert.equal(request.options.headers['X-Application-Signature'], expectedSignature)
  assert.equal(result.status, 'accepted')
})

test('surfaces errors returned with the Lambda Slack-compatible 200 response', async () => {
  await assert.rejects(
    controlEc2Instance('i-024be3ccef4134447', 'stop', {
      environment,
      fetchImpl: async () => new Response('Unauthorized: user is not on the allowlist', { status: 200 }),
    }),
    /not on the allowlist/,
  )
  await assert.rejects(
    controlEc2Instance('i-024be3ccef4134447', 'stop', {
      environment,
      fetchImpl: async () => new Response('Dev-QC01 has stop protection enabled. Run unprotect first.', { status: 200 }),
    }),
    /stop protection enabled/,
  )
})

test('rejects unsupported actions and invalid instance IDs without a request', async () => {
  await assert.rejects(controlEc2Instance('invalid', 'start', { environment }), /Invalid EC2 instance ID/)
  await assert.rejects(controlEc2Instance('i-024be3ccef4134447', 'restart', { environment }), /Unsupported EC2 action/)
})
