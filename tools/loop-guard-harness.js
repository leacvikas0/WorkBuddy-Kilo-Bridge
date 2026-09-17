#!/usr/bin/env node
'use strict';
// Manual verification: drives the bridge over real HTTP with a stubbed
// upstream, and reports how the stream terminates in both loop scenarios.
//
//   node tools/loop-guard-harness.js
//
// Scenario A: the model loops once, then the continuation succeeds.
//             Expect: one response head, good text, final [DONE].
// Scenario B: the model loops on every attempt.
//             Expect: retry cap respected, stream cut without [DONE].
//
// Exits 0 if both scenarios behave; 1 otherwise.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CYCLE = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];

function loopSse(id) {
  const events = ['data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })];
  for (let i = 0; i < 8 * CYCLE.length; i++) {
    events.push('data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: CYCLE[i % CYCLE.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: [DONE]');
  return events.join('\n\n');
}

function goodSse(id) {
  return [
    'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 2, model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { content: 'done working' }, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ].join('\n\n');
}

async function runScenario({ name, responses, expectDone, expectCalls }) {
  const fp = path.join(os.tmpdir(), 'wb-harness-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';

  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const sse = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  delete require.cache[require.resolve('../server')];
  const { requestListener } = require('../server');
  const server = http.createServer(requestListener);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const body = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });

  const result = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('aborted', () => resolve({ status: res.statusCode, text, aborted: true }));
      res.on('error', (e) => resolve({ status: res.statusCode, text, aborted: true, error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, text: '', aborted: true, error: e.message }));
    req.write(body);
    req.end();
  });

  await new Promise((r) => server.close(r));
  fs.unlinkSync(fp);
  delete require.cache[require.resolve('../server')];

  const hasDone = result.text.includes('[DONE]');
  console.log(`--- ${name}`);
  console.log(`    upstream calls=${calls} status=${result.status} bytes=${result.text.length} [DONE]=${hasDone}`);

  if (expectCalls != null && calls !== expectCalls) {
    console.error(`FAIL: expected ${expectCalls} upstream calls, got ${calls}`);
    return false;
  }
  if (hasDone !== expectDone) {
    console.error(`FAIL: expected [DONE]=${expectDone}, got ${hasDone}`);
    return false;
  }
  if (expectDone && !result.text.includes('done working')) {
    console.error('FAIL: continued answer missing from the client stream');
    return false;
  }
  if (!expectDone && result.text.includes('done working')) {
    console.error('FAIL: impossible content in the give-up scenario');
    return false;
  }
  const continuation = bodies[1] && bodies[1].messages[bodies[1].messages.length - 1];
  if (expectDone) {
    if (!continuation || continuation.role !== 'user' || !/repeat/i.test(String(continuation.content))) {
      console.error('FAIL: continuation request did not carry the anti-repeat instruction');
      return false;
    }
    console.log('    continuation message present in retry request');
  }
  console.log('    PASS');
  return true;
}

async function main() {
  const a = await runScenario({
    name: 'A: loop then recovery',
    responses: [loopSse('c1'), goodSse('c2')],
    expectDone: true,
    expectCalls: 2,
  });
  const b = await runScenario({
    name: 'B: permanent loop hits retry cap',
    responses: [loopSse('c1')],
    expectDone: false,
    expectCalls: 3,
  });
  if (a && b) {
    console.log('PASS: loop recovery verified end to end');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((e) => { console.error('harness error: ' + e.message); process.exit(1); });
