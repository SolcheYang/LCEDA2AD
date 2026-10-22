# One-click launcher (called by 启动.vbs, or by run.cmd indirectly).
# - reuses an already running instance of THIS project
# - otherwise starts the server hidden on the first free port in 43180..43200
# - opens the UI in an Edge/Chrome app window when available
# - shows a message box with the log tail if startup fails
#
# Testing switches: -Port, -NoBrowser, -Fresh (ignore running instances),
# -StateDir (isolated state/log directory).

[CmdletBinding()]
param(
  [int]$Port = 43180,
  [switch]$NoBrowser,
  [switch]$Fresh,
  [string]$StateDir = ''
)

$ErrorActionPreference = 'Stop'
# Headless/testing hook: the .vbs entry point cannot pass switches.
if ($env:LCEDA2ALTIUM_NO_BROWSER -eq '1') { $NoBrowser = $true }
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

$stateDirPath = Resolve-StateDir $StateDir
$stateFile = Join-Path $stateDirPath 'state.json'
$outLog = Join-Path $stateDirPath 'server.log'
$errLog = Join-Path $stateDirPath 'server.err.log'
New-Item -ItemType Directory -Force -Path $stateDirPath | Out-Null

$minPort = [Math]::Max(1024, $Port)
$maxPort = $minPort + 20

try {
  if (-not $Fresh) {
    $existing = Get-RunningInstance -StateFile $stateFile -MinPort $minPort -MaxPort $maxPort
    if ($existing) {
      Save-AppState -StateFile $stateFile -Port ([int]$existing.port) -ProcessId ([int]$existing.pid)
      if (-not $NoBrowser) { Open-AppUi ([int]$existing.port) }
      exit 0
    }
  }

  $node = Find-Node
  if (-not $node) {
    Show-AppError ("未找到 Node.js。`n`n请安装 Node.js 18 或更新版本（https://nodejs.org/），然后重试。`n`n也可以双击 run.cmd 查看具体错误。")
    exit 1
  }

  $chosen = 0
  for ($p = $minPort; $p -le $maxPort; $p++) {
    if (Test-PortFree $p) { $chosen = $p; break }
  }
  if ($chosen -eq 0) {
    Show-AppError ("端口 {0}-{1} 都被占用，无法启动服务。`n`n请关闭占用这些端口的程序后重试。" -f $minPort, $maxPort)
    exit 1
  }

  # Truncate old logs without writing a BOM into them.
  try {
    [IO.File]::WriteAllText($outLog, '')
    [IO.File]::WriteAllText($errLog, '')
  } catch { }

  # Reserve the port in the state file before spawning, so a second
  # double-click during startup waits for this instance instead of racing it.
  Save-AppState -StateFile $stateFile -Port $chosen -ProcessId 0

  $serverPath = Join-Path $script:AppRoot 'app\server.mjs'
  $env:PORT = [string]$chosen
  $proc = Start-Process -FilePath $node `
    -ArgumentList ('"' + $serverPath + '"') `
    -WorkingDirectory $script:AppRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

  if (-not $proc) { throw 'Start-Process 未返回进程对象。' }
  Save-AppState -StateFile $stateFile -Port $chosen -ProcessId $proc.Id

  $health = $null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    $health = Get-AppHealth $chosen 1
    if ($health) { break }
    Start-Sleep -Milliseconds 250
  }

  if (-not $health) {
    $tail = ''
    try { $tail = (@(Get-Content -LiteralPath $errLog -Tail 12 -ErrorAction Stop) -join "`n") } catch { }
    try {
      if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
    $detail = ''
    if ($tail.Trim()) { $detail = "`n`n错误输出（最后 12 行）：`n$tail" }
    Show-AppError ("本地服务启动失败（端口 $chosen）。`n`n日志目录：`n$stateDirPath$detail")
    exit 1
  }

  Save-AppState -StateFile $stateFile -Port $chosen -ProcessId ([int]$health.pid)
  if (-not $NoBrowser) { Open-AppUi $chosen }
  exit 0
} catch {
  Show-AppError ("启动器异常：`n" + $_.Exception.Message + "`n`n可改用 run.cmd 查看控制台输出。")
  exit 1
}
