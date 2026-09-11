# setup-service.ps1 - Registers and starts WorkBuddy-Kilo-Bridge scheduled task
$ErrorActionPreference = "Stop"

$bridgeDir = $PSScriptRoot
if (-not $bridgeDir) {
    $bridgeDir = (Get-Location).Path
}
$vbsPath = Join-Path $bridgeDir "run-bridge-daemon.vbs"
$taskName = "WorkBuddy-Kilo-Bridge"

Write-Host "=== Setting up WorkBuddy-Kilo-Bridge Background Service ===" -ForegroundColor Cyan
Write-Host "Bridge Directory: $bridgeDir"
Write-Host "Launcher Script:  $vbsPath"

if (-not (Test-Path $vbsPath)) {
    throw "Required launcher script not found: $vbsPath"
}

# Stop any existing bridge instance to ensure clean state
Write-Host "Stopping any existing bridge instances..."
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$conns = Get-NetTCPConnection -LocalPort 4121 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    if ($c.OwningProcess -gt 0) {
        cmd.exe /c "taskkill /F /T /PID $($c.OwningProcess)" 2>$null
    }
}
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.CommandLine -like "*run-bridge-daemon.vbs*") -or
    ($_.CommandLine -like "*daemon.js*" -and ($_.CommandLine -like "*WorkBuddy*" -or $_.CommandLine -like "*$bridgeDir*"))
}
foreach ($p in $procs) {
    cmd.exe /c "taskkill /F /T /PID $($p.ProcessId)" 2>$null
}
Start-Sleep -Milliseconds 500

# Define scheduled task action
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbsPath`"" -WorkingDirectory $bridgeDir

# Define logon trigger for current user
$trigger = New-ScheduledTaskTrigger -AtLogon -User "$env:USERDOMAIN\$env:USERNAME"

# Define task settings: persistent 24/7 background operation
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Priority 4

Write-Host "Registering scheduled task '$taskName' (without -Principal for non-admin compatibility)..."
$null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "WorkBuddy Kilo Bridge 24/7 Background Service" -Force

Write-Host "Starting scheduled task '$taskName'..."
Start-ScheduledTask -TaskName $taskName

Write-Host "Waiting for service to initialize..."
Start-Sleep -Seconds 2

# Verify task state
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host "[+] Scheduled Task State: $($task.State)" -ForegroundColor Green

# Verify /healthz probe
$healthy = $false
for ($i = 0; $i -lt 10; $i++) {
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:4121/healthz" -TimeoutSec 2 -ErrorAction Stop
        if ($res.ok -eq $true) {
            $healthy = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

if ($healthy) {
    Write-Host "[+] WorkBuddy Bridge is healthy at http://127.0.0.1:4121/healthz (ok: true)" -ForegroundColor Green
} else {
    Write-Warning "Task started, but /healthz did not respond with ok: true within 10 seconds. Check logs."
}

Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
