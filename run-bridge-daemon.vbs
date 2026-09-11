Option Explicit
Dim fso, wsh, bridgeDir, nodeExe, daemonScript, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")

bridgeDir = fso.GetParentFolderName(WScript.ScriptFullName)
daemonScript = bridgeDir & "\daemon.js"

If fso.FileExists("C:\nvm4w\nodejs\node.exe") Then
    nodeExe = "C:\nvm4w\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
Else
    nodeExe = "node.exe"
End If

wsh.CurrentDirectory = bridgeDir
cmd = """" & nodeExe & """ """ & daemonScript & """"
wsh.Run cmd, 0, True
