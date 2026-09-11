# WorkBuddy-Kilo-Bridge Operations & Troubleshooting Manual

## 1. Quick Operations (CLI)

All bridge operations can be performed using `manage-bridge.ps1` from PowerShell:

```powershell
# Check current health, port binding, and process tree
powershell -ExecutionPolicy Bypass -File C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge\manage-bridge.ps1 status

# Clean restart (terminates rogue instances and restarts service)
powershell -ExecutionPolicy Bypass -File C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge\manage-bridge.ps1 restart

# Stop the bridge and scheduled task
powershell -ExecutionPolicy Bypass -File C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge\manage-bridge.ps1 stop

# Start the bridge scheduled task
powershell -ExecutionPolicy Bypass -File C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge\manage-bridge.ps1 start

# View live trailing logs
powershell -ExecutionPolicy Bypass -File C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge\manage-bridge.ps1 logs -Follow
```

---

## 2. Windows Scheduled Task Service

The bridge is registered as a persistent Windows Scheduled Task named **`WorkBuddy-Kilo-Bridge`**.

### Properties:
- **Trigger**: Runs automatically at user logon (`-AtLogon`).
- **Detachment**: Hosted under Windows `svchost.exe` via `wscript.exe //B run-bridge-daemon.vbs`.
- **Survives**: Closing VS Code, closing Antigravity IDE, closing terminal windows, and system logoffs/reboots.
- **Re-installing the Task**:
  ```powershell
  cd C:\Users\silen\Documents\WorkBuddy-Kilo-Bridge
  powershell -ExecutionPolicy Bypass -File .\setup-service.ps1
  ```

---

## 3. Common Troubleshooting Scenarios

### Scenario A: "Bridge works intermittently" or `ECONNRESET`
- **Cause**: Two supervisor `daemon.js` processes running concurrently (e.g. from `nvm4w` and `Program Files
odejs`). Both try to free port 4121 and kill each other's server process every 5 seconds.
- **Diagnosis**:
  ```powershell
  .\manage-bridge.ps1 status
  ```
  Check `Active Processes`. If more than one `daemon.js` PID appears, they are colliding.
- **Fix**:
  ```powershell
  .\manage-bridge.ps1 restart
  ```
  This kills all instances and starts exactly one.

### Scenario B: "Output limit reached while reasoning" (Empty Output)
- **Cause**: DeepSeek-V4.1-Flash has a hard 32,000 token ceiling on reasoning tokens. If a subagent runs on `variant: "max"` for complex code generation, it drafts all files in its head, hitting the 32k cap and returning 0 output tokens.
- **Fix**: In Kilo Code, switch subagents to `variant: "high"` or `"medium"`.

### Scenario C: "usage exceeds frequency limit" (Error 6004)
- **Cause**: Daily token allowance reached on the free tier of `deepseek-v4.1-flash`.
- **Reset Time**: Upstream resets daily at `00:02:28 UTC+8` (16:02 UTC / 21:32 IST).
- **Workaround**: Switch to `hy4-preview` in Kilo Code (Hunyuan has separate independent quotas).

### Scenario D: "auth_expired" or 401 Unauthorized
- **Cause**: WorkBuddy desktop login session expired or logged out.
- **Fix**: Open the official **WorkBuddy Desktop application**, log in or refresh your session. The bridge automatically picks up the updated token on the very next request without requiring a bridge restart.
