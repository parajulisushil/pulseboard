import assert from 'node:assert/strict'
import test from 'node:test'
import { groupInfrastructureStatuses, pingArguments, validateInfrastructureInventory } from './infrastructure-status.mjs'

const inventory = [
  { name: 'Dev-QC01', ip: '172.31.38.222', panel: 'Dev Servers' },
  { name: 'Compatibility 2', ip: '172.31.42.230', panel: 'Compatibility' },
  { name: 'FS02', ip: '172.31.43.227', panel: 'Other Servers' },
]

test('validates and explicitly groups the infrastructure inventory', () => {
  assert.equal(validateInfrastructureInventory(inventory), inventory)
  assert.throws(() => validateInfrastructureInventory([
    ...inventory,
    { name: 'fs02', ip: '127.0.0.1', panel: 'Duplicate' },
  ]), /Duplicate infrastructure server name/)

  const result = groupInfrastructureStatuses(inventory, new Map([
    ['Dev-QC01', { name: 'Dev-QC01', ip: '172.31.38.222', online: true, latencyMs: 12.4, lastChecked: '2026-09-17T00:00:00.000Z' }],
  ]), '2026-09-17T00:00:01.000Z')
  assert.deepEqual(result.panels.map((panel) => panel.title), ['Dev Servers', 'Compatibility', 'Other Servers'])
  assert.equal(result.onlineCount, 1)
  assert.equal(result.totalCount, 3)
  assert.equal(result.panels[1].servers[0].online, false)
})

test('uses platform-specific one-packet ping arguments', () => {
  assert.deepEqual(pingArguments('win32'), ['-n', '1', '-w', '1000'])
  assert.deepEqual(pingArguments('linux'), ['-c', '1', '-W', '1'])
})
