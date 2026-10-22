Option Explicit
' Creates "LCEDA2Altium" launch/stop shortcuts on the desktop. ASCII-only on
' purpose; Chinese names and messages live in tools\make-shortcut.ps1.

Dim sh, fso, root, ps
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\tools\make-shortcut.ps1"""

On Error Resume Next
sh.Run ps, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start PowerShell." & vbCrLf & "Error: " & Err.Description, vbExclamation, "LCEDA2Altium"
End If
