# AGENTS.md — Read This First

You are the agent on a Linux machine. This repo is a working local proxy that connects
Kilo Code / OpenCode to **WorkBuddy AI** (Tencent). Your job: get the bridge running on
this Linux box as a persistent service, wire the coding harnesses to it, and verify it
end to end.

The repo was authored on Windows. The server code is already cross-platform. Only the
*service supervision* layer is Windows-only and needs replacing. Everything you need to
know is in this file and `docs/HANDOFF_LINUX.md`.

---

## 1. What you have

```
server.js              HTTP server, port 4121. Cross-platform. Do not rewrite.
lib/auth.js            Reads WorkBuddy credentials from a JSON file. Cross-platform.
lib/pool.js            Multi-account pool + quota failover. Cross-platform.
lib/normalize.js       OpenAI -> Tencent request schema adapter. Cross-platform.
lib/translate.js       SSE relay, loop-guard integration. Cross-platform.
lib/loop-detector.js   Repetition-loop detection. Cross-platform. DO NOT DISABLE.
lib/continuation.js    Builds the continuation request after a loop cut. Cross-platform.
lib/images.js          sharp-based image compression. Works on Linux.
lib/models.js          Model registry. Cross-platform.
test/                  node --test suite. 85 tests. Must pass before you finish.
accounts/              Credentials live here. GITIGNORED. Never commit.
daemon.js              WINDOWS-ONLY supervisor. Replace with systemd.
setup-service.ps1      WINDOWS-ONLY. Ignore.
manage-bridge.ps1      WINDOWS-ONLY. Ignore.
run-bridge-daemon.vbs  WINDOWS-ONLY. Ignore.
```

`server.js` binds `127.0.0.1:4121` by default. Port override: `PORT` env var.

---

## 2. Your task, in order

1. **Confirm credentials exist.** `accounts/*.json` must be present and valid. If the
   directory is empty, stop and ask the user to run the Windows harvest step
   (`docs/HANDOFF_LINUX.md`, Phase 1). Do not invent credentials.
2. **Install dependencies.** `npm install` (needs Node >= 18; Node 20+ recommended).
3. **Run the test suite.** `npm test` — all 85 tests must pass. This proves the
   platform is supported. If `sharp` fails to load, `npm install` again; the prebuilt
   Linux binaries are fetched automatically.
4. **Verify upstream reachability.** The host must be able to reach
   `https://www.workbuddy.ai`. See §5.
5. **Prove each credential works.** Run the live smoke test per account (§5). Do not
   skip this — a dead credential discovered now saves a reboot later.
6. **Create a systemd unit** so the bridge runs on boot and restarts on crash (§4).
7. **Wire the harnesses** — Kilo Code and OpenCode (§6).
8. **Verify end to end** — a real completion through the bridge (§7).

---

## 3. Credential format

`lib/auth.js` requires exactly two fields from each file:

```json
{
  "account": { "uid": "<uuid>" },
  "auth": {
    "accessToken": "<jwt>",
    "refreshToken": "<token>",
    "domain": "www.workbuddy.ai",
    "tokenType": "Bearer"
  }
}
```

- Only `auth.accessToken` and `account.uid` are strictly required.
- `auth.domain` defaults to `www.workbuddy.ai` if absent.
- The filename is irrelevant to the bridge. `lib/pool.js` scans `accounts/*.json`
  (excluding `active.json`), sorted alphabetically, and uses `name`, `account.email`,
  or `account.name` for display if present.
- `WB_AUTH_PATH=<path>` forces a single credential file and ignores the directory scan.
- Multiple accounts are supported and are the point: on quota exhaustion the bridge
  rotates to the next account transparently (HTTP 429 / error 6004).

**Tokens are ~1-year JWTs.** They do not expire quickly. There is no working automatic
refresh (see §8), so treat credentials as long-lived but finite.

---

## 4. Service supervision on Linux

`daemon.js` is Windows-only (`netstat -ano`, `taskkill`, `windowsHide`) and cannot run
here. Replace it with systemd. Write this to
`/etc/systemd/system/workbuddy-bridge.service`:

```ini
[Unit]
Description=WorkBuddy Kilo Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<THE_USER>
WorkingDirectory=<ABSOLUTE_PATH_TO_THIS_REPO>
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production
Restart=always
RestartSec=3
StandardOutput=append:<ABSOLUTE_PATH_TO_THIS_REPO>/workbuddy-bridge.log
StandardError=append:<ABSOLUTE_PATH_TO_THIS_REPO>/workbuddy-bridge.log

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now workbuddy-bridge
systemctl status workbuddy-bridge
```

Resolve the real path to `node` with `which node` — on nvm/fnm installs `/usr/bin/node`
may not exist. Prefer the absolute path from `which node` in `ExecStart`.

systemd gives you what `daemon.js` gave on Windows: start on boot, restart on crash,
survives logout. The in-repo `daemon.js` is not needed and must not be ported.

---

## 5. Verification (do this before declaring success)

**Upstream reachability:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 20 https://www.workbuddy.ai/
```

`200` or `3xx` is fine. `000` means the network blocks it. Common causes: a VPS
provider with restricted egress (some sandbox providers allowlist only package
registries and block everything else), an outbound firewall, or a proxy requirement.
The bridge cannot work without this hop.

**Per-account live smoke test:**

```bash
WB_LIVE=1 WB_AUTH_PATH=accounts/<file>.json node test/live-smoke.js
```

Expected: `auth ok uid=... tokenLen=...`, then `status=200`, then `stream ok bytes=...`
followed by a usage line. Run it once per credential file. Any failure means that
credential is dead and must be re-harvested on Windows.

**Bridge health:**

```bash
curl -s http://127.0.0.1:4121/healthz
# {"ok":true}
curl -s http://127.0.0.1:4121/v1/models
# {"object":"list","data":[{"id":"hy4-preview",...},{"id":"deepseek-v4.1-flash",...},...]}
```

---

## 6. Wiring the harnesses

Both harnesses use the same OpenAI-compatible provider shape. The bridge ignores the
API key value; any non-empty string works.

### Kilo Code — `~/.config/kilo/kilo.jsonc`

Add inside the existing `"provider"` block:

```jsonc
"workbuddy": {
  "name": "WorkBuddy",
  "npm": "@ai-sdk/openai-compatible",
  "options": {
    "apiKey": "wb-local-bridge",
    "baseURL": "http://127.0.0.1:4121/v1",
    "timeout": 600000,
    "chunkTimeout": 18000000
  },
  "models": {
    "deepseek-v4.1-flash": {
      "id": "deepseek-v4.1-flash",
      "name": "DeepSeek V4.1 Flash (WorkBuddy)",
      "attachment": true,
      "reasoning": true,
      "tool_call": true,
      "temperature": true,
      "limit": { "context": 1048576, "output": 131072 },
      "modalities": { "input": ["text", "image"], "output": ["text"] },
      "options": { "reasoningEffort": "max" }
    },
    "hy4-preview": {
      "id": "hy4-preview",
      "name": "HY4 Preview (WorkBuddy)",
      "attachment": true,
      "reasoning": true,
      "tool_call": true,
      "limit": { "context": 1048576, "output": 131072 },
      "modalities": { "input": ["text", "image"], "output": ["text"] }
    }
  }
}
```

The large `chunkTimeout` is deliberate: long reasoning turns must not be cut for being
quiet. See `docs/KILO_SETUP.md` for the full reference including reasoning tiers.

### OpenCode — `~/.config/opencode/opencode.jsonc`

OpenCode uses the same provider schema:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "workbuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy",
      "options": {
        "baseURL": "http://127.0.0.1:4121/v1",
        "apiKey": "wb-local-bridge",
        "timeout": 600000,
        "chunkTimeout": 18000000
      },
      "models": {
        "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash (WorkBuddy)" },
        "hy4-preview": { "name": "HY4 Preview (WorkBuddy)" }
      }
    }
  },
  "model": "workbuddy/deepseek-v4.1-flash"
}
```

OpenCode supports `{env:VAR}` and `{file:path}` substitution if the user prefers not to
inline the key. Verify the model appears after a restart.

---

## 7. End-to-end check

With the service running:

```bash
curl -s -X POST http://127.0.0.1:4121/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with exactly: BRIDGE-OK"}],"stream":true}'
```

Success looks like SSE lines ending in `data: [DONE]`, with `BRIDGE-OK` split across
`delta.content` chunks and a final `usage` object. If you see
`{"error":{"message":"upstream unreachable",...}}` the network hop is blocked (§5). If
you see `auth_missing` the credentials are not readable (§3).

Then confirm the harness itself works: open Kilo Code (or OpenCode), select a WorkBuddy
model, and complete one real task.

---

## 8. Things that will bite you

**The loop guard is not optional.** `lib/loop-detector.js` detects when the Tencent
model degenerates into repeating the same phrase ("Let me write. Let me search. OK.")
inside its reasoning stream. This is a real, frequently-observed failure of this model,
not a hypothetical. The guard cuts the stream and re-sends the request with a
continuation prompt, invisibly to the client. It was validated against 23,571 real
assistant messages. Do not set `WB_LOOP_GUARD=0`, do not raise
`WB_LOOP_MIN_REPEATS` "to reduce false positives" without data, and do not remove the
guard because it "looks like extra complexity". If the model loops and the guard is
off, the turn burns its entire output budget restating intent and produces nothing.
Configuration is in `docs/API_REFERENCE.md` §4.

**Automatic token refresh does not work.** `lib/auth.js` `tryRefresh()` posts to
`https://www.workbuddy.ai/v2/auth/token/refresh`, which currently returns
`{"error_msg":"404 Route Not Found"}`. The bridge degrades gracefully (it re-reads the
credential file from disk and rotates accounts on 401), but it cannot mint a new token.
When tokens eventually expire, the only fix is re-running the Windows harvest. Do not
promise the user automatic re-authentication.

**Refresh tokens rotate.** Logging into the same account again on Windows can invalidate
the copy already harvested for Linux. If the user uses both machines with the same
account, they can evict each other. The durable fix is to give each machine its own
accounts, or re-harvest after any Windows login.

**Reasoning-token ceiling.** `deepseek-v4.1-flash` has a hard ceiling on reasoning
tokens. A subagent configured with the highest reasoning tier on a large task can spend
its whole budget thinking and return zero output. If the user reports empty responses,
switch that agent to a lower reasoning variant. This is upstream behaviour, not a
bridge bug.

**One supervisor only.** If a `daemon.js`-style supervisor is ever added on Linux, the
same dual-supervisor port conflict documented in `docs/ARCHITECTURE.md` §4.2 can occur.
Do not run both systemd and a hand-started supervisor.

---

## 9. Security rules — non-negotiable

- `accounts/` is gitignored. **Never** `git add` it, never paste a token into a commit,
  an issue, a log, or a chat message.
- Never print a full `accessToken` or `refreshToken` to stdout. Length and prefix are
  fine when debugging.
- Do not move credentials into the repo root, into `test/`, or into any tracked file.
- Do not commit `.env` files. `.gitignore` already covers `.env`, `*.info`, `*.token`,
  and `accounts/`.
- If you write a harvest or export script, it must write to `accounts/` (gitignored)
  and must not echo secrets.
- Before any commit, run:
  ```bash
  git status --short          # accounts/ must not appear
  git diff --cached --stat
  ```
  If a credential file is staged, unstage it and add a `.gitignore` rule.

---

## 10. If something fails

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `upstream unreachable` | Egress blocked | Test the curl in §5. Move hosts or open the firewall. |
| `auth_missing` | No readable credential | Check `accounts/*.json` exists, is valid JSON, has `auth.accessToken` + `account.uid`. |
| `auth_expired` after all accounts tried | Tokens dead | Re-harvest on Windows. |
| `sharp` fails to load | Incomplete install | `npm install` again; prebuilt Linux binaries download automatically. |
| Port 4121 in use | Another instance | `sudo systemctl stop workbuddy-bridge`, then check `ss -ltnp \| grep 4121`. |
| Stream cut with no `[DONE]` | Loop guard gave up | Expected behaviour after `WB_LOOP_MAX_RETRIES` attempts. See §8. |
| Empty model output | Reasoning budget exhausted | Lower the reasoning variant. See §8. |

Full operational detail: `docs/OPERATIONS.md`. Architecture and design rationale:
`docs/ARCHITECTURE.md`. Endpoint and env-var reference: `docs/API_REFERENCE.md`.
