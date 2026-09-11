// Manual only: WB_LIVE=1 node test/live-smoke.js
// Reads the real WorkBuddy login and makes one minimal upstream call.
const { readAuth, buildUpstreamHeaders } = require('../lib/auth');
const { buildUpstreamBody } = require('../lib/normalize');
const UPSTREAM = 'https://www.workbuddy.ai/v2/chat/completions';
const path = require('path');
const DEFAULT_AUTH_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
  : 'C:\\Users\\silen\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info';
(async () => {
  if (process.env.WB_LIVE !== '1') { console.log('set WB_LIVE=1 to run'); process.exit(0); }
  const auth = readAuth(process.env.WB_AUTH_PATH || DEFAULT_AUTH_PATH);
  console.log('auth ok uid=' + auth.uid + ' tokenLen=' + auth.token.length);
  const upBody = buildUpstreamBody({ model: 'hy4-preview', messages: [{ role: 'user', content: 'Say OK in one word' }] });
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: buildUpstreamHeaders(auth),
    body: JSON.stringify(upBody)
  });
  console.log('status=' + res.status);
  if (!res.ok) { console.log((await res.text()).slice(0, 500)); process.exit(1); }
  const text = await res.text();
  if (!text.includes('data: [DONE]')) { console.log('missing DONE marker'); process.exit(1); }
  const usage = text.split('\n').reverse().find((l) => l.includes('"usage"'));
  console.log('stream ok bytes=' + text.length);
  console.log((usage || '').slice(0, 400));
})().catch((e) => { console.error('smoke failed: ' + e.message); process.exit(1); });