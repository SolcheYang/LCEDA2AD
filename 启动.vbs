Option Explicit
' One-click launcher: starts/reuses the local server without a console window
' and opens the UI in a browser app window. This file is ASCII-only on purpose;
' all Chinese messages live in tools\launch.ps1 (UTF-8 with BOM).

Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\tools\launch.ps1"""

On Error Resume Next
sh.Run ps, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start PowerShell." & vbCrLf & "Try run.cmd instead." & vbCrLf & vbCrLf & "Error: " & Err.Description, vbExclamation, "LCEDA2Altium"
End If
