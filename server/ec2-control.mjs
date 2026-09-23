import { createHmac } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 15000

function configuredValue(name, environment = process.env) {
  const value = environment[name]
  return value && value.trim() ? value.trim() : undefined
}

export function ec2ControlEnabled(environment = process.env) {
  return configuredValue('EC2_CONTROL_ENABLED', environment)?.toLowerCase() === 'true'
}

export function validateEc2ControlConfig(environment = process.env) {
  if (!ec2ControlEnabled(environment)) return
  const endpoint = configuredValue('EC2_CONTROL_URL', environment)
  const signingSecret = configuredValue('EC2_CONTROL_SIGNING_SECRET', environment)
  const userId = configuredValue('EC2_CONTROL_USER_ID', environment)
  if (!endpoint || !signingSecret || !userId) {
    throw new Error('EC2_CONTROL_URL, EC2_CONTROL_SIGNING_SECRET, and EC2_CONTROL_USER_ID are required when EC2_CONTROL_ENABLED=true')
  }
  let parsed
  try { parsed = new URL(endpoint) } catch { throw new Error('EC2_CONTROL_URL must be a valid URL') }
  if (parsed.protocol !== 'https:' && environment.NODE_ENV === 'production') {
    throw new Error('EC2_CONTROL_URL must use HTTPS in production')
  }
  const timeoutMs = Number.parseInt(environment.EC2_CONTROL_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('EC2_CONTROL_TIMEOUT_MS must be an integer between 1000 and 60000')
  }
}

function responseMessage(text) {
  const trimmed = text.trim()
  if (!trimmed) return 'The EC2 control function returned an empty response'
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'string') return parsed
    if (typeof parsed?.body === 'string') return parsed.body
    if (typeof parsed?.message === 'string') return parsed.message
  } catch { /* API Gateway normally returns the Lambda body as plain text. */ }
  return trimmed
}

export async function controlEc2Instance(instanceId, action, {
  environment = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  validateEc2ControlConfig(environment)
  if (!ec2ControlEnabled(environment)) throw new Error('EC2 instance control is disabled')
  if (!/^i-[0-9a-f]{8,17}$/i.test(instanceId)) throw new Error('Invalid EC2 instance ID')
  if (!['start', 'stop'].includes(action)) throw new Error('Unsupported EC2 action')

  const body = new URLSearchParams({
    user_id: configuredValue('EC2_CONTROL_USER_ID', environment),
    text: `${action} ${instanceId}`,
  }).toString()
  const timestamp = String(Math.floor(now() / 1000))
  const signature = `v0=${createHmac('sha256', configuredValue('EC2_CONTROL_SIGNING_SECRET', environment))
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`
  const timeoutMs = Number.parseInt(environment.EC2_CONTROL_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10)
  let response
  try {
    response = await fetchImpl(configuredValue('EC2_CONTROL_URL', environment), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Application-Request-Timestamp': timestamp,
        'X-Application-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('EC2 control request timed out')
    throw new Error('Unable to reach the EC2 control function')
  }
  const message = responseMessage(await response.text())
  if (!response.ok) throw new Error(message)
  if (/^(?:Error|Bad Request|Unauthorized|Usage|Invalid)\b/i.test(message)
    || /has stop protection enabled/i.test(message)
    || /but the attribute did not change/i.test(message)) throw new Error(message)
  return { status: 'accepted', action, instanceId, message }
}
