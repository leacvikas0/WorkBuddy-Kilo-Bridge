const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountPool, isQuotaExhausted } = require('../lib/pool');

function createMockAccountsDir() {
  const tmpDir = path.join(os.tmpdir(), 'wb-pool-test-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });

  const acc1 = {
    name: 'user1@test.com',
    account: { uid: 'uid-1' },
    auth: { accessToken: 'tok-1', refreshToken: 'ref-1', domain: 'www.workbuddy.ai' }
  };
  const acc2 = {
    name: 'user2@test.com',
    account: { uid: 'uid-2' },
    auth: { accessToken: 'tok-2', refreshToken: 'ref-2', domain: 'www.workbuddy.ai' }
  };

  fs.writeFileSync(path.join(tmpDir, 'account_1.json'), JSON.stringify(acc1));
  fs.writeFileSync(path.join(tmpDir, 'account_2.json'), JSON.stringify(acc2));
  return tmpDir;
}

test('isQuotaExhausted detects 429 and error codes/messages', () => {
  assert.strictEqual(isQuotaExhausted(429), true);
  assert.strictEqual(isQuotaExhausted(200, 'ok'), false);
  assert.strictEqual(isQuotaExhausted(400, '{"code":6004,"msg":"frequency limit"}'), true);
  assert.strictEqual(isQuotaExhausted(403, 'usage exceeds frequency limit'), true);
  assert.strictEqual(isQuotaExhausted(400, 'tool calls and tool results do not match'), false);
});

test('AccountPool loads multiple accounts and cycles correctly', () => {
  const tmpDir = createMockAccountsDir();
  try {
    const pool = new AccountPool({ accountsDir: tmpDir });
    assert.strictEqual(pool.getCount(), 2);

    const first = pool.getActiveAccount();
    assert.strictEqual(first.name, 'user1@test.com');
    assert.strictEqual(first.auth.token, 'tok-1');

    const second = pool.rotateNext('test_429');
    assert.strictEqual(second.name, 'user2@test.com');
    assert.strictEqual(second.auth.token, 'tok-2');

    // Cycle back to first
    const cycled = pool.rotateNext('test_429_again');
    assert.strictEqual(cycled.name, 'user1@test.com');
    assert.strictEqual(cycled.auth.token, 'tok-1');

    // Check active.json was saved
    const activeFile = path.join(tmpDir, 'active.json');
    assert.ok(fs.existsSync(activeFile));
    const activeData = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    assert.strictEqual(activeData.activeIndex, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AccountPool updates account token on disk', () => {
  const tmpDir = createMockAccountsDir();
  try {
    const pool = new AccountPool({ accountsDir: tmpDir });
    const acc = pool.getActiveAccount();
    pool.updateAccountToken(acc, 'new-refreshed-tok');

    assert.strictEqual(acc.auth.token, 'new-refreshed-tok');
    const onDisk = JSON.parse(fs.readFileSync(acc.filePath, 'utf8'));
    assert.strictEqual(onDisk.auth.accessToken, 'new-refreshed-tok');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
