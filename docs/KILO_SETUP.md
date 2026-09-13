# Connecting Kilo Code to WorkBuddy-Kilo-Bridge

This guide explains how to connect **Kilo Code** (VS Code extension) to your local **WorkBuddy-Kilo-Bridge** (`http://127.0.0.1:4121/v1`).

---

## 1. Quick Config (`kilo.jsonc`)

The fastest and most reliable way to configure Kilo Code is by editing your configuration file:
* **Windows**: `%USERPROFILE%\.config\kilo\kilo.jsonc` (e.g. `C:\Users\<username>\.config\kilo\kilo.jsonc`)
* **macOS / Linux**: `~/.config/kilo/kilo.jsonc`

### Add the `workbuddy` Provider

Insert the following inside the `"provider"` object of `kilo.jsonc`:

```jsonc
{
  "provider": {
    "workbuddy": {
      "name": "WorkBuddy",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "wb-local-bridge",
        "baseURL": "http://127.0.0.1:4121/v1",
        "timeout": 600000,
        "chunkTimeout": 600000
      },
      "models": {
        "deepseek-v4.1-flash": {
          "id": "deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash (WorkBuddy Free)",
          "attachment": true,
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "cost": {
            "input": 0.0,
            "output": 0.0
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {
            "reasoningEffort": "max"
          },
          "variants": {
            "low": {
              "reasoningEffort": "low",
              "thinking": { "type": "enabled", "budgetTokens": 16000 }
            },
            "medium": {
              "reasoningEffort": "medium",
              "thinking": { "type": "enabled", "budgetTokens": 32000 }
            },
            "high": {
              "reasoningEffort": "high",
              "thinking": { "type": "enabled", "budgetTokens": 64000 }
            },
            "max": {
              "reasoningEffort": "max",
              "thinking": { "type": "enabled", "budgetTokens": 120000 }
            }
          }
        },
        "hy4-preview": {
          "id": "hy4-preview",
          "name": "HY4 Preview (WorkBuddy)",
          "attachment": true,
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": {
            "context": 1048576,
            "output": 131072
          },
          "cost": {
            "input": 0.0,
            "output": 0.0
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      },
      "whitelist": [
        "deepseek-v4.1-flash",
        "hy4-preview"
      ]
    }
  },
  // Set default model in Kilo Code:
  "model": "workbuddy/deepseek-v4.1-flash"
}
```

---

## 2. Configuration Parameters Explained

| Field | Value | Why it matters |
|---|---|---|
| `baseURL` | `http://127.0.0.1:4121/v1` | Points to the local bridge HTTP daemon |
| `apiKey` | `wb-local-bridge` | Any string (bridge extracts real auth tokens locally) |
| `timeout` | `600000` (10 min) | **Critical**: Deep reasoning models (`<think>`) can think for 30–60s without emitting text. Default 30s timeouts cause premature `ECONNRESET`. |
| `chunkTimeout` | `600000` (10 min) | Ensures SSE stream does not drop during quiet thinking phases. |
| `limit.context` | `1048576` (1M) | Allows Kilo Code to submit large codebases and multi-turn histories. |
| `limit.output` | `131072` (128k) | Prevents Kilo Code from prematurely truncating output or exhausting reasoning budget. |
| `variants.*.budgetTokens` | `16k` to `120k` | Enables switching thinking effort in Kilo's model selector. |

---

## 3. Alternative: Kilo Code UI Setup

If you prefer configuring via the Kilo Code extension interface:

1. Open **VS Code**.
2. Click the **Kilo Code** icon in the activity bar.
3. Open **Settings** (gear icon) -> **Providers**.
4. Select **Add Custom Provider** (or choose **OpenAI Compatible**).
5. Configure fields:
   * **Provider Name**: `WorkBuddy`
   * **Base URL**: `http://127.0.0.1:4121/v1`
   * **API Key**: `wb-local-bridge` (or any non-empty string)
6. Add Models:
   * Model ID: `deepseek-v4.1-flash`
   * Model ID: `hy4-preview`
7. Enable **Streaming**, **Tool Calling**, and **Reasoning**.
8. Save settings and select `WorkBuddy: deepseek-v4.1-flash` as your active model.

---

## 4. What the Bridge Normalizes Automatically

You don't need any extra plugins in Kilo Code because the bridge automatically handles upstream WorkBuddy incompatibilities:

1. **`max_completion_tokens` Translation**:
   Kilo Code emits `max_completion_tokens` for reasoning models; upstream WorkBuddy only understands `max_tokens`. The bridge maps this transparently and auto-expands legacy 32k limits to 128k.
2. **Object `tool_choice` Conversion**:
   Kilo Code passes `{ function: { name: "..." } }`; upstream expects a plain string name. The bridge converts it automatically.
3. **Array `stop` Sequences**:
   Upstream Go structs strictly require `[]string`; single strings are converted into arrays.
4. **Image Compression**:
   Screenshots or images attached in Kilo Code are compressed via MozJPEG (85% quality, 4:4:4 chroma) before upstream transmission to prevent HTTP 413 payload rejections.
5. **Sticky Multi-Account Quota Failover**:
   If an upstream account hits HTTP 429 or quota error 6004, the bridge rotates to the next available account while keeping existing sessions pinned to avoid cache invalidation.
