# Shared helpers for launch.ps1 / stop.ps1 / make-shortcut.ps1.
# Stored as UTF-8 **with BOM**: Windows PowerShell 5.1 otherwise decodes the
# Chinese strings below with the ANSI code page and shows garbled text.

$script:AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:AppId = 'lceda2altium'
$script:DefaultPort = 43180
$script:MaxPort = 43200

function Get-AppRoot { return $script:AppRoot }

function Resolve-StateDir([string]$StateDir) {
  $dir = $StateDir
  if (-not $dir) { $dir = $env:LCEDA2ALTIUM_STATE_DIR }
  if (-not $dir) {
    # Portable copies can ship a state-dir.txt so they do not share the
    # original folder's state/log files. %VARS% are expanded.
    $marker = Join-Path $script:AppRoot 'state-dir.txt'
    if (Test-Path -LiteralPath $marker) {
      try { $dir = (Get-Content -LiteralPath $marker -Raw -ErrorAction Stop).Trim() } catch { $dir = '' }
      if ($dir) { $dir = [Environment]::ExpandEnvironmentVariables($dir) }
    }
  }
  if (-not $dir) { return (Join-Path $env:LOCALAPPDATA 'LCEDA2Altium') }
  if (-not [IO.Path]::IsPathRooted($dir)) { $dir = Join-Path $script:AppRoot $dir }
  return [IO.Path]::GetFullPath($dir)
}

function Get-NormalizedPath([string]$Path) {
  if (-not $Path) { return '' }
  try { return ([IO.Path]::GetFullPath($Path)).TrimEnd('\').ToLowerInvariant() }
  catch { return $Path.TrimEnd('\').ToLowerInvariant() }
}

function Read-AppState([string]$StateFile) {
  if (-not $StateFile -or -not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return (Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop | ConvertFrom-Json) }
  catch { return $null }
}

function Save-AppState([string]$StateFile, [int]$Port, [int]$ProcessId) {
  $dir = Split-Path -Parent $StateFile
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $obj = [ordered]@{
    pid = $ProcessId
    port = $Port
    root = $script:AppRoot
    startedAt = (Get-Date).ToString('o')
  }
  # UTF-8 without BOM: the file is read by PowerShell and may be inspected by tools.
  [IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ListeningPorts([int]$Min, [int]$Max) {
  $result = @()
  try {
    $result = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -ge $Min -and $_.LocalPort -le $Max } |
      Select-Object -ExpandProperty LocalPort -Unique)
  } catch {
    # Fallback for systems without Get-NetTCPConnection.
    foreach ($line in @(& netstat.exe -ano -p tcp 2>$null)) {
      if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+\d+\s*$') {
        $p = [int]$Matches[1]
        if ($p -ge $Min -and $p -le $Max) { $result += $p }
      }
    }
    $result = @($result | Select-Object -Unique)
  }
  return $result
}

# Returns the health object for OUR app on $Port, or $null.
# Handles both the current /api/health server and older builds that only
# serve the UI (identified by the build button marker).
function Get-AppHealth([int]$Port, [int]$TimeoutSec = 1) {
  $base = "http://127.0.0.1:$Port/"
  $healthResponded = $false
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop -Uri ($base + 'api/health')
    if ($r.StatusCode -eq 200) {
      $h = $r.Content | ConvertFrom-Json
      if ($h -and $h.app -eq $script:AppId) {
        $healthResponded = $true
        if ((Get-NormalizedPath ([string]$h.root)) -eq (Get-NormalizedPath $script:AppRoot)) {
          return $h
        }
      }
    }
  } catch { }
  # A different copy of this app (same name, other folder) is not ours.
  if ($healthResponded) { return $null }

  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop -Uri $base
    if ($r.StatusCode -eq 200 -and $r.Content -match 'id="build-btn"') {
      $owner = 0
      $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($conn) { $owner = [int]$conn.OwningProcess }
      return [pscustomobject]@{
        ok = $true; app = $script:AppId; legacy = $true; busy = $false;
        pid = $owner; port = $Port; root = $script:AppRoot; startedAt = $null
      }
    }
  } catch { }
  return $null
}

# Reuse the state file first (fast, and survives a "still starting" server),
# then scan the launcher's port window.
function Get-RunningInstance([string]$StateFile, [int]$MinPort = 43180, [int]$MaxPort = 43200) {
  $state = Read-AppState $StateFile
  if ($state -and [int]$state.port -gt 0) {
    $statePort = [int]$state.port
    $h = Get-AppHealth $statePort 1
    if ($h) { return $h }
    $statePid = 0
    if ($state.pid) { $statePid = [int]$state.pid }
    $maybeStarting = ($statePid -le 0) -or [bool](Get-Process -Id $statePid -ErrorAction SilentlyContinue)
    if ($maybeStarting -and @(Get-ListeningPorts $statePort $statePort).Count -gt 0) {
      # Port is open but the app is not answering yet: wait for this instance
      # instead of starting a second one.
      for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        $h = Get-AppHealth $statePort 1
        if ($h) { return $h }
      }
    }
  }
  foreach ($p in @(Get-ListeningPorts $MinPort $MaxPort)) {
    $h = Get-AppHealth ([int]$p) 1
    if ($h) { return $h }
  }
  return $null
}

function Test-PortFree([int]$Port) {
  if (@(Get-ListeningPorts $Port $Port).Count -gt 0) { return $false }
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch { return $false }
}

function Find-Node {
  # Portable build: use the node.exe shipped next to the project first.
  $bundled = Join-Path $script:AppRoot 'node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'nvm\current\node.exe') }
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Get-BrowserPath {
  $candidates = @()
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  }
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

# Prefer the browser's "app window" (no address bar / tabs), which makes the
# local UI feel like a desktop app. Falls back to the default browser.
function Open-AppUi([int]$Port) {
  $url = "http://127.0.0.1:$Port/"
  $browser = Get-BrowserPath
  if ($browser) {
    try {
      Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--window-size=1360,900') -ErrorAction Stop
      return
    } catch { }
  }
  Start-Process -FilePath $url
}

function Show-AppError([string]$Text, [string]$Title = '立创元件 → Altium') {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show($Text, $Title,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  } catch {
    try {
      Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
      [System.Windows.MessageBox]::Show($Text, $Title) | Out-Null
    } catch { }
  }
}

function Show-AppConfirm([string]$Text, [string]$Title = '立创元件 → Altium') {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $answer = [System.Windows.Forms.MessageBox]::Show($Text, $Title,
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning)
    return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
  } catch { return $true }
}

function Get-NodeProcessInfo([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  try { return Get-CimInstance Win32_Process -Filter ("ProcessId=$ProcessId") -ErrorAction Stop }
  catch { return $null }
}

# Kills the server and its job/Altium-pipeline children, but only after
# verifying the PID is still a node process running server.mjs (PID reuse guard).
function Stop-OurServer([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  $proc = Get-NodeProcessInfo $ProcessId
  if (-not $proc) { return $false }
  if ($proc.Name -notmatch '^node(\.exe)?$') { return $false }
  if ($proc.CommandLine -and $proc.CommandLine -notmatch 'server\.mjs') { return $false }
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { return $true }
  try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop; return $true }
  catch { return $false }
}
