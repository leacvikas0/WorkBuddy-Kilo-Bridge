# Linux Handoff — Windows Harvest, Linux Run

This document is the human journey. If you are an **agent** on the Linux machine, read
[`AGENTS.md`](../AGENTS.md) instead — it is the actionable brief. This file explains the
*why* and the two-phase flow.

The bridge is a local proxy that connects coding harnesses (Kilo Code, OpenCode) to
WorkBuddy AI. The catch: **WorkBuddy's desktop client only exists for Windows and macOS,
and credentials are issued by logging into that client.** The bridge itself, however,
runs fine on Linux.

So the workflow is a two-phase handoff:

```
PHASE 1 (Windows, once)          PHASE 2 (Linux, permanent)
  log in to WorkBuddy   ──────►   copy credentials in
  harvest credentials              install + start service
  VERIFY they work                 wire the harnesses
  upload to cloud drive            verify end to end
```

Windows is a one-time stop. After Phase 1 it is never needed again unless a token
expires (roughly yearly) or the user logs in again on Windows.

---

## Phase 1 — On Windows (one time)

### 1.1 Log in to WorkBuddy

Install the official **WorkBuddy Desktop** app on Windows and sign in with each account
the user wants to use — typically 2–3 accounts. Log out and back in between accounts so
each login is recorded separately.

Each login writes a **timestamped backup** of the credential file:

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
  workbuddy-desktop-ai.info                          <- most recent login
  workbuddy-desktop-ai.<timestamp>.<pid>.<uuid>.info <- every previous login
```

**This is the key detail.** The file without a timestamp only holds the *last* account.
The timestamped files hold every account ever logged in on this machine. Harvesting only
`workbuddy-desktop-ai.info` silently loses every other account.

### 1.2 Harvest every account

Scan **all** `.info` files in that directory, and for each one:

1. Parse the JSON.
2. Read `account.uid` and `auth.accessToken`.
3. Compute the token's expiry by decoding the JWT payload (`exp` claim).
4. Group by `account.uid` and keep the **newest** entry per uid (most recent expiry).

Then write one credential file per unique account into this repo's `accounts/`
directory, in the format the bridge expects:

```json
{
  "index": 0,
  "key": "<uid>",
  "name": "<display name — nickname or email>",
  "account": { "uid": "<uuid>", "name": "<nickname>", "email": "<email>" },
  "auth": {
    "accessToken": "<jwt>",
    "refreshToken": "<token>",
    "domain": "www.workbuddy.ai",
    "tokenType": "Bearer"
  }
}
```

`accounts/` is gitignored — these files must never be committed. Name them something
stable and non-identifying, e.g. `account_1.json`, `account_2.json`.

### 1.3 Verify on Windows — do not skip this

This is the single most important step in Phase 1. **Prove each harvested credential
works while still on Windows.**

```powershell
$env:WB_LIVE='1'
$env:WB_AUTH_PATH='accounts\account_1.json'
node test\live-smoke.js
```

Expected output:

```
auth ok uid=<uuid> tokenLen=<n>
status=200
stream ok bytes=<n>
{"usage":{...}}
```

Repeat for every file in `accounts/`. Any credential that fails here is dead — log in
again in the WorkBuddy client for that account, re-harvest, and re-verify.

**Why this matters:** if a bad credential is only discovered after the user has rebooted
into Linux, the fix requires rebooting back into Windows, logging in again, re-harvesting,
and re-transferring. Verifying now costs 30 seconds. Not verifying can cost an hour.

### 1.4 Transfer

Zip the repo — or at minimum the `accounts/` folder — and upload it to a cloud drive.
The user then downloads it on the Linux machine.

Because the machine dual-boots, Windows and Linux never run at the same time. There is no
network path between them, so transfer must go through a cloud drive or physical media.

**Security note:** the archive contains live credentials. It should not be shared, should
not be uploaded anywhere public, and should be deleted from the cloud drive once Phase 2
is complete.

---

## Phase 2 — On Linux (permanent)

Hand [`AGENTS.md`](../AGENTS.md) to the agent on the Linux machine. It contains the full
task list. Summary of what happens:

1. **Place credentials.** The `accounts/` folder must end up inside the repo directory.
   Verify with `ls accounts/` — expect one JSON file per harvested account.
2. **Install.** `npm install` (Node >= 18; Node 20+ recommended).
3. **Test the platform.** `npm test` — all 85 tests must pass.
4. **Verify network.** The machine must reach `https://www.workbuddy.ai`. Some hosting
   providers restrict outbound traffic; if this fails, the bridge cannot work.
5. **Verify each credential.** Same live smoke test as Phase 1, now on Linux.
6. **Install the service.** A systemd unit replaces the Windows-only `daemon.js`, giving
   start-on-boot and restart-on-crash.
7. **Wire the harnesses.** Kilo Code and OpenCode provider blocks, both pointing at
   `http://127.0.0.1:4121/v1`.
8. **Verify end to end.** A real completion through the bridge, then one real task in the
   harness.

Details, exact commands, and the systemd unit are in `AGENTS.md` §4–§7.

---

## What is Windows-only and must be replaced

| File | Status | Replacement |
| --- | --- | --- |
| `daemon.js` | Windows-only (`netstat -ano`, `taskkill`, `windowsHide`) | systemd unit — see `AGENTS.md` §4 |
| `setup-service.ps1` | Windows Scheduled Task installer | Not needed; use systemd |
| `manage-bridge.ps1` | PowerShell operator CLI | Not needed; use `systemctl` |
| `run-bridge-daemon.vbs` | WScript headless launcher | Not needed |

Everything else — `server.js` and all of `lib/` — is platform-neutral and runs unchanged.
The server has no `process.platform` branches, and `sharp` ships prebuilt Linux binaries.
This was verified: the full suite passes on Debian 12 and Debian 13, and a live completion
was served from a Linux container.

---

## Ongoing maintenance

**Normally nothing.** The service starts on boot and restarts itself if it crashes.

**When tokens expire (roughly yearly):** repeat Phase 1. There is no working automatic
refresh — the refresh endpoint the code calls returns `404 Route Not Found`. Re-logging in
on Windows and re-harvesting is the supported path.

**If the user logs in on Windows again:** that may invalidate the Linux copy of that
account, because refresh tokens rotate. Either re-harvest, or give each machine its own
accounts. See `AGENTS.md` §8.

**If a harness stops responding:** check `systemctl status workbuddy-bridge` and
`curl http://127.0.0.1:4121/healthz`. Then check the log file named in the systemd unit.
