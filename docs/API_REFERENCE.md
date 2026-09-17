# WorkBuddy-Kilo-Bridge API Reference

Base URL: `http://127.0.0.1:4121`

---

## 1. Endpoints

### 1.1 `GET /healthz`
Probes the health of the bridge server.

- **Request**: None
- **Response**: `200 OK`
  ```json
  {
    "ok": true,
    "uptime": 1420.5,
    "modelCount": 2
  }
  ```

---

### 1.2 `GET /v1/models`
Returns OpenAI-compatible model registry.

- **Request Headers**: None required
- **Response**: `200 OK`
  ```json
  {
    "object": "list",
    "data": [
      {
        "id": "deepseek-v4.1-flash",
        "object": "model",
        "created": 1740000000,
        "owned_by": "tencent-workbuddy"
      },
      {
        "id": "hy4-preview",
        "object": "model",
        "created": 1740000000,
        "owned_by": "tencent-workbuddy"
      }
    ]
  }
  ```

---

### 1.3 `POST /v1/chat/completions`
Standard chat completion inference endpoint. Supports streaming SSE and non-streaming responses.

- **Request Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <any-string>` (ignored; authentication is extracted locally)
- **Request Body (OpenAI Standard)**:
  ```json
  {
    "model": "deepseek-v4.1-flash",
    "messages": [
      { "role": "system", "content": "You are a coding assistant." },
      { "role": "user", "content": "Write hello world in Python" }
    ],
    "stream": true,
    "max_tokens": 4096,
    "temperature": 0.7
  }
  ```
- **SSE Stream Response**:
  Relays Server-Sent Events with sanitized deltas:
  ```
  data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"print('hello world')"}}]}

  data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":5,"total_tokens":125,"prompt_tokens_details":{"cached_tokens":100}}}

  data: [DONE]
  ```

---

## 2. Supported Models & Specifications

| Model Identifier | Display Name | Native Context | Max Output | Reasoning Support | Vision / Images |
|---|---|:---:|:---:|:---:|:---:|
| **`deepseek-v4.1-flash`** | DeepSeek V4.1 Flash | 128,000 | 32,768 | Yes (`<think>`) | Yes (MozJPEG) |
| **`hy4-preview`** | Hunyuan 4 Preview | 1,048,576 | 32,768 | Optional | Yes (MozJPEG) |

---

## 3. Upstream Usage Mapping

The bridge translates Tencent's native token usage schema into OpenAI standard format:

| Upstream Tencent Field | Standard OpenAI Output | Kilo Code Storage Field |
|---|---|---|
| `prompt_tokens` | `usage.prompt_tokens` | `tokens.input` (uncached portion) |
| `prompt_cache_hit_tokens` | `usage.prompt_tokens_details.cached_tokens` | `tokens.cache.read` |
| `completion_tokens` | `usage.completion_tokens` | `tokens.output` |
| `reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens` | `tokens.reasoning` |
| `total_tokens` | `usage.total_tokens` | `tokens.total` |

---

## 4. Loop Guard

When the model degenerates into a repeated-phrase loop, the bridge cuts that
stream and silently continues the turn: it re-sends the same request with an
extra user message quoting the tail of the partial output and instructing the
model to stop restating intent and produce the actual output. The client sees
one continuous stream that still ends with `[DONE]`.

If every attempt loops, or if tool calls had already been streamed (a splice
would corrupt them), the bridge gives up and ends the turn without `[DONE]`,
which is the old fail-fast behavior.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WB_LOOP_GUARD` | `1` | Set to `0` to disable the guard entirely |
| `WB_LOOP_MIN_REPEATS` | `8` | Consecutive repeats of a cycle required to fire |
| `WB_LOOP_MAX_CYCLE_WORDS` | `80` | Longest cycle length (in words) considered |
| `WB_LOOP_TAIL_WORDS` | `1200` | Size of the bounded tail buffer, in words |
| `WB_LOOP_CHECK_EVERY_WORDS` | `40` | Minimum new words between detection passes |
| `WB_LOOP_MAX_RETRIES` | `2` | Continuation attempts before giving up (`0` disables recovery) |

Both `content` and `reasoning_content` are watched, independently. A cycle must carry
information to fire: it needs at least two distinct tokens, or a single token containing
a letter or digit. This prevents ASCII-art rules (`- - - - - - - -`) from being read as
a loop. Invalid values fall back to the default; the bridge always starts.

When the guard fires, the bridge logs:

```
[workbuddy-bridge] loop guard fired: model=deepseek-v4.1-flash channel=reasoning cycleWords=10 repeats=8
[workbuddy-bridge] loop guard: continuing turn (attempt 1/2)
```

and if recovery is exhausted:

```
[workbuddy-bridge] loop guard: retry cap reached (2), failing turn
```

### How recovery stays invisible to the client

- The response head is written exactly once; continuations resume the same
  connection (`lib/translate.js` `createRelay`).
- Resumed chunks are rewritten with the first attempt's stream `id`/`model`/
  `created`, so the client cannot tell two upstream streams apart.
- Only deltas actually forwarded are quoted back in the continuation prompt;
  the quoted tails are capped so the degenerate text does not return in full.
- A loop on the `content` channel mid-tool-call is not retried.


