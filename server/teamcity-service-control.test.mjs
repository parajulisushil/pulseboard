import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('TeamCity service control preserves service arrays across remoting', async () => {
  const script = await readFile(new URL('./teamcity-service-control.ps1', import.meta.url), 'utf8')

  assert.match(script, /\$remoteItemsJson = \$items \| ConvertTo-Json -Compress -Depth 5/)
  assert.match(script, /foreach \(\$remoteItem in \(\$remoteItemsJson \| ConvertFrom-Json\)\)/)
  assert.match(script, /\$remoteItems \+= \$remoteItem/)
  assert.match(script, /-ArgumentList \$remoteItemsJson, \$action/)
  assert.doesNotMatch(script, /-ArgumentList \(,\$items\), \$action/)
  assert.match(script, /Get-CimInstance -ClassName Win32_LogicalDisk/)
  assert.match(script, /PULSEBOARD_DISK_STATUS/)
  assert.match(script, /'restart_iis'/)
  assert.match(script, /iisreset\.exe.*\/restart.*\/timeout:60/)
  assert.match(script, /IIS restart failed with exit code/)
})
