# Native Windows path picker used by POST /api/pick-path.
# Prints the chosen path to stdout (UTF-8) and exits:
#   0 = chosen (stdout has the path)
#   2 = canceled
#   1 = error (stderr has the message)
#
# Stored as UTF-8 with BOM for Windows PowerShell 5.1.

[CmdletBinding()]
param(
  [ValidateSet('folder', 'schlib', 'pcblib')]
  [string]$Mode = 'folder',
  [string]$InitialDir = '',
  [string]$FileName = ''
)

$ErrorActionPreference = 'Stop'
# Node reads stdout as UTF-8. Setting Console.OutputEncoding alone is not enough
# when stdout is redirected (PowerShell 5.1 keeps the original writer), so the
# final path and errors are written as raw UTF-8 bytes below.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$owner = $null
$dialog = $null
$output = ''
$exitCode = 1

try {
  # Invisible top-most owner: makes the dialog appear in front of the browser.
  $owner = New-Object System.Windows.Forms.Form
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.Show()
  [System.Windows.Forms.Application]::DoEvents()

  if ($Mode -eq 'folder') {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择输出目录'
    $dialog.ShowNewFolderButton = $true
    if ($InitialDir -and (Test-Path -LiteralPath $InitialDir -PathType Container)) {
      $dialog.SelectedPath = (Resolve-Path -LiteralPath $InitialDir).Path
    }
  } else {
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.CheckFileExists = $false
    $dialog.CheckPathExists = $true
    $dialog.OverwritePrompt = $false   # 目标库是追加/合并，不覆盖
    $dialog.AddExtension = $true
    $dialog.RestoreDirectory = $true
    $dialog.SupportMultiDottedExtensions = $true
    if ($Mode -eq 'schlib') {
      $dialog.Title = '选择目标原理图库（.SchLib）'
      $dialog.Filter = 'Altium 原理图库 (*.SchLib)|*.SchLib|所有文件 (*.*)|*.*'
      $dialog.DefaultExt = 'SchLib'
    } else {
      $dialog.Title = '选择目标封装库（.PcbLib）'
      $dialog.Filter = 'Altium 封装库 (*.PcbLib)|*.PcbLib|所有文件 (*.*)|*.*'
      $dialog.DefaultExt = 'PcbLib'
    }
    if ($InitialDir -and (Test-Path -LiteralPath $InitialDir -PathType Container)) {
      $dialog.InitialDirectory = (Resolve-Path -LiteralPath $InitialDir).Path
    }
    if ($FileName) { $dialog.FileName = $FileName }
  }

  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    if ($Mode -eq 'folder') { $output = $dialog.SelectedPath } else { $output = $dialog.FileName }
    if ([string]::IsNullOrWhiteSpace($output)) { $exitCode = 2 } else { $exitCode = 0 }
  } else {
    $exitCode = 2
  }
} catch {
  $errBytes = $Utf8NoBom.GetBytes($_.Exception.Message + "`n")
  $stderr = [Console]::OpenStandardError()
  $stderr.Write($errBytes, 0, $errBytes.Length)
  $stderr.Flush()
  $exitCode = 1
} finally {
  if ($dialog) { $dialog.Dispose() }
  if ($owner) { $owner.Close(); $owner.Dispose() }
}

if ($output) {
  $outBytes = $Utf8NoBom.GetBytes($output + "`n")
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($outBytes, 0, $outBytes.Length)
  $stdout.Flush()
}
exit $exitCode
