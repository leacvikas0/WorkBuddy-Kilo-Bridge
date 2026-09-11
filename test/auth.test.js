const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAuth, buildUpstreamHeaders, tryRefresh } = require('../lib/auth');
function writeFixture(obj) {
  const fp = path.join(os.tmpdir(), 'wb-auth-test-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify(obj));
  return fp;
}
const FIXTURE = {
  account: { uid: 'uid-123' },
  auth: { accessToken: 'tok-abc', refreshToken: 'ref-xyz', domain: 'www.workbuddy.ai', tokenType: 'Bearer' }
};
test('readAuth parses token fields', () => {
  const fp = writeFixture(FIXTURE);
  try {
    const a = readAuth(fp);
    assert.equal(a.token, 'tok-abc');
    assert.equal(a.uid, 'uid-123');
    assert.equal(a.domain, 'www.workbuddy.ai');
    assert.equal(a.refreshToken, 'ref-xyz');
  } finally { fs.unlinkSync(fp); }
});
test('readAuth throws 500 without token', () => {
  const fp = writeFixture({ account: { uid: 'u' }, auth: {} });
  try {
    assert.throws(() => readAuth(fp), (e) => e.statusCode === 500);
  } finally { fs.unlinkSync(fp); }
});
test('buildUpstreamHeaders sets auth headers', () => {
  const h = buildUpstreamHeaders({ token: 'tok-abc', uid: 'uid-123', domain: 'www.workbuddy.ai' });
  assert.equal(h.Authorization, 'Bearer tok-abc');
  assert.equal(h['X-User-Id'], 'uid-123');
  assert.equal(h['X-Domain'], 'www.workbuddy.ai');
  assert.equal(h['Content-Type'], 'application/json');
});
test('tryRefresh returns refreshed auth on success', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { accessToken: 'tok-new' } }), { status: 200 });
  try {
    const out = await tryRefresh({ token: 'old', refreshToken: 'r', uid: 'u', domain: 'd' });
    assert.equal(out.token, 'tok-new');
    assert.equal(out.uid, 'u');
  } finally { globalThis.fetch = realFetch; }
});
test('tryRefresh returns null on failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 401 });
  try {
    assert.equal(await tryRefresh({ token: 'o', refreshToken: 'r', uid: 'u', domain: 'd' }), null);
  } finally { globalThis.fetch = realFetch; }
});
