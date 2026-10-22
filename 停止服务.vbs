Option Explicit
' Stops the local server (and any job pipeline it started). ASCII-only on
' purpose; Chinese messages live in tools\stop.ps1 (UTF-8 with BOM).

Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\tools\stop.ps1"""

On Error Resume Next
sh.Run ps, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start PowerShell." & vbCrLf & "Error: " & Err.Description, vbExclamation, "LCEDA2Altium"
End If
