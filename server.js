const http = require('http');
const fs = require('fs');
const path = require('path');
const bridgeDir = __dirname;
const { listModels } = require('./lib/models');
const { readAuth, buildUpstreamHeaders, tryRefresh } = require('./lib/auth');
const { buildUpstreamBody } = require('./lib/normalize');
const { optimizeMessageImages } = require('./lib/images');
const { relayStream, accumulateNonStream } = require('./lib/translate');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4121);
const UPSTREAM = 'https://www.workbuddy.ai/v2/chat/completions';
const DEFAULT_AUTH_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
  : (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
      : 'C:\\Users\\silen\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info');
const authPath = () => process.env.WB_AUTH_PATH || DEFAULT_AUTH_PATH;
const MAX_BODY_BYTES = 512 * 1024 * 1024; // 512MB to support large multi-image agentic payloads

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function postUpstream(auth, upBody, signal) {
  return fetch(UPSTREAM, {
    method: 'POST',
    headers: buildUpstreamHeaders(auth),
    body: JSON.stringify(upBody),
    signal
  });
}

// Guard against unhandled client disconnects and fetch stream aborts
process.on('uncaughtException', (err) => {
  if (err?.name === 'AbortError' || err?.code === 'ECONNRESET' || err?.code === 'EPIPE' || err?.message?.includes?.('aborted')) {
    return;
  }
  console.error('[workbuddy-bridge] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ECONNRESET' || reason?.code === 'EPIPE' || reason?.message?.includes?.('aborted')) {
    return;
  }
  console.error('[workbuddy-bridge] Unhandled rejection:', reason);
});

function upstreamError(status, text) {
  let code = 'upstream_error';
  let message = 'upstream error';
  try {
    const j = JSON.parse(text);
    if (j.code !== undefined) code = j.code;
    message = j.msg || j.message || message;
  } catch {}
  return { status, body: { error: { message: String(message), code } } };
}

async function handleChat(req, res) {
  const ac = new AbortController();
  if (typeof res.on === 'function') {
    res.on('close', () => {
      if (!res.headersSent && !res.writableEnded) {
        try { ac.abort(); } catch {}
      }
    });
  }

  let raw;
  try { raw = await readBody(req); }
  catch (e) { return sendJson(res, e.statusCode || 400, { error: { message: e.message, code: 'bad_request' } }); }

  let inBody;
  try { inBody = JSON.parse(raw); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body', code: 'bad_request' } }); }

  try {
    if (Array.isArray(inBody.messages)) {
      inBody.messages = await optimizeMessageImages(inBody.messages);
    }
  } catch (imgErr) {
    console.error('[workbuddy-bridge] image optimization warning:', imgErr);
  }

  let upBody;
  try { upBody = buildUpstreamBody(inBody); }
  catch (e) { return sendJson(res, e.statusCode || 400, { error: { message: e.message, code: e.code || 'bad_request' } }); }

  console.log(`[workbuddy-bridge] Chat request: model=${upBody.model}, inMaxTokens=${inBody.max_tokens ?? inBody.max_completion_tokens}, upMaxTokens=${upBody.max_tokens}, upBudget=${upBody.budget_tokens ?? upBody.thinking?.budgetTokens ?? 'none'}`);

  let auth;
  try { auth = readAuth(authPath()); }
  catch (e) { return sendJson(res, 500, { error: { message: 'WorkBuddy auth file not found or invalid. Re-login to WorkBuddy.', code: 'auth_missing' } }); }

  const wantStream = inBody.stream !== false;
  let upRes;
  try { upRes = await postUpstream(auth, upBody, ac.signal); }
  catch (e) {
    if (ac.signal.aborted) return;
    return sendJson(res, 502, { error: { message: 'upstream unreachable', code: 'upstream_error' } });
  }

  // If 401, first try re-reading auth file from disk (desktop app might have rotated credentials)
  if (upRes.status === 401) {
    let reloaded;
    try { reloaded = readAuth(authPath()); } catch {}
    if (reloaded && reloaded.token !== auth.token) {
      auth = reloaded;
      try { upRes = await postUpstream(auth, upBody, ac.signal); }
      catch (e) {
        if (ac.signal.aborted) return;
        return sendJson(res, 502, { error: { message: 'upstream unreachable', code: 'upstream_error' } });
      }
    }
  }

  // If still 401, try active refresh using refreshToken
  if (upRes.status === 401 && auth.refreshToken) {
    const refreshed = await tryRefresh(auth).catch(() => null);
    if (refreshed) {
      auth = refreshed;
      try { upRes = await postUpstream(auth, upBody, ac.signal); }
      catch (e) {
        if (ac.signal.aborted) return;
        return sendJson(res, 502, { error: { message: 'upstream unreachable', code: 'upstream_error' } });
      }
    }
  }

  if (upRes.status === 401) {
    return sendJson(res, 401, { error: { message: 'WorkBuddy session expired. Re-login to WorkBuddy.', code: 'auth_expired' } });
  }

  if (!upRes.ok) {
    const text = await upRes.text().catch(() => '');
    console.error('[workbuddy-bridge] Upstream error: HTTP ' + upRes.status + ' -> ' + text.slice(0, 300));
    try {
      const fs = require('fs');
      fs.writeFileSync(path.join(bridgeDir, 'failed-request.json'), JSON.stringify(upBody, null, 2));
    } catch {}
    const mapped = upstreamError(upRes.status, text);
    return sendJson(res, mapped.status, mapped.body);
  }

  if (wantStream) return relayStream(upRes, res);

  try {
    const completion = await accumulateNonStream(upRes, upBody.model);
    return sendJson(res, 200, completion);
  } catch {
    return sendJson(res, 502, { error: { message: 'failed reading upstream stream', code: 'upstream_error' } });
  }
}

function requestListener(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/v1/models') return sendJson(res, 200, listModels());
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    handleChat(req, res).catch(() => { try { sendJson(res, 500, { error: { message: 'internal error', code: 'internal' } }); } catch {} });
    return;
  }
  return sendJson(res, 404, { error: { message: 'not found', code: 'not_found' } });
}

if (require.main === module) {
  const server = http.createServer(requestListener);
  server.keepAliveTimeout = 610000; // 610s: prevents premature socket FIN during Kilo idle periods
  server.headersTimeout = 620000;   // 620s: must strictly exceed keepAliveTimeout
  server.requestTimeout = 0;        // 0: unlimited timeout for lengthy agentic generations
  server.on('error', (e) => { console.error('listen failed (port ' + PORT + ' in use?): ' + e.message); process.exit(1); });
  server.listen(PORT, HOST, () => console.log('workbuddy-bridge on http://' + HOST + ':' + PORT));
}

module.exports = { requestListener, handleChat, sendJson };
