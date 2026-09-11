function parseSseText(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { events, done: true };
      if (!data) continue;
      try { events.push(JSON.parse(data)); } catch { /* skip keep-alive noise */ }
    }
  }
  return { events, done: false };
}

function relayStream(upstreamRes, clientRes) {
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const body = upstreamRes.body;
  if (!body || typeof body.getReader !== 'function') {
    clientRes.end('data: [DONE]\n\n');
    return Promise.resolve();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;
  if (typeof clientRes.on === 'function') {
    clientRes.on('close', () => {
      closed = true;
      try { reader.cancel(); } catch { /* ignore */ }
    });
  }

  const emitBlock = (block) => {
    const datas = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      datas.push(line.slice(5).trim());
    }
    if (datas.some((d) => d === '[DONE]')) {
      try { clientRes.write('data: [DONE]\n\n'); } catch {}
      return;
    }
    const payload = datas.join('\n');
    if (!payload) return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; /* skip keep-alive noise */ }
    try { clientRes.write('data: ' + JSON.stringify(sanitizeChunkEvent(ev)) + '\n\n'); } catch {}
  };

  const pump = () => {
    if (closed) return Promise.resolve();
    return reader.read().then(({ done, value }) => {
      if (closed) return;
      if (done) {
        buf += decoder.decode();
        if (buf.trim()) emitBlock(buf);
        try { clientRes.end(); } catch { /* client gone */ }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop();
      for (const b of blocks) {
        if (b.trim()) emitBlock(b);
      }
      return pump();
    }).catch(() => {
      try { clientRes.end(); } catch { /* client gone */ }
    });
  };

  return pump();
}

// WorkBuddy sends noise keys in every delta (content: "" next to
// reasoning_content, empty tool_calls/function_call/refusal/extra_fields).
// Kilo core treats the stray keys as part boundaries, so word-by-word
// thinking explodes into 100+ Reasoning blocks. Native providers send only
// populated keys and accumulate into one live-growing box. Strip the empties
// per chunk, still fully streaming with zero buffering.
function sanitizeDelta(delta) {
  if (!delta || typeof delta !== 'object') return delta;
  const d = { ...delta };
  if (d.content === '') delete d.content;
  if (d.reasoning_content === '') delete d.reasoning_content;
  if (d.reasoning === '') delete d.reasoning;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length === 0) delete d.tool_calls;
  if (d.function_call == null || (typeof d.function_call === 'object' && !d.function_call.name && !d.function_call.arguments)) {
    delete d.function_call;
  }
  if (d.refusal === '') delete d.refusal;
  if (d.extra_fields == null) delete d.extra_fields;
  return d;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const hit = usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens;
  if (hit != null && Number(hit) > 0) {
    const hitNum = Number(hit);
    if (!usage.prompt_tokens_details || typeof usage.prompt_tokens_details !== 'object') {
      usage.prompt_tokens_details = {};
    }
    if (!usage.prompt_tokens_details.cached_tokens) {
      usage.prompt_tokens_details.cached_tokens = hitNum;
    }
    if (usage.prompt_cache_hit_tokens == null) {
      usage.prompt_cache_hit_tokens = hitNum;
    }
  } else if (usage.prompt_tokens_details?.cached_tokens) {
    if (usage.prompt_cache_hit_tokens == null) {
      usage.prompt_cache_hit_tokens = usage.prompt_tokens_details.cached_tokens;
    }
  }
  return usage;
}

function sanitizeChunkEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  if (ev.usage) {
    normalizeUsage(ev.usage);
  }
  const choice = ev?.choices?.[0];
  if (choice) {
    const updatedChoice = { ...choice };
    if (updatedChoice.finish_reason === '') {
      updatedChoice.finish_reason = null;
    }
    if (updatedChoice.delta && typeof updatedChoice.delta === 'object') {
      updatedChoice.delta = sanitizeDelta(updatedChoice.delta);
    }
    return { ...ev, choices: [updatedChoice] };
  }
  return ev;
}

async function accumulateNonStream(upstreamRes, model) {
  const text = await upstreamRes.text();
  const { events } = parseSseText(text);
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let id = 'wb-' + Date.now();
  let usage = null;
  const toolsByIndex = new Map();
  for (const ev of events) {
    if (ev.id) id = ev.id;
    if (ev.usage) usage = normalizeUsage(ev.usage);
    const choice = ev?.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0;
      const cur = toolsByIndex.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) cur.id = tc.id;
      if (tc.type) cur.type = tc.type;
      if (tc.function?.name) cur.function.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
      toolsByIndex.set(i, cur);
    }
    if (choice.finish_reason && choice.finish_reason !== '') finish = choice.finish_reason;
  }
  const message = { role: 'assistant', content };
  const toolCalls = [...toolsByIndex.values()].filter((t) => t.id || t.function.name || t.function.arguments);
  if (toolCalls.length > 0) { message.tool_calls = toolCalls; finish = 'tool_calls'; }
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'hy4-preview',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage
  };
}

module.exports = { parseSseText, relayStream, accumulateNonStream, sanitizeDelta, sanitizeChunkEvent, normalizeUsage };

