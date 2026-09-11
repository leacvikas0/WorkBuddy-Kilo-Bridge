[CmdletBinding()]
param (
    [Parameter(Position=0)]
    [ValidateSet("status", "start", "stop", "restart", "logs")]
    [string]$Action = "status",

    [Parameter()]
    [int]$Lines = 50,

    [Parameter()]
    [switch]$Follow
)

$bridgeDir = $PSScriptRoot
if (-not $bridgeDir) {
    $bridgeDir = (Get-Location).Path
}
$taskName = "WorkBuddy-Kilo-Bridge"
$logFile = Join-Path $bridgeDir "workbuddy-bridge.log"
$port = 4121

function Get-BridgeProcesses {
    $pids = [System.Collections.Generic.HashSet[int]]::new()

    # Processes listening on port 4121
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            if ($c.OwningProcess -gt 0) {
                [void]$pids.Add($c.OwningProcess)
            }
        }
    }

    # Bridge wscript and node processes
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.CommandLine -like "*run-bridge-daemon.vbs*") -or
        ($_.CommandLine -like "*daemon.js*" -and ($_.CommandLine -like "*WorkBuddy*" -or $_.CommandLine -like "*$bridgeDir*")) -or
        ($_.CommandLine -like "*server.js*" -and ($_.CommandLine -like "*WorkBuddy*" -or $_.CommandLine -like "*$bridgeDir*"))
    }
    foreach ($p in $procs) {
        [void]$pids.Add($p.ProcessId)
    }

    return $pids
}

function Test-BridgeHealth {
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2 -ErrorAction Stop
        return ($res.ok -eq $true)
    } catch {
        return $false
    }
}

switch ($Action) {
    "status" {
        Write-Host "--- WorkBuddy Bridge Status ---" -ForegroundColor Cyan

        # Scheduled Task status
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
            Write-Host "Scheduled Task:   Present ($($task.State))" -ForegroundColor Green
            Write-Host "Last Run Time:    $($taskInfo.LastRunTime)"
            Write-Host "Last Task Result: $($taskInfo.LastTaskResult)"
        } else {
            Write-Host "Scheduled Task:   Not registered (run .\setup-service.ps1)" -ForegroundColor Yellow
        }

        # Port status
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 }
        if ($conns) {
            $owningPids = ($conns | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
            Write-Host "Port $port :       Listening (PID: $owningPids)" -ForegroundColor Green
        } else {
            Write-Host "Port $port :       Not listening" -ForegroundColor Yellow
        }

        # Health endpoint
        $healthy = Test-BridgeHealth
        if ($healthy) {
            Write-Host "Health Probe:     Healthy (http://127.0.0.1:$port/healthz -> ok: true)" -ForegroundColor Green
        } else {
            Write-Host "Health Probe:     Unreachable or Unhealthy" -ForegroundColor Red
        }

        # Active processes
        $pids = Get-BridgeProcesses
        if ($pids.Count -gt 0) {
            Write-Host "`nActive Processes:" -ForegroundColor Cyan
            foreach ($pidVal in $pids) {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId = $pidVal" -ErrorAction SilentlyContinue
                if ($p) {
                    Write-Host "  PID $($p.ProcessId): $($p.Name) -> $($p.CommandLine)"
                }
            }
        }
    }

    "start" {
        Write-Host "Starting WorkBuddy Bridge..." -ForegroundColor Cyan
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq 'Running' -and -not (Test-BridgeHealth)) {
                Write-Host "Task is marked Running but unhealthy. Restarting task..." -ForegroundColor Yellow
                Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
            }
            Start-ScheduledTask -TaskName $taskName
            Write-Host "Task '$taskName' triggered."
        } else {
            Write-Host "Scheduled task not found. Running setup-service.ps1..." -ForegroundColor Yellow
            & (Join-Path $bridgeDir "setup-service.ps1")
        }

        Write-Host "Waiting for service to become healthy..."
        $healthy = $false
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            if (Test-BridgeHealth) {
                $healthy = $true
                break
            }
        }

        if ($healthy) {
            Write-Host "[+] WorkBuddy Bridge is up and running." -ForegroundColor Green
        } else {
            Write-Warning "Service did not respond healthy within 10 seconds. Check logs: .\manage-bridge.ps1 logs"
        }
    }

    "stop" {
        Write-Host "Stopping WorkBuddy Bridge..." -ForegroundColor Cyan

        # Stop Scheduled Task if running
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Write-Host "Stopped Scheduled Task '$taskName'."
        }

        # Terminate any related processes
        $pids = Get-BridgeProcesses
        if ($pids.Count -gt 0) {
            foreach ($pidVal in $pids) {
                Write-Host "Terminating PID $pidVal..."
                cmd.exe /c "taskkill /F /T /PID $pidVal" 2>$null
                Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
            }
        }

        Start-Sleep -Seconds 1
        if (Test-BridgeHealth) {
            Write-Warning "Bridge still seems to be responding. Retrying kill..."
            $pids2 = Get-BridgeProcesses
            foreach ($p2 in $pids2) {
                cmd.exe /c "taskkill /F /T /PID $p2" 2>$null
                Stop-Process -Id $p2 -Force -ErrorAction SilentlyContinue
            }
        }

        Write-Host "[+] WorkBuddy Bridge stopped." -ForegroundColor Green
    }

    "restart" {
        Write-Host "Restarting WorkBuddy Bridge..." -ForegroundColor Cyan
        $scriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { Join-Path $bridgeDir "manage-bridge.ps1" }
        & $scriptPath -Action "stop"
        Start-Sleep -Seconds 2
        & $scriptPath -Action "start"
    }

    "logs" {
        if (-not (Test-Path $logFile)) {
            Write-Host "No log file found at $logFile" -ForegroundColor Yellow
            return
        }

        if ($Follow) {
            Write-Host "Tailing log file ($logFile) - Press Ctrl+C to exit..." -ForegroundColor Cyan
            Get-Content -Path $logFile -Tail $Lines -Wait
        } else {
            Write-Host "Displaying last $Lines lines of $($logFile):" -ForegroundColor Cyan
            Get-Content -Path $logFile -Tail $Lines
        }
    }
}
