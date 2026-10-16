import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
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

test('Windows storage probe reads SMB capacity, cleans up its mapping, and never attempts WinRM', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulseboard-smb-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const harness = path.join(directory, 'probe.ps1')
  await writeFile(harness, String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
public static class PulseboardShareCapacity {
  public static bool GetDiskFreeSpaceEx(string directory, out ulong available, out ulong total, out ulong free) {
    if (directory != @"\\fs02\teamcity\") throw new Exception("Wrong share path");
    available = 150; total = 1000; free = 250;
    return Environment.GetEnvironmentVariable("PULSEBOARD_TEST_MODE") != "api-failure";
  }
}
'@
function New-PSDrive {
  param($Name, $PSProvider, $Root, $Credential, $ErrorAction)
  if ($Credential.UserName -ne 'test-monitor') { throw 'Wrong monitoring account' }
  if ($env:PULSEBOARD_TEST_MODE -eq 'mapping-failure') { throw 'Access denied' }
  Write-Host "MAPPED:$Name"
}
function Remove-PSDrive {
  param($Name, [switch]$Force, $ErrorAction)
  Write-Host "REMOVED:$Name"
}
function Invoke-Command { throw 'WINRM_ATTEMPTED' }
& $env:PULSEBOARD_TEST_SCRIPT
`)
  for (const mode of ['success', 'api-failure', 'mapping-failure']) {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: {
        ...process.env, PULSEBOARD_TEST_MODE: mode,
        PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        PULSEBOARD_TEST_SCRIPT: fileURLToPath(new URL('./teamcity-service-control.ps1', import.meta.url)),
        SERVICE_USERNAME: 'test-monitor', SERVICE_PASSWORD: 'fixture-password', PULSEBOARD_SERVICE_ACTION: 'status',
        PULSEBOARD_SERVICE_INVENTORY: JSON.stringify([{ serverName: 'FS02', target: 'fs02.ad.veniosystems.com', storageOnly: true, storageShare: '\\\\fs02\\teamcity', storageDrive: 'G:' }]),
      },
    })
    assert.doesNotMatch(output, /WINRM_ATTEMPTED|fixture-password/)
    if (mode === 'success') assert.match(output, /PULSEBOARD_DISK_STATUS\|FS02\|G:\|1000\|150/)
    else {
      assert.doesNotMatch(output, /PULSEBOARD_DISK_STATUS/)
      assert.match(output, /Unable to query SMB storage/)
    }
    if (mode !== 'mapping-failure') {
      const name = output.match(/MAPPED:(Pulseboard[0-9a-f]+)/)?.[1]
      assert.ok(name)
      assert.ok(output.includes(`REMOVED:${name}`))
    } else assert.doesNotMatch(output, /REMOVED:/)
  }
})
