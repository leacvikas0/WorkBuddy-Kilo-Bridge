#!/usr/bin/env node
'use strict';
// Manual verification: drives the bridge over real HTTP with a stubbed upstream
// that emits a known loop, and reports how the stream terminates.
//
//   node tools/loop-guard-harness.js
//
// Exits 0 if the guard cut the stream without [DONE]; 1 otherwise.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CYCLE = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];

function loopSse() {
  const events = ['data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'];
  for (let i = 0; i < 8 * CYCLE.length; i++) {
    events.push('data: ' + JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: CYCLE[i % CYCLE.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
  events.push('data: [DONE]');
  return events.join('\n\n');
}

async function main() {
  const fp = path.join(os.tmpdir(), 'wb-harness-auth-' + Date.now() + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = process.env.WB_LOOP_MIN_REPEATS || '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';

  // Stub upstream before server.js loads.
  globalThis.fetch = async () => new Response(loopSse(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  const { requestListener } = require('../server');
  const server = http.createServer(requestListener);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('harness listening on ' + port);

  const body = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });

  const result = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text, aborted: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, text, aborted: true }));
      res.on('error', (e) => resolve({ status: res.statusCode, text, aborted: true, error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, text: '', aborted: true, error: e.message }));
    req.write(body);
    req.end();
  });

  await new Promise((r) => server.close(r));
  fs.unlinkSync(fp);

  const hasDone = result.text.includes('[DONE]');
  const hasContent = result.text.includes('reasoning_content');
  console.log('status=' + result.status + ' aborted=' + result.aborted + ' bytes=' + result.text.length);
  console.log('relayed good prefix=' + hasContent);
  console.log('sent [DONE]=' + hasDone);

  if (hasDone) {
    console.error('FAIL: guard did not cut the stream ([DONE] was sent)');
    process.exit(1);
  }
  console.log('PASS: stream was cut without [DONE]');
  process.exit(0);
}

main().catch((e) => { console.error('harness error: ' + e.message); process.exit(1); });
