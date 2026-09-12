const FALLBACK_SYSTEM = 'You are a helpful assistant.';

function ensureSystemFirst(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: 'system', content: FALLBACK_SYSTEM }];
  }
  // 1. Normalize every message: convert all 'developer' roles to 'system'
  // while preserving all other properties (including cache_control, content arrays, etc.)
  const normalized = messages.map((m) => {
    if (m && m.role === 'developer') {
      return { ...m, role: 'system' };
    }
    return m;
  });

  // 2. Find the first system message
  const sysIdx = normalized.findIndex((m) => m && m.role === 'system');
  if (sysIdx === 0) {
    return normalized;
  }
  if (sysIdx > 0) {
    const sysMsg = normalized[sysIdx];
    const rest = normalized.filter((_, i) => i !== sysIdx);
    return [sysMsg, ...rest];
  }
  // 3. No system message found: prepend fallback system prompt
  return [{ role: 'system', content: FALLBACK_SYSTEM }, ...normalized];
}

function normalizeToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (typeof choice === 'object') {
    // OpenAI format: { type: "function", function: { name: "..." } }
    if (choice.function && typeof choice.function.name === 'string') {
      return choice.function.name;
    }
    // Vercel AI SDK format: { type: "tool", toolName: "..." }
    if (typeof choice.toolName === 'string') {
      return choice.toolName;
    }
    // Alternative tool formats
    if (choice.tool && typeof choice.tool.name === 'string') {
      return choice.tool.name;
    }
    if (typeof choice.name === 'string') {
      return choice.name;
    }
    // Mode strings: { type: "auto" } | { type: "required" } | { type: "none" }
    if (typeof choice.type === 'string' && choice.type !== 'function' && choice.type !== 'tool') {
      return choice.type;
    }
    // If it's an object with type === 'function' or 'tool' but missing name, default to 'auto'
    if (choice.type === 'function' || choice.type === 'tool') {
      return 'auto';
    }
    // Any other object: NEVER return an object to upstream (causes HTTP 400 unmarshal error)
    return undefined;
  }
  return String(choice);
}

function normalizeStop(stop) {
  if (stop === undefined || stop === null) return undefined;
  if (typeof stop === 'string') return [stop];
  if (Array.isArray(stop)) return stop.map((s) => (s == null ? '' : String(s)));
  return [String(stop)];
}

function normalizeModel(model) {
  if (!model) return 'hy4-preview';
  const m = String(model).trim().toLowerCase();
  if (m === 'deepseek-v4.1' || m === 'deepseek-flash' || m === 'deepseek-v4-flash' || m === 'deepseek-v41' || m === 'deepseek-v4.1-flash') {
    return 'deepseek-v4.1-flash';
  }
  if (m === 'deepseek-v3' || m === 'deepseek-v3.0') return 'deepseek-v3';
  if (m === 'hy4-preview' || m === 'hy4') return 'hy4-preview';
  return model;
}

function normalizeReasoningEffort(val) {
  if (!val) return undefined;
  const s = String(val).trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'max') return s;
  return undefined;
}

function buildUpstreamBody(inBody) {
  if (!inBody || !Array.isArray(inBody.messages)) {
    throw Object.assign(new Error('messages array is required'), { statusCode: 400, code: 'bad_request' });
  }
  const out = {
    model: normalizeModel(inBody.model),
    messages: ensureSystemFirst(inBody.messages),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (inBody.temperature !== undefined) out.temperature = inBody.temperature;
  if (inBody.top_p !== undefined) out.top_p = inBody.top_p;
  if (inBody.tools !== undefined) out.tools = inBody.tools;
  if (inBody.tool_choice !== undefined) {
    const choice = normalizeToolChoice(inBody.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }
  const maxTokens = inBody.max_tokens ?? inBody.max_completion_tokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    const num = Number(maxTokens);
    const resolved = Number.isFinite(num) ? Math.round(num) : maxTokens;
    // Upstream Tencent supports a 64k completion token ceiling (65536 tokens)
    out.max_tokens = typeof resolved === 'number' && resolved > 65536 ? 65536 : resolved;
  }
  if (inBody.stop !== undefined && inBody.stop !== null) {
    out.stop = normalizeStop(inBody.stop);
  }
  if (inBody.reasoning_effort !== undefined && inBody.reasoning_effort !== null) {
    const effort = normalizeReasoningEffort(inBody.reasoning_effort);
    if (effort) out.reasoning_effort = effort;
  }
  if (inBody.thinking !== undefined && inBody.thinking !== null) {
    out.thinking = inBody.thinking;
  }
  if (inBody.budget_tokens !== undefined && inBody.budget_tokens !== null) {
    const b = Number(inBody.budget_tokens);
    if (Number.isFinite(b) && b > 0) out.budget_tokens = Math.round(b);
  }
  return out;
}

module.exports = {
  ensureSystemFirst,
  buildUpstreamBody,
  normalizeToolChoice,
  normalizeStop,
  normalizeModel,
  normalizeReasoningEffort,
  FALLBACK_SYSTEM
};