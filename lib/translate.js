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

// ---------------------------------------------------------------------------
// Stream relay
//
// A relay has a lifetime: it is created once per client turn, writes the
// response head a single time, and can be resumed with a replacement upstream
// when the loop guard cuts the model mid-stream. That keeps the client's
// connection alive across attempts, so Kilo sees one continuous turn.
//
// relayStream() resolves with a result object:
//   { reason: 'done' | 'loop' | 'closed', hit?, partial, meta, sawToolCalls }
// 'loop' is only ever returned when holdOnLoop is set; otherwise a loop ends
// the response without [DONE], exactly as before.
// ---------------------------------------------------------------------------

function createRelay(upstreamRes, clientRes) {
  let headerWritten = false;
  let closed = false;
  const partial = { reasoning: '', content: '' };
  const meta = { id: null, created: null, model: null };
  let sawToolCalls = false;

  if (typeof clientRes.on === 'function') {
    clientRes.on('close', () => { closed = true; });
  }

  function writeHead() {
    if (headerWritten) return;
    headerWritten = true;
    try {
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
    } catch { /* headers already sent */ }
  }

  return {
    writeHead,
    get closed() { return closed; },
    get headerWritten() { return headerWritten; },
    partial,
    meta,
    get sawToolCalls() { return sawToolCalls; },

    /**
     * Relay one upstream response. `options.resume` skips the header write;
     * `options.meta` (optional) rewrites each chunk's id/model/created so a
     * resumed attempt looks like the original stream to the client.
     */
    relay(upstreamRes, options = {}) {
      const guard = options.guard || null;
      const onLoop = options.onLoop || null;
      const holdOnLoop = !!options.holdOnLoop;
      const resume = !!options.resume;
      const forcedMeta = options.meta || null;

      // Seed stream identity from an explicit meta (the relay's own meta is
      // normally passed back in), so resumed chunks keep the first attempt's
      // id/model/created.
      if (forcedMeta) {
        if (forcedMeta.id && !meta.id) meta.id = forcedMeta.id;
        if (forcedMeta.model && !meta.model) meta.model = forcedMeta.model;
        if (forcedMeta.created != null && meta.created == null) meta.created = forcedMeta.created;
      }

      if (!resume) {
        writeHead();
      }

      const body = upstreamRes.body;
      if (!body || typeof body.getReader !== 'function') {
        if (holdOnLoop) return Promise.resolve({ reason: 'done', partial, meta, sawToolCalls });
        try { clientRes.end('data: [DONE]\n\n'); } catch { /* client gone */ }
        return Promise.resolve({ reason: 'done', partial, meta, sawToolCalls });
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let stopped = false;
      let hitResult = null;
      const onClientClose = () => { try { reader.cancel(); } catch { /* ignore */ } };
      if (typeof clientRes.on === 'function') clientRes.on('close', onClientClose);

      const cleanup = () => {
        if (typeof clientRes.off === 'function') clientRes.off('close', onClientClose);
      };

      // Cut the stream without [DONE] so the client sees a failed stream
      // rather than a clean completion.
      const stopForLoop = (hit) => {
        if (stopped) return;
        stopped = true;
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* ignore */ }
        if (typeof onLoop === 'function') {
          try { onLoop(hit); } catch { /* ignore */ }
        }
        hitResult = hit;
        if (!holdOnLoop) {
          try { clientRes.end(); } catch { /* ignore */ }
        }
      };

      const emitBlock = (block) => {
        if (stopped) return;
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
        const clean = sanitizeChunkEvent(ev);

        if (clean && typeof clean.id === 'string' && !meta.id) meta.id = clean.id;
        if (clean && clean.model && !meta.model) meta.model = clean.model;
        if (clean && typeof clean.created === 'number' && meta.created == null) meta.created = clean.created;

        const choice = clean && clean.choices && clean.choices[0];
        const delta = choice && choice.delta;
        if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          sawToolCalls = true;
        }

        if (guard && delta) {
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            const hit = guard.push('reasoning', delta.reasoning_content);
            if (hit) { stopForLoop(hit); return; }
          }
          if (typeof delta.content === 'string' && delta.content) {
            const hit = guard.push('content', delta.content);
            if (hit) { stopForLoop(hit); return; }
          }
        }

        // Track only what was actually forwarded, so the continuation prompt
        // quotes real client-visible text and never re-sends a discarded chunk.
        if (delta) {
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            partial.reasoning += delta.reasoning_content;
          }
          if (typeof delta.content === 'string' && delta.content) {
            partial.content += delta.content;
          }
        }

        let outEv = clean;
        if (forcedMeta) {
          outEv = { ...clean };
          if (meta.id) outEv.id = meta.id;
          if (meta.model) outEv.model = meta.model;
          if (meta.created != null) outEv.created = meta.created;
        }

        const serialized = 'data: ' + JSON.stringify(outEv) + '\n\n';
        try { clientRes.write(serialized); } catch { /* ignore */ }
      };

      const finish = () => {
        cleanup();
        if (stopped) return { reason: 'loop', hit: hitResult, partial, meta, sawToolCalls };
        if (closed) return { reason: 'closed', partial, meta, sawToolCalls };
        return { reason: 'done', partial, meta, sawToolCalls };
      };

      const pump = () => {
        if (closed || stopped) return Promise.resolve();
        return reader.read().then(({ done, value }) => {
          if (closed || stopped) return;
          if (done) {
            buf += decoder.decode();
            if (buf.trim()) emitBlock(buf);
            if (!stopped && !closed) {
              try { clientRes.end(); } catch { /* client gone */ }
            }
            return;
          }
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split(/\r?\n\r?\n/);
          buf = blocks.pop();
          for (const b of blocks) {
            if (b.trim()) emitBlock(b);
            if (stopped) return;
          }
          return pump();
        }).catch(() => {
          if (!stopped && !closed) { try { clientRes.end(); } catch { /* client gone */ } }
        });
      };

      return pump().then(finish);
    },
  };
}

function relayStream(upstreamRes, clientRes, options = {}) {
  return createRelay(upstreamRes, clientRes).relay(upstreamRes, options);
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

module.exports = { parseSseText, relayStream, createRelay, accumulateNonStream, sanitizeDelta, sanitizeChunkEvent, normalizeUsage };

