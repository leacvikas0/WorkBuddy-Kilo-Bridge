# WorkBuddy-Kilo-Bridge Operations & Troubleshooting Manual

This manual covers both platforms. Sections 1–3 are Windows-specific; section 4 covers
Linux. If you are setting up Linux for the first time, read
[`HANDOFF_LINUX.md`](HANDOFF_LINUX.md) first, then [`AGENTS.md`](../AGENTS.md).

---

## 1. Quick Operations — Windows (CLI)

All bridge operations can be performed using `manage-bridge.ps1` from PowerShell. Run it
from the repo directory:

```powershell
# Check current health, port binding, and process tree
powershell -ExecutionPolicy Bypass -File .\manage-bridge.ps1 status

# Clean restart (terminates rogue instances and restarts service)
powershell -ExecutionPolicy Bypass -File .\manage-bridge.ps1 restart

# Stop the bridge and scheduled task
powershell -ExecutionPolicy Bypass -File .\manage-bridge.ps1 stop

# Start the bridge scheduled task
powershell -ExecutionPolicy Bypass -File .\manage-bridge.ps1 start

# View live trailing logs
powershell -ExecutionPolicy Bypass -File .\manage-bridge.ps1 logs -Follow
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
  cd <REPO_DIRECTORY>
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

### Scenario C: "usage exceeds frequency limit" (Error 6004 / HTTP 429)
- **Automatic Resolution**: With the multi-account pool (`lib/pool.js`), the bridge automatically catches HTTP 429 and error code 6004, rotates the active account to the next available account in `accounts/`, and retries the request transparently in <400ms without failing the Kilo Code session.
- **Account Pool Status**:
  ```powershell
  .\manage-bridge.ps1 status
  ```
  Shows configured accounts and which account is currently active.
- **Manual Rotation (if desired)**:
  ```powershell
  .\manage-bridge.ps1 -Action switch
  ```

### Scenario D: "auth_expired" or 401 Unauthorized
- **Cause**: WorkBuddy desktop login session expired or logged out on all configured accounts.
- **Fix**: Open the official **WorkBuddy Desktop application**, log in or refresh your session. The bridge automatically picks up updated tokens from disk and runs `tryRefresh()` with `refreshToken`.
- **Note**: `tryRefresh()` currently fails — the refresh endpoint returns `404 Route Not Found`. The bridge still recovers by re-reading the credential file and rotating accounts, but it cannot mint new tokens. If all accounts return 401, re-harvest on Windows (see [`HANDOFF_LINUX.md`](HANDOFF_LINUX.md)).

---

## 4. Linux Operations

On Linux the bridge runs under **systemd** instead of the Windows Scheduled Task. The
Windows-only files (`daemon.js`, `setup-service.ps1`, `manage-bridge.ps1`,
`run-bridge-daemon.vbs`) are not used.

### 4.1 Service control

```bash
# Status and recent log lines
systemctl status workbuddy-bridge

# Start / stop / restart
sudo systemctl start workbuddy-bridge
sudo systemctl stop workbuddy-bridge
sudo systemctl restart workbuddy-bridge

# Follow the log live
journalctl -u workbuddy-bridge -f
# or, if the unit appends to a file:
tail -f workbuddy-bridge.log

# Start automatically on boot
sudo systemctl enable workbuddy-bridge
```

### 4.2 Health checks

```bash
curl -s http://127.0.0.1:4121/healthz
# {"ok":true}

curl -s http://127.0.0.1:4121/v1/models

# Which process owns port 4121
ss -ltnp | grep 4121
```

### 4.3 Credential checks

```bash
# List harvested accounts (never prints tokens)
ls -l accounts/

# Verify one credential against the live upstream
WB_LIVE=1 WB_AUTH_PATH=accounts/account_1.json node test/live-smoke.js

# Full test suite
npm test
```

### 4.4 Unit file location

`/etc/systemd/system/workbuddy-bridge.service`. After editing it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart workbuddy-bridge
```

The canonical unit file template is in [`AGENTS.md`](../AGENTS.md) §4.

### 4.5 Troubleshooting on Linux

**`upstream unreachable`**
The machine cannot reach `https://www.workbuddy.ai`. Test directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 https://www.workbuddy.ai/
```

`000` means blocked. Some hosting providers restrict outbound traffic to package
registries only. This is an environment limitation, not a bridge bug — the bridge needs
that hop to function.

**`auth_missing`**
No readable credential. Confirm `accounts/*.json` exists and each file has
`auth.accessToken` and `account.uid`.

**Port already in use**
```bash
sudo systemctl stop workbuddy-bridge
ss -ltnp | grep 4121        # identify the holder
```
Do not run a second supervisor alongside systemd — see §3 Scenario A for the Windows
equivalent of that failure mode.

**`sharp` fails to load**
Re-run `npm install`. Prebuilt Linux binaries are downloaded automatically; no build
toolchain is normally required.

