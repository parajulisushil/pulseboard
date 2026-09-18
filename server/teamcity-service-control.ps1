$ErrorActionPreference = 'Stop'
$target = $env:PULSEBOARD_TARGET_SERVER
$serviceName = $env:PULSEBOARD_SERVICE_NAME
$action = $env:PULSEBOARD_SERVICE_ACTION
$inventory = $env:PULSEBOARD_SERVICE_INVENTORY

if ($action -notin @('status', 'start', 'stop', 'restart_iis')) { throw "Unsupported action: $action" }

$securePassword = ConvertTo-SecureString $env:SERVICE_PASSWORD -AsPlainText -Force
$credential = [PSCredential]::new($env:SERVICE_USERNAME, $securePassword)
$targets = if ($action -eq 'status' -and $inventory) {
  @($inventory | ConvertFrom-Json)
} else {
  @([PSCustomObject]@{ serverName = $env:PULSEBOARD_SERVER_NAME; target = $target; serviceName = $serviceName; serviceKey = $serviceName })
}

# Open one remoting session per machine. If the machine cannot be reached,
# emit Unknown for all of its services without waiting on another session for
# each service.
foreach ($serverGroup in ($targets | Group-Object -Property serverName)) {
  $items = @($serverGroup.Group)
  $serverName = [string]$items[0].serverName
  $target = [string]$items[0].target
  # Passing an object array directly through -ArgumentList can add a nested
  # array layer during remoting. Serialize it so every service remains a
  # distinct object on the remote machine.
  $remoteItemsJson = $items | ConvertTo-Json -Compress -Depth 5
  try {
    $results = @(Invoke-Command -ComputerName $target -Credential $credential -ErrorAction Stop -ScriptBlock {
      param($remoteItemsJson, $requestedAction)
      # Windows PowerShell 5.1 returns a top-level JSON array as one nested
      # Object[]; PowerShell 7 enumerates it. Flatten explicitly so this build
      # behaves the same with either TeamCity runner executable.
      $remoteItems = @()
      foreach ($remoteItem in ($remoteItemsJson | ConvertFrom-Json)) {
        $remoteItems += $remoteItem
      }
      if ($remoteItems.Count -eq 0) { throw 'No service targets were provided' }
      if ($requestedAction -eq 'restart_iis') {
        Write-Host 'Restarting IIS...'
        & "$env:SystemRoot\System32\iisreset.exe" /restart /timeout:60 | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -ne 0) { throw "IIS restart failed with exit code $LASTEXITCODE" }
        [PSCustomObject]@{ Kind = 'Iis'; ServerName = $remoteItems[0].serverName; ServiceName = 'IIS'; Status = 'Restarted' }
        return
      }
      foreach ($item in $remoteItems) {
        $name = [string]$item.serviceKey
        try {
          $service = Get-Service -Name $name -ErrorAction Stop
          Write-Host "Before: $name is $($service.Status)"

          if ($requestedAction -eq 'start' -and $service.Status -ne 'Running') {
            Start-Service -Name $name -ErrorAction Stop
          } elseif ($requestedAction -eq 'stop' -and $service.Status -ne 'Stopped') {
            Stop-Service -Name $name -ErrorAction Stop
          }

          $service = Get-Service -Name $name -ErrorAction Stop
          Write-Host "After: $name is $($service.Status)"
          if ($requestedAction -eq 'start' -and $service.Status -ne 'Running') { throw "$name did not start" }
          if ($requestedAction -eq 'stop' -and $service.Status -ne 'Stopped') { throw "$name did not stop" }
          [PSCustomObject]@{ Kind = 'Service'; ServerName = $item.serverName; ServiceName = $item.serviceName; Status = $service.Status.ToString() }
        } catch {
          if ($requestedAction -ne 'status') { throw }
          Write-Warning "Unable to query $($item.serviceName): $($_.Exception.Message)"
          [PSCustomObject]@{ Kind = 'Service'; ServerName = $item.serverName; ServiceName = $item.serviceName; Status = 'Unknown' }
        }
      }

      if ($requestedAction -eq 'status') {
        try {
          foreach ($disk in @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' -ErrorAction Stop)) {
            if ($disk.Size -gt 0) {
              [PSCustomObject]@{
                Kind = 'Disk'
                ServerName = $remoteItems[0].serverName
                VolumeName = [string]$disk.DeviceID
                TotalBytes = [uint64]$disk.Size
                FreeBytes = [uint64]$disk.FreeSpace
              }
            }
          }
        } catch {
          Write-Warning "Unable to query disk space: $($_.Exception.Message)"
        }
      }
    } -ArgumentList $remoteItemsJson, $action)

    foreach ($result in $results) {
      if ($result.Kind -eq 'Disk') {
        Write-Host "PULSEBOARD_DISK_STATUS|$($result.ServerName)|$($result.VolumeName)|$($result.TotalBytes)|$($result.FreeBytes)"
      } else {
        Write-Host "PULSEBOARD_SERVICE_STATUS|$($result.ServerName)|$($result.ServiceName)|$($result.Status)"
      }
    }
  } catch {
    if ($action -ne 'status') { throw }
    Write-Warning "Unable to query ${serverName}: $($_.Exception.Message)"
    foreach ($item in $items) {
      Write-Host "PULSEBOARD_SERVICE_STATUS|$($item.serverName)|$($item.serviceName)|Unknown"
    }
  }
}
