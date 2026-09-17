const test = require('node:test');
const assert = require('node:assert');
const { parseSseText, accumulateNonStream, sanitizeDelta, sanitizeChunkEvent, relayStream } = require('../lib/translate');
const SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"reasoning_content":"think","content":""},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"content":"O","tool_calls":[{"id":"t1","type":"function","function":{"name":"calc","arguments":""},"index":0}]},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"content":"K","tool_calls":[{"function":{"arguments":"{}"},"index":0}]},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":72,"completion_tokens":5,"total_tokens":77}}',
  'data: [DONE]'
].join('\n\n');
test('parseSseText extracts events and DONE', () => {
  const { events, done } = parseSseText(SSE);
  assert.equal(done, true);
  assert.equal(events.length, 5);
});
test('accumulateNonStream merges content, tools, usage', async () => {
  const up = new Response(SSE, { status: 200 });
  const out = await accumulateNonStream(up, 'hy4-preview');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'OK');
  assert.equal(out.choices[0].message.reasoning_content, 'think');
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'calc');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{}');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.usage.total_tokens, 77);
});

const RSSE = [
  'data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"","function_call":{"name":"","arguments":""},"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}',
  'data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"skill","function_call":{"name":"","arguments":""},"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}',
  'data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":" first","function_call":{"name":"","arguments":""},"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}',
  'data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi!","reasoning_content":"","function_call":{"name":"","arguments":""},"refusal":"","tool_calls":[],"extra_fields":null},"finish_reason":null}]}',
  'data: {"id":"c2","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":72,"completion_tokens":5,"total_tokens":77}}',
  'data: [DONE]'
].join('\n\n');

test('sanitizeDelta strips empty noise keys, keeps populated and unknown keys', () => {
  const out = sanitizeDelta({ role: 'assistant', content: '', reasoning_content: 'hi', tool_calls: [], function_call: null, refusal: '', extra_fields: null, custom: 1 });
  assert.deepEqual(out, { role: 'assistant', reasoning_content: 'hi', custom: 1 });
});

test('sanitizeDelta preserves real tool calls and content', () => {
  const tc = [{ id: 't1', type: 'function', function: { name: 'calc', arguments: '{}' }, index: 0 }];
  const out = sanitizeDelta({ content: 'OK', tool_calls: tc });
  assert.deepEqual(out, { content: 'OK', tool_calls: tc });
});

test('sanitizeChunkEvent preserves id, usage, finish_reason and normalizes empty finish_reason', () => {
  const ev = { id: 'c2', choices: [{ index: 0, delta: { content: '', reasoning_content: 'x' }, finish_reason: 'stop' }], usage: { total_tokens: 77 } };
  const out = sanitizeChunkEvent(ev);
  assert.equal(out.id, 'c2');
  assert.equal(out.usage.total_tokens, 77);
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.deepEqual(out.choices[0].delta, { reasoning_content: 'x' });

  // Empty string finish_reason converted to null
  const evEmpty = { id: 'c3', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: '' }] };
  const outEmpty = sanitizeChunkEvent(evEmpty);
  assert.strictEqual(outEmpty.choices[0].finish_reason, null);
});

test('relayStream sanitizes split-byte chunks without buffering the turn', async () => {
  const bytes = Buffer.from(RSSE, 'utf8');
  const slices = [];
  for (let i = 0; i < bytes.length; i += 7) slices.push(bytes.subarray(i, Math.min(i + 7, bytes.length)));
  let si = 0;
  const up = {
    body: {
      getReader() {
        return {
          read() {
            if (si >= slices.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: slices[si++] });
          }
        };
      }
    }
  };
  const writes = [];
  const clientRes = {
    writeHead() {},
    write(c) { writes.push(String(c)); },
    end(c) { if (c !== undefined) writes.push(String(c)); }
  };
  await relayStream(up, clientRes);
  const body = writes.join('');
  assert.match(body, /data: \[DONE\]/);
  const { events } = parseSseText(body);
  assert.equal(events.length, 5);
  const r1 = events[1].choices[0].delta;
  assert.deepEqual(r1, { role: 'assistant', reasoning_content: 'skill' });
  const r2 = events[2].choices[0].delta;
  assert.deepEqual(r2, { role: 'assistant', reasoning_content: ' first' });
  const c = events[3].choices[0].delta;
  assert.deepEqual(c, { role: 'assistant', content: 'Hi!' });
  assert.equal(events[4].usage.total_tokens, 77);
});

test('normalizeUsage maps prompt_cache_hit_tokens to prompt_tokens_details.cached_tokens', () => {
  const { normalizeUsage } = require('../lib/translate');
  const u1 = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    prompt_cache_hit_tokens: 850,
    prompt_cache_miss_tokens: 150
  };
  const res1 = normalizeUsage(u1);
  assert.equal(res1.prompt_tokens_details.cached_tokens, 850);
  assert.equal(res1.prompt_cache_hit_tokens, 850);

  // Also handles cache_read_input_tokens
  const u2 = {
    prompt_tokens: 1000,
    cache_read_input_tokens: 900
  };
  const res2 = normalizeUsage(u2);
  assert.equal(res2.prompt_tokens_details.cached_tokens, 900);
  assert.equal(res2.prompt_cache_hit_tokens, 900);

  // Respects existing prompt_tokens_details
  const u3 = {
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 500 }
  };
  const res3 = normalizeUsage(u3);
  assert.equal(res3.prompt_cache_hit_tokens, 500);
});


const { createStreamGuard } = require('../lib/loop-detector');

const CYCLE = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];

function loopSse() {
  const events = [];
  events.push('data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}');
  for (let i = 0; i < 8 * CYCLE.length; i++) {
    const tok = CYCLE[i % CYCLE.length];
    events.push('data: ' + JSON.stringify({
      id: 'c9', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: tok + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
  events.push('data: [DONE]');
  return events.join('\n\n');
}

function sseUpstream(text) {
  const bytes = Buffer.from(text, 'utf8');
  let sent = false;
  return {
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  };
}

function captureRes() {
  const writes = [];
  let ended = false;
  let headCalls = 0;
  return {
    writeHead() { headCalls++; },
    write(c) { writes.push(String(c)); },
    end(c) { if (c !== undefined) writes.push(String(c)); ended = true; },
    get writes() { return writes; },
    get ended() { return ended; },
    get headCalls() { return headCalls; },
  };
}

test('relayStream cuts the stream and omits [DONE] when a loop is detected', async () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const hits = [];
  const res = captureRes();
  await relayStream(sseUpstream(loopSse()), res, { guard, onLoop: (h) => hits.push(h) });

  const body = res.writes.join('');
  assert.equal(body.includes('[DONE]'), false, 'must not send [DONE] on a loop');
  assert.equal(hits.length, 1, 'onLoop must fire exactly once');
  assert.equal(hits[0].cycleWords, 10);
  assert.equal(hits[0].channel, 'reasoning');
  assert.equal(res.ended, true, 'response must be ended');
});

test('relayStream still ends normally with [DONE] when no guard is passed', async () => {
  const res = captureRes();
  await relayStream(sseUpstream(loopSse()), res);
  assert.equal(res.writes.join('').includes('[DONE]'), true);
});

test('relayStream ends normally when the guard never fires', async () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const res = captureRes();
  await relayStream(sseUpstream(RSSE), res, { guard });
  assert.equal(res.writes.join('').includes('[DONE]'), true);
});

test('relayStream with holdOnLoop returns the loop result and keeps the response open', async () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 1 });
  const res = captureRes();
  const result = await relayStream(sseUpstream(loopSse()), res, { guard, holdOnLoop: true });
  assert.equal(result.reason, 'loop');
  assert.equal(result.hit.channel, 'reasoning');
  assert.equal(res.ended, false, 'client response must stay open for the continuation');
  assert.equal(res.writes.join('').includes('[DONE]'), false);
  assert.ok(result.partial.reasoning.length > 0, 'forwarded reasoning must be captured');
  assert.equal(result.sawToolCalls, false);
  assert.equal(result.meta.id, 'c9');
});

test('relayStream with resume does not write headers again', async () => {
  const res = captureRes();
  const result = await relayStream(sseUpstream(RSSE), res, { resume: true });
  assert.equal(result.reason, 'done');
  assert.equal(res.headCalls, 0);
  assert.equal(res.writes.join('').includes('[DONE]'), true);
});

test('relayStream reports tool calls that were already forwarded', async () => {
  const res = captureRes();
  const result = await relayStream(sseUpstream(SSE), res, {});
  assert.equal(result.sawToolCalls, true);
  assert.equal(result.reason, 'done');
});

test('relayStream rewrites chunk metadata when meta is supplied', async () => {
  const res = captureRes();
  const result = await relayStream(sseUpstream(RSSE), res, { resume: true, meta: { id: 'first', created: 1, model: 'm0' } });
  assert.equal(result.reason, 'done');
  const { events } = parseSseText(res.writes.join(''));
  assert.equal(events[0].id, 'first');
  assert.equal(events[0].model, 'm0');
  assert.equal(events[events.length - 1].id, 'first');
});
