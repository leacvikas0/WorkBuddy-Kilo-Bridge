# WorkBuddy-Kilo-Bridge

**High-Reliability Local Proxy & Translation Layer Connecting Kilo Code to WorkBuddy AI**

- **Base URL**: `http://127.0.0.1:4121/v1`
- **Health Check**: `http://127.0.0.1:4121/healthz`

---

## Setup on a New Laptop (Quick Install)

### 1. Prerequisites
- **Node.js** (v18+ or v20+ recommended)
- **WorkBuddy Desktop App** installed and logged in on the machine.

### 2. Clone & Install
```powershell
git clone <YOUR_GIT_REMOTE_URL> WorkBuddy-Kilo-Bridge
cd WorkBuddy-Kilo-Bridge
npm install
```

### 3. Register & Start 24/7 Background Service
Run the setup script (no admin rights needed):
```powershell
powershell -ExecutionPolicy Bypass -File .\setup-service.ps1
```

### 4. Verify Bridge Status
```powershell
.\manage-bridge.ps1 status
```
You should see:
```text
[+] Service Status: Running (Task: Ready)
[+] Health Check:   OK (http://127.0.0.1:4121/healthz -> {"ok":true})
```

---

## Management CLI

Use `manage-bridge.ps1` to control the 24/7 background service:

```powershell
# Check status & health
.\manage-bridge.ps1 status

# Clean restart (terminates stale instances and relaunches)
.\manage-bridge.ps1 restart

# View live logs
.\manage-bridge.ps1 logs -Follow
```

---

## Documentation Index

Comprehensive documentation is organized in the [`docs/`](file:///C:/Users/silen/Documents/WorkBuddy-Kilo-Bridge/docs/) directory:

1. **[Architecture & Design Specification](file:///C:/Users/silen/Documents/WorkBuddy-Kilo-Bridge/docs/ARCHITECTURE.md)**:
   - System design and request pipeline.
   - Normalization layer (`max_tokens`, `tool_choice`, `stop`, `cache_control`).
   - Image optimization engine (MozJPEG 85 4:4:4, sliding window).
   - 24/7 Windows Task Scheduler supervisor.
   - Dual-supervisor conflict root-cause analysis.
2. **[API Reference](file:///C:/Users/silen/Documents/WorkBuddy-Kilo-Bridge/docs/API_REFERENCE.md)**:
   - Endpoints (`/healthz`, `/v1/models`, `/v1/chat/completions`).
   - Model specifications (`deepseek-v4.1-flash`, `hy4-preview`).
   - Token usage and cache mapping.
3. **[Operations & Troubleshooting](file:///C:/Users/silen/Documents/WorkBuddy-Kilo-Bridge/docs/OPERATIONS.md)**:
   - Service management via PowerShell.
   - Fixing `ECONNRESET`, 32k reasoning loops, and error 6004.
   - WorkBuddy desktop authentication refreshes.

---

## Directory Structure

```
WorkBuddy-Kilo-Bridge/
|-- server.js                 # Primary HTTP server (Port 4121)
|-- daemon.js                 # Supervisor process (Health checks, auto-restart)
|-- run-bridge-daemon.vbs     # Headless WScript runner for Task Scheduler
|-- setup-service.ps1         # Windows Scheduled Task installer
|-- manage-bridge.ps1         # Operator CLI (status, start, stop, restart, logs)
|-- package.json              # Project manifest and test runner
|-- README.md                 # Project index & quickstart
|-- workbuddy-bridge.log      # Active runtime logs
|-- lib/
|   |-- auth.js               # WorkBuddy desktop credentials reader
|   |-- pool.js               # Multi-account pool manager & sticky quota failover
|   |-- images.js             # MozJPEG image compressor & sliding window
|   |-- models.js             # Model registry & capabilities
|   |-- normalize.js          # Request schema normalization
|   |-- translate.js          # SSE streaming relay & chunk sanitization
|-- test/
|   |-- auth.test.js          # Auth discovery & token parsing unit tests
|   |-- pool.test.js          # Account pool rotation & 429 failover unit tests
|   |-- images.test.js        # Image downscaling & compression unit tests
|   |-- normalize.test.js     # Body normalization & edge case tests
|   |-- server.test.js        # HTTP route & account failover integration tests
|   |-- translate.test.js     # SSE parsing & usage translation tests
|   |-- live-smoke.js         # Live upstream smoke test suite
|-- docs/
    |-- ARCHITECTURE.md       # Technical architecture specification
    |-- API_REFERENCE.md      # Endpoint & model specifications
    |-- OPERATIONS.md         # Operational handbook & troubleshooting
```

---

## Running Unit Tests

Verify the entire bridge test suite with:

```bash
npm test
```
