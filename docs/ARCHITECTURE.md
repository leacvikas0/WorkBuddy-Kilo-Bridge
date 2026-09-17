# WorkBuddy-Kilo-Bridge Architecture & Design Specification

## 1. System Overview

`WorkBuddy-Kilo-Bridge` is a lightweight, local HTTP proxy and translation layer running on `127.0.0.1:4121`. It sits between the **Kilo Code** VS Code extension and Tencent's **WorkBuddy AI** backend service.

```
+-------------------------------------------------------------------------+
|                              LOCAL MACHINE                              |
|                                                                         |
|  +----------------+        HTTP / SSE        +-----------------------+  |
|  |   Kilo Code    | -----------------------> | WorkBuddy-Kilo-Bridge |  |
|  |  (in VS Code)  | <----------------------- |   (Port 4121, Node)   |  |
|  +----------------+   OpenAI Compatible API  +-----------------------+  |
|                                                          |              |
|                                                          | HTTPS        |
|                                                          v              |
+----------------------------------------------------------|--------------+
                                                           |
                                                           v
                                            +-----------------------------+
                                            |  Tencent WorkBuddy Cloud    |
                                            | (www.workbuddy.ai/v2/chat)  |
                                            +-----------------------------+
```

### Core Responsibilities
1. **OpenAI Compatibility**: Emulates standard OpenAI `/v1/chat/completions` and `/v1/models` endpoints.
2. **Local Credential Extraction**: Transparently extracts user session tokens from the official WorkBuddy Desktop application.
3. **Payload Normalization**: Adapts Kilo Code's `@ai-sdk/openai-compatible` request dialect to Tencent's Go-struct backend.
4. **Image Compression**: Resizes and compresses screenshots and base64 images into optimized MozJPEG format, preventing 50MB payload crashes and server timeouts.
5. **Stream Sanitization**: Strips upstream empty delta noise keys to ensure smooth live typing inside Kilo Code without visual stuttering.

---

## 2. Codebase Organization & File Map

Base Directory: the repository root (referred to below as `<REPO>`).

```
WorkBuddy-Kilo-Bridge/
|-- server.js                 # Primary HTTP server (Port 4121)
|-- daemon.js                 # Supervisor process (Health checks, auto-restart)
|-- run-bridge-daemon.vbs     # Headless WScript runner for Task Scheduler
|-- setup-service.ps1         # Windows Scheduled Task installer
|-- manage-bridge.ps1         # Operator CLI (status, start, stop, restart, logs)
|-- package.json              # Project manifest and npm test script
|-- package-lock.json         # Pinned dependency tree
|-- README.md                 # Primary entry point & project index
|-- workbuddy-bridge.log      # Active runtime log
|-- workbuddy-bridge.log.old  # Rotated log file
|-- lib/
|   |-- auth.js               # WorkBuddy desktop credentials reader
|   |-- images.js             # MozJPEG image compressor & sliding window
|   |-- models.js             # Model registry & capabilities
|   |-- normalize.js          # Request schema normalization
|   |-- translate.js          # SSE streaming relay & chunk sanitization
|-- test/
|   |-- auth.test.js          # Auth discovery & token parsing unit tests
|   |-- images.test.js        # Image downscaling & compression unit tests
|   |-- normalize.test.js     # Body normalization & edge case tests
|   |-- server.test.js        # HTTP route integration tests
|   |-- translate.test.js     # SSE parsing & usage translation tests
|   |-- live-smoke.js         # Live upstream smoke test suite
|-- docs/
    |-- ARCHITECTURE.md       # (This document) Deep technical specification
    |-- API_REFERENCE.md      # Endpoint & model specifications
    |-- OPERATIONS.md         # Operational handbook & troubleshooting
```

---

## 3. Component Deep Dive

### 3.1 server.js (HTTP Service Entry Point)
- **Port**: Default 4121 (configurable via PORT environment variable).
- **Timeouts**: Configured with `headersTimeout: 120s` and `requestTimeout: 180s` to support long multi-file reasoning turns without socket reset.
- **Routes**:
  - `GET /healthz`: Returns `{"ok": true, "modelCount": 2}`. Used by the supervisor daemon and PowerShell scripts to verify operational status.
  - `GET /v1/models`: Returns OpenAI-formatted list of active models (`deepseek-v4.1-flash`, `hy4-preview`).
  - `POST /v1/chat/completions`: Main inference endpoint. Authenticates, optimizes images, normalizes schemas, connects upstream to Tencent, and relays SSE streams.

### 3.2 lib/auth.js (Authentication Engine)
- **Source**: Reads the WorkBuddy session from a local credential file. On Windows the
  default path is `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info`.
  On Linux this path does not exist; credentials come from the harvested files in
  `accounts/` instead. `WB_AUTH_PATH=<path>` overrides all discovery and pins a single file.
- **Dynamic Refresh**: The credential file is re-read on every request. If the file is
  updated externally, the bridge picks up the new Bearer token without a restart.
- **Header Injection**: Constructs upstream headers including `Authorization: Bearer <token>`, `X-Client-Version: 1.0.0`, and browser spoofing headers required by Tencent's gateway.

### 3.3 lib/normalize.js (Schema Adaptation)
Kilo Code generates requests using `@ai-sdk/openai-compatible`. Tencent's backend parses requests using strict Go struct unmarshaling. Several mismatches occur that this module resolves:

1. **`max_tokens` vs `max_completion_tokens`**:
   - When reasoning is enabled, Kilo Code deletes `max_tokens` and transmits `max_completion_tokens`.
   - Tencent strictly honors `max_tokens` and ignores `max_completion_tokens`.
   - Normalizer maps: `out.max_tokens = inBody.max_tokens ?? inBody.max_completion_tokens`.
2. **`tool_choice` Struct Mismatch**:
   - Kilo Code emits object format: `tool_choice: { type: "function", function: { name: "edit_file" } }`.
   - Tencent rejects this with HTTP 400 (`cannot unmarshal object into Go struct field Request.tool_choice of type string`).
   - Normalizer extracts `tool_choice.function.name` as a raw string.
3. **`stop` Array Mismatch**:
   - Kilo Code can emit a string: `stop: "Observation:"`.
   - Tencent requires string array `[]string`. Normalizer coerces strings to array.
4. **Cache Control Retention**:
   - Preserves `cache_control: { type: "ephemeral" }` on message blocks to guarantee Tencent's prompt prefix cache hits.

### 3.4 lib/images.js (Image Optimization Engine)
Screenshots captured by Kilo Code during automated browser testing or canvas reviews can reach 49MB+ of base64 JSON payload. This caused memory bloat, high latency, and HTTP ECONNRESET crashes.

- **Pipeline**: Uses `sharp` with MozJPEG engine (`quality: 85`, `chromaSubsampling: '4:4:4'`).
- **Resolution Cap**: Clamps maximum image dimension to 1920px while preserving aspect ratio.
- **Sliding Window**: Enforces `MAX_ACTIVE_IMAGES = 3`. Retains the 3 most recent images and replaces older images with lightweight placeholder text markers `[Image omitted to conserve context]`.
- **Result**: Reduced a 49.3MB payload to ~350KB, slashing latency from 50s timeouts to 8.8s successful completions.

### 3.5 lib/translate.js (Stream Processing & Chunk Sanitization)
- Relays Server-Sent Events (SSE) from Tencent to Kilo Code chunk-by-chunk with zero buffering.
- **Chunk Sanitization**: Upstream emits deltas with empty arrays or null fields (`tool_calls: []`, `function_call: null`). Kilo Code interprets any delta key as a UI boundary, causing split thinking boxes. `sanitizeDelta` strips empty keys so that reasoning flows into a single unified `<think>` block.
- **Usage Normalization**: Normalizes Tencent's `prompt_cache_hit_tokens` into OpenAI standard `prompt_tokens_details.cached_tokens`, allowing Kilo Code to accurately track cache hit rates in its database.

---

## 4. Supervision & Process Lifecycle

### 4.1 Architecture
The service is designed to run 24/7 as an independent Windows background task, completely decoupled from VS Code and Antigravity IDE.

```
[Windows Task Scheduler (svchost.exe)]
       |
       v
  run-bridge-daemon.vbs (Headless WScript runner, WindowStyle 0)
       |
       v
  daemon.js (Node supervisor with 1024MB heap)
       |
       +---> /healthz probe every 15s
       +---> Port 4121 listener supervisor
       |
       v
  server.js (Worker child process running port 4121)
```

### 4.2 The Dual-Supervisor Port Conflict (Root Cause Analysis)
During system restart or manual CLI re-execution, an intermittent failure mode occurred where requests repeatedly dropped or reset (`ECONNRESET`).

**Root Cause**:
1. When Windows rebooted, Task Scheduler launched `daemon.js` under `wscript.exe`.
2. A separate instance of `daemon.js` was simultaneously running from a different Node environment (`C:\Program Files\nodejs\node.exe` vs `C:\nvm4w\nodejs\node.exe`).
3. Both daemons contained logic:
   ```javascript
   function freePort(port) {
     // Runs taskkill on whatever PID is listening on port 4121
   }
   ```
4. **The Conflict**: Daemon A started `server.js` on port 4121. Daemon B ran its startup check, detected port 4121 occupied, and killed Daemon A's server. Daemon B then started its own `server.js`. Daemon A detected its child died, triggered a restart, and killed Daemon B's server.
5. This produced a continuous 5-second kill loop, making the bridge work intermittently depending on whether a request landed during the brief ~2-second window before the rival daemon executed taskkill.
6. **Resolution**: Running `manage-bridge.ps1 restart` terminates all stale and conflicting instances across both Node paths and restarts a single supervisor cleanly under Task Scheduler.

---

## 5. Multi-Account Pool & Sticky Quota Failover (`lib/pool.js`)

### 5.1 Why Sticky Rotation?
Tencent's prompt prefix caching is strictly scoped to the authenticated `X-User-Id` and session token. Alternating accounts per request (round-robin) destroys prompt cache hits (dropping cache hit rate from 96.8% to 0%), resulting in massive latency spikes and burning account quotas 10x faster.

`AccountPool` implements a **sticky failover strategy**:
1. **Stick to Active Account**: All consecutive turns use the current active account, maintaining maximum prompt cache hit rate (~96.8%).
2. **Quota / Frequency Limit Detection**: When upstream returns HTTP 429 or JSON containing `code: 6004`, `frequency limit`, or `usage exceeds`, the bridge:
   - Rotates `activeIndex` to the next account in the pool.
   - Saves the updated pointer state to `accounts/active.json`.
   - Re-signs headers and retries the upstream request transparently before writing any response bytes to the client.
   - Kilo Code waits on the open connection and receives a seamless HTTP 200 stream without error modals or broken agent turns.
3. **Session Expiry (401) Recovery**: When an account returns 401, the bridge calls `tryRefresh()` with `refreshToken` and updates the refreshed token on disk (`account.filePath`), keeping credentials fresh across reboots.
4. **Security**: The `accounts/` directory is strictly ignored in `.gitignore`, ensuring personal tokens are never pushed to Git.

---

## 6. Platform Portability

The bridge is designed to run on both Windows and Linux. The split is clean:

### 6.1 Platform-neutral (runs unchanged on Linux)

| File | Notes |
| --- | --- |
| `server.js` | No `process.platform` branches. Binds `127.0.0.1:4121`. |
| `lib/auth.js` | Pure file read + `fetch`. |
| `lib/pool.js` | Directory scan; default path is Windows-shaped but `WB_AUTH_PATH` and `accounts/` make it moot. |
| `lib/normalize.js` | Pure transformation. |
| `lib/translate.js` | Stream relay. |
| `lib/loop-detector.js` | Pure detection, no I/O. |
| `lib/continuation.js` | Pure transformation. |
| `lib/models.js` | Static registry. |
| `lib/images.js` | Uses `sharp`, which ships prebuilt Linux x64/arm64 binaries. |

This was verified empirically, not assumed: the full test suite passes on Debian 12 and
Debian 13, `sharp` loads with vips 8.18.6, and a live streaming completion was served
from a Linux container.

### 6.2 Windows-only (must be replaced on Linux)

| File | Why it is Windows-only | Linux replacement |
| --- | --- | --- |
| `daemon.js` | `netstat -ano` for port discovery, `taskkill /F /T` for process termination, `windowsHide` spawn option | systemd unit — see [`AGENTS.md`](../AGENTS.md) §4 |
| `setup-service.ps1` | Registers a Windows Scheduled Task | `systemctl enable --now` |
| `manage-bridge.ps1` | PowerShell operator CLI over Scheduled Tasks and `Get-NetTCPConnection` | `systemctl` / `journalctl` — see [`OPERATIONS.md`](OPERATIONS.md) §4 |
| `run-bridge-daemon.vbs` | WScript headless launcher | Not needed |

None of these are required for the bridge to serve traffic. They only provide
start-on-boot and restart-on-crash, which systemd supplies natively.

### 6.3 Network requirement

The host must be able to reach `https://www.workbuddy.ai`. This is the one hard external
dependency. Sandboxed or restricted hosting environments that allowlist only package
registries will fail at this hop with `upstream unreachable`, even though the bridge
itself is healthy. Verify before deploying:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 https://www.workbuddy.ai/
```

### 6.4 Credentials on Linux

There is no WorkBuddy desktop client for Linux, so credentials cannot be minted locally.
They are harvested on Windows and copied in — see [`HANDOFF_LINUX.md`](HANDOFF_LINUX.md).
`lib/pool.js` scans `accounts/*.json`, so placing one file per account in that directory
is all that is required. Tokens are ~1-year JWTs; there is currently no working automatic
refresh (the refresh endpoint returns `404 Route Not Found`), so renewal means
re-harvesting on Windows.
