# Stop the local service started by launch.ps1 / run.cmd.
# Finds the instance via the state file and by probing the launcher port
# window, verifies the PID still belongs to server.mjs, then kills the
# process tree (server + any running job pipeline).
#
# -Quiet is for testing / scripting; -StateDir isolates state+logs.

[CmdletBinding()]
param(
  [string]$StateDir = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

$stateDirPath = Resolve-StateDir $StateDir
$stateFile = Join-Path $stateDirPath 'state.json'
$minPort = 43180
$maxPort = 43200

try {
  $state = Read-AppState $stateFile
  $statePort = 0
  if ($state -and [int]$state.port -gt 0) { $statePort = [int]$state.port }

  # Collect health objects keyed by port (state first, then a port sweep).
  $healthByPort = @{}
  if ($statePort -gt 0) {
    $h = Get-AppHealth $statePort 1
    if ($h) { $healthByPort[[string]$statePort] = $h }
  }
  foreach ($p in @(Get-ListeningPorts $minPort $maxPort)) {
    $key = [string][int]$p
    if ($healthByPort.ContainsKey($key)) { continue }
    $h = Get-AppHealth ([int]$p) 1
    if ($h) { $healthByPort[$key] = $h }
  }

  # Do not silently kill a running generation job.
  $busy = @($healthByPort.Values | Where-Object { $_.busy -eq $true })
  if ($busy.Count -gt 0 -and -not $Quiet) {
    $ok = Show-AppConfirm ("服务正在执行生成任务，停止会中断任务并结束 Altium 管线。`n`n确定要停止吗？")
    if (-not $ok) { exit 3 }
  }

  $stopped = @()
  foreach ($key in @($healthByPort.Keys)) {
    $h = $healthByPort[$key]
    if (Stop-OurServer ([int]$h.pid)) {
      $stopped += [int]$key
      continue
    }
    # Unknown/legacy pid: fall back to whoever owns the listening port.
    $conn = Get-NetTCPConnection -LocalPort ([int]$key) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and (Stop-OurServer ([int]$conn.OwningProcess))) { $stopped += [int]$key }
  }

  # Server alive but not answering HTTP (hung / still starting).
  if ($stopped.Count -eq 0 -and $state -and [int]$state.pid -gt 0) {
    if (Stop-OurServer ([int]$state.pid)) { $stopped += [int]$state.port }
  }
  if ($stopped.Count -eq 0 -and $statePort -gt 0) {
    $conn = Get-NetTCPConnection -LocalPort $statePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and (Stop-OurServer ([int]$conn.OwningProcess))) { $stopped += $statePort }
  }

  # Race guard: the user may have double-clicked 启动.vbs just before stop.
  # Wait for any in-flight launch.ps1 to settle, then sweep the port window
  # once more so stop cannot "miss" a server that is still starting.
  $launcherDeadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $launcherDeadline) {
    $launchers = @()
    try {
      $launchers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'launch\.ps1' })
    } catch { }
    if ($launchers.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  foreach ($p in @(Get-ListeningPorts $minPort $maxPort)) {
    $h = Get-AppHealth ([int]$p) 1
    if ($h -and (Stop-OurServer ([int]$h.pid))) {
      if ($stopped -notcontains [int]$p) { $stopped += [int]$p }
    }
  }

  Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

  if ($stopped.Count -gt 0) {
    # Give Windows a moment to release the listening sockets.
    $deadline = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $deadline) {
      $stillListening = $false
      foreach ($p in $stopped) {
        if (@(Get-ListeningPorts ([int]$p) ([int]$p)).Count -gt 0) { $stillListening = $true; break }
      }
      if (-not $stillListening) { break }
      Start-Sleep -Milliseconds 200
    }
    exit 0
  }

  if (-not $Quiet) {
    Show-AppError ("没有检测到本工程正在运行的服务（可能已经停止）。`n`n如果还有 run.cmd 控制台窗口开着，服务已退出，直接关闭该窗口即可。")
  }
  exit 2
} catch {
  if (-not $Quiet) { Show-AppError ("停止服务时出错：`n" + $_.Exception.Message) }
  exit 1
}
