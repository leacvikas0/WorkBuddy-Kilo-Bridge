const test = require('node:test');
const assert = require('node:assert');
const { requestListener } = require('../server');
function mockReqRes(method, url) {
  const req = { method, url };
  const res = {
    status: 0, chunks: [], ended: false,
    writeHead(s) { this.status = s; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; }
  };
  return { req, res };
}
test('GET /healthz returns ok', () => {
  const { req, res } = mockReqRes('GET', '/healthz');
  requestListener(req, res);
  assert.equal(res.status, 200);
  assert.match(res.chunks.join(''), /"ok":true/);
});
test('GET /v1/models lists hy4-preview', () => {
  const { req, res } = mockReqRes('GET', '/v1/models');
  requestListener(req, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.chunks.join(''));
  assert.equal(body.object, 'list');
  assert.ok(body.data.some((m) => m.id === 'hy4-preview'));
  assert.ok(body.data.some((m) => m.id === 'deepseek-v4.1-flash'));
});
test('unknown route returns 404', () => {
  const { req, res } = mockReqRes('GET', '/nope');
  requestListener(req, res);
  assert.equal(res.status, 404);
});
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleChat } = require('../server');
const CHAT_SSE = [
  'data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"hy4-preview","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":72,"completion_tokens":2,"total_tokens":74}}',
  'data: [DONE]'
].join('\n\n');
test('POST chat non-stream accumulates completion', async () => {
  const fp = path.join(os.tmpdir(), 'wb-chat-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }], stream: false })); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.chunks.join(''));
    assert.equal(body.choices[0].message.content, 'OK');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    fs.unlinkSync(fp);
  }
});
test('POST chat with bad JSON returns 400', async () => {
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn('{nope'); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  await handleChat(req, res);
  assert.equal(res.status, 400);
});

test('POST chat passes normalized max_tokens, tool_choice, and stop to upstream fetch', async () => {
  const fp = path.join(os.tmpdir(), 'wb-chat-norm-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const payload = {
    model: 'hy4-preview',
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 32768,
    tool_choice: { type: 'function', function: { name: 'my_tool' } },
    stop: '<stop>'
  };
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    on(ev, fn) {
      if (ev === 'data') fn(JSON.stringify(payload));
      if (ev === 'end') fn();
      return this;
    },
    destroy() {}
  };
  const res = {
    status: 0,
    chunks: [],
    writeHead(s) { this.status = s; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); }
  };
  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    assert.ok(sentBody);
    assert.equal(sentBody.max_tokens, 131072);
    assert.equal(sentBody.max_completion_tokens, undefined);
    assert.equal(sentBody.tool_choice, 'my_tool');
    assert.deepEqual(sentBody.stop, ['<stop>']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    fs.unlinkSync(fp);
  }
});

test('POST chat accepts bodies larger than 4MB without 413 error', async () => {
  const fp = path.join(os.tmpdir(), 'wb-chat-large-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  
  // Create ~5MB message content
  const largeContent = 'a'.repeat(5 * 1024 * 1024);
  const payload = {
    model: 'hy4-preview',
    messages: [{ role: 'user', content: largeContent }]
  };
  const strPayload = JSON.stringify(payload);
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    on(ev, fn) {
      if (ev === 'data') fn(strPayload);
      if (ev === 'end') fn();
      return this;
    },
    destroy() {}
  };
  const res = {
    status: 0,
    chunks: [],
    writeHead(s) { this.status = s; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); }
  };
  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    fs.unlinkSync(fp);
  }
});

test('POST chat automatically rotates account on 429 quota exhaustion', async () => {
  const tmpAccountsDir = path.join(os.tmpdir(), 'wb-srv-pool-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(tmpAccountsDir, { recursive: true });

  const acc1 = { name: 'acc1', account: { uid: 'u1' }, auth: { accessToken: 'tok-1', refreshToken: 'r1', domain: 'www.workbuddy.ai' } };
  const acc2 = { name: 'acc2', account: { uid: 'u2' }, auth: { accessToken: 'tok-2', refreshToken: 'r2', domain: 'www.workbuddy.ai' } };
  fs.writeFileSync(path.join(tmpAccountsDir, 'account_1.json'), JSON.stringify(acc1));
  fs.writeFileSync(path.join(tmpAccountsDir, 'account_2.json'), JSON.stringify(acc2));

  const { resetAccountPool, getAccountPool } = require('../lib/pool');
  resetAccountPool();
  getAccountPool({ accountsDir: tmpAccountsDir });

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const authHeader = opts.headers.Authorization;
    calls.push(authHeader);
    if (authHeader === 'Bearer tok-1') {
      return new Response(JSON.stringify({ code: 6004, msg: 'usage exceeds frequency limit' }), { status: 429 });
    }
    return new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const payload = {
    model: 'hy4-preview',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false
  };
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    on(ev, fn) {
      if (ev === 'data') fn(JSON.stringify(payload));
      if (ev === 'end') fn();
      return this;
    },
    destroy() {}
  };
  const res = {
    status: 0,
    chunks: [],
    writeHead(s) { this.status = s; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); }
  };

  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['Bearer tok-1', 'Bearer tok-2']);
    const body = JSON.parse(res.chunks.join(''));
    assert.equal(body.choices[0].message.content, 'OK');
  } finally {
    globalThis.fetch = realFetch;
    resetAccountPool();
    fs.rmSync(tmpAccountsDir, { recursive: true, force: true });
  }
});

test('POST chat automatically rotates account on 6004 frequency limit with non-429 status', async () => {
  const tmpAccountsDir = path.join(os.tmpdir(), 'wb-srv-pool2-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(tmpAccountsDir, { recursive: true });

  const acc1 = { name: 'acc1', account: { uid: 'u1' }, auth: { accessToken: 'tok-1', refreshToken: 'r1', domain: 'www.workbuddy.ai' } };
  const acc2 = { name: 'acc2', account: { uid: 'u2' }, auth: { accessToken: 'tok-2', refreshToken: 'r2', domain: 'www.workbuddy.ai' } };
  fs.writeFileSync(path.join(tmpAccountsDir, 'account_1.json'), JSON.stringify(acc1));
  fs.writeFileSync(path.join(tmpAccountsDir, 'account_2.json'), JSON.stringify(acc2));

  const { resetAccountPool, getAccountPool } = require('../lib/pool');
  resetAccountPool();
  getAccountPool({ accountsDir: tmpAccountsDir });

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const authHeader = opts.headers.Authorization;
    calls.push(authHeader);
    if (authHeader === 'Bearer tok-1') {
      return new Response(JSON.stringify({ code: 6004, msg: 'frequency limit reached' }), { status: 400 });
    }
    return new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const payload = {
    model: 'hy4-preview',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false
  };
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    on(ev, fn) {
      if (ev === 'data') fn(JSON.stringify(payload));
      if (ev === 'end') fn();
      return this;
    },
    destroy() {}
  };
  const res = {
    status: 0,
    chunks: [],
    writeHead(s) { this.status = s; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); }
  };

  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['Bearer tok-1', 'Bearer tok-2']);
  } finally {
    globalThis.fetch = realFetch;
    resetAccountPool();
    fs.rmSync(tmpAccountsDir, { recursive: true, force: true });
  }
});


test('POST chat streaming cuts a looping stream and omits [DONE]', async () => {
  const fp = path.join(os.tmpdir(), 'wb-loop-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';
  // server.js reads config at require time, so reload it with the env in place.
  delete require.cache[require.resolve('../server')];
  const { handleChat: guardedHandleChat } = require('../server');

  const cycle = ['Let', 'me', 'write.', 'OK.'];
  const events = ['data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'];
  for (let i = 0; i < 8 * cycle.length; i++) {
    events.push('data: ' + JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: cycle[i % cycle.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: [DONE]');
  const LOOP_SSE = events.join('\n\n');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(LOOP_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  try {
    await guardedHandleChat(req, res);
    assert.equal(res.status, 200);
    const body = res.chunks.join('');
    assert.equal(body.includes('[DONE]'), false, 'looping stream must not complete with [DONE]');
    assert.ok(body.includes('reasoning_content'), 'the good prefix should still be relayed');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    delete process.env.WB_LOOP_MIN_REPEATS;
    delete process.env.WB_LOOP_CHECK_EVERY_WORDS;
    delete require.cache[require.resolve('../server')];
    fs.unlinkSync(fp);
  }
});

test('POST chat streaming still completes normally for non-looping output', async () => {
  const fp = path.join(os.tmpdir(), 'wb-noloop-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.chunks.join('').includes('[DONE]'), 'normal stream must still end with [DONE]');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    fs.unlinkSync(fp);
  }
});

// --- Loop guard auto-recovery ---

const RETRY_CYCLE = ['Let', 'me', 'write.', 'OK.'];

function makeLoopSse(cycle, repeats, id) {
  const events = ['data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })];
  for (let i = 0; i < repeats * cycle.length; i++) {
    events.push('data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: cycle[i % cycle.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: [DONE]');
  return events.join('\n\n');
}

function retryReq(payload) {
  return { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify(payload)); if (ev === 'end') fn(); return this; }, destroy() {} };
}

function retryRes() {
  return {
    status: 0, chunks: [], headCalls: 0, ended: false,
    writeHead(s) { this.status = s; this.headCalls++; },
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; },
  };
}

function setRetryEnv(fp, extra) {
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';
  for (const [k, v] of Object.entries(extra || {})) process.env[k] = v;
  delete require.cache[require.resolve('../server')];
  return require('../server');
}

function clearRetryEnv(fp, extra) {
  delete process.env.WB_AUTH_PATH;
  delete process.env.WB_LOOP_MIN_REPEATS;
  delete process.env.WB_LOOP_CHECK_EVERY_WORDS;
  for (const k of Object.keys(extra || {})) delete process.env[k];
  delete require.cache[require.resolve('../server')];
  try { fs.unlinkSync(fp); } catch {}
}

test('POST chat streaming retries after a loop and finishes the turn with [DONE]', async () => {
  const fp = path.join(os.tmpdir(), 'wb-loop-retry-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  const { handleChat: guardedHandleChat } = setRetryEnv(fp, {});

  const LOOP_SSE = makeLoopSse(RETRY_CYCLE, 8, 'c1');
  const GOOD_SSE = [
    'data: {"id":"c2","object":"chat.completion.chunk","created":2,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"final answer"},"finish_reason":"stop"}]}',
    'data: [DONE]'
  ].join('\n\n');

  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return new Response(bodies.length === 1 ? LOOP_SSE : GOOD_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const req = retryReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const res = retryRes();
  try {
    await guardedHandleChat(req, res);
    const body = res.chunks.join('');
    assert.equal(bodies.length, 2, 'bridge must retry once after the loop');
    assert.ok(body.includes('[DONE]'), 'continued turn must complete normally');
    assert.ok(body.includes('final answer'));
    assert.equal(res.headCalls, 1, 'headers must be written exactly once');
    assert.equal(body.includes('"id":"c2"'), false, 'retry chunks must keep the first attempt stream id');
    const cont = bodies[1].messages;
    assert.equal(cont.length, bodies[0].messages.length + 1);
    assert.equal(cont[cont.length - 1].role, 'user');
    assert.match(cont[cont.length - 1].content, /repeat/i);
  } finally {
    globalThis.fetch = realFetch;
    clearRetryEnv(fp, {});
  }
});

test('POST chat streaming gives up after the retry cap and omits [DONE]', async () => {
  const fp = path.join(os.tmpdir(), 'wb-loop-cap-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  const extra = { WB_LOOP_MAX_RETRIES: '1' };
  const { handleChat: guardedHandleChat } = setRetryEnv(fp, extra);

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(makeLoopSse(RETRY_CYCLE, 8, 'c1'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
  const req = retryReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const res = retryRes();
  try {
    await guardedHandleChat(req, res);
    assert.equal(calls, 2, 'one initial attempt plus one retry');
    assert.equal(res.chunks.join('').includes('[DONE]'), false, 'giving up must omit [DONE]');
    assert.equal(res.ended, true, 'giving up must end the response');
  } finally {
    globalThis.fetch = realFetch;
    clearRetryEnv(fp, extra);
  }
});

test('POST chat streaming does not retry once tool calls have been forwarded', async () => {
  const fp = path.join(os.tmpdir(), 'wb-loop-tools-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  const { handleChat: guardedHandleChat } = setRetryEnv(fp, {});

  const events = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'calc', arguments: '{"a":1}' } }] }, finish_reason: null }] }),
  ];
  for (let i = 0; i < 8 * RETRY_CYCLE.length; i++) {
    events.push('data: ' + JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: RETRY_CYCLE[i % RETRY_CYCLE.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: [DONE]');
  const TOOL_LOOP_SSE = events.join('\n\n');

  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(TOOL_LOOP_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
  const req = retryReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const res = retryRes();
  try {
    await guardedHandleChat(req, res);
    assert.equal(calls, 1, 'must not retry when tool calls already streamed');
    const body = res.chunks.join('');
    assert.ok(body.includes('tool_calls'), 'the tool call must still be relayed');
    assert.equal(body.includes('[DONE]'), false);
  } finally {
    globalThis.fetch = realFetch;
    clearRetryEnv(fp, {});
  }
});
