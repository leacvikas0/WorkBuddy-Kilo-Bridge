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
