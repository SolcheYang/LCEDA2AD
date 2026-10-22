# Creates desktop shortcuts for the one-click launcher and the stopper.
# Invoked by 创建桌面快捷方式.vbs.

[CmdletBinding()]
param(
  [switch]$Quiet,
  [string]$TargetDir = ''   # testing: create the .lnk files here instead of the desktop
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-common.ps1')
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

try {
  $desktop = $TargetDir
  if (-not $desktop) { $desktop = [Environment]::GetFolderPath('Desktop') }
  if (-not $desktop) { throw '无法定位桌面目录。' }
  New-Item -ItemType Directory -Force -Path $desktop | Out-Null

  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscript)) { throw '找不到 wscript.exe。' }

  $browser = Get-BrowserPath
  $shell = New-Object -ComObject WScript.Shell
  $items = @(
    [pscustomobject]@{ Name = '立创元件转Altium'; Script = '启动.vbs'; Desc = '启动本地服务，并在应用窗口中打开界面'; BrowserIcon = $true },
    [pscustomobject]@{ Name = '停止服务 - 立创元件转Altium'; Script = '停止服务.vbs'; Desc = '停止本地服务'; BrowserIcon = $false }
  )

  $made = @()
  foreach ($item in $items) {
    $path = Join-Path $desktop ($item.Name + '.lnk')
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $wscript
    $lnk.Arguments = '"' + (Join-Path $script:AppRoot $item.Script) + '"'
    $lnk.WorkingDirectory = $script:AppRoot
    $lnk.Description = $item.Desc
    $lnk.WindowStyle = 1
    if ($browser -and $item.BrowserIcon) { $lnk.IconLocation = $browser + ',0' }
    $lnk.Save()
    $made += $path
  }

  if (-not $Quiet) {
    [System.Windows.Forms.MessageBox]::Show(
      ("已创建桌面快捷方式：`n`n" + ($made -join "`n") + "`n`n不用时可直接删除这些 .lnk 文件。"),
      '立创元件 → Altium',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  }
  exit 0
} catch {
  Show-AppError ("创建快捷方式失败：`n" + $_.Exception.Message)
  exit 1
}
