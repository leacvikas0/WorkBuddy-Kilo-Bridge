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
    assert.equal(sentBody.max_tokens, 32768);
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
