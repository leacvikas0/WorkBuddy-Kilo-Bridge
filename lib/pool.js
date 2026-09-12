const fs = require('fs');
const path = require('path');
const { readAuth } = require('./auth');

const DEFAULT_AUTH_PATH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
  : (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
      : 'C:\\Users\\silen\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info');

function isQuotaExhausted(status, bodyText = '') {
  if (status === 429) return true;
  if (bodyText) {
    if (bodyText.includes('"code":6004') || bodyText.includes('"code": 6004')) return true;
    if (/frequency\s+limit/i.test(bodyText)) return true;
    if (/usage\s+exceeds/i.test(bodyText)) return true;
    if (/quota\s+(exceeded|exhausted|limit)/i.test(bodyText)) return true;
  }
  return false;
}

class AccountPool {
  constructor(options = {}) {
    this.accountsDir = options.accountsDir || path.join(__dirname, '..', 'accounts');
    this.activePointerFile = path.join(this.accountsDir, 'active.json');
    this.defaultAuthPath = options.defaultAuthPath || (process.env.WB_AUTH_PATH || DEFAULT_AUTH_PATH);
    this.accounts = [];
    this.currentIndex = 0;
    this.reload();
  }

  reload() {
    this.accounts = [];
    this._lastEnvAuth = process.env.WB_AUTH_PATH || '';

    // 1. If explicit WB_AUTH_PATH is set (e.g. during unit tests), prioritize that single file
    if (process.env.WB_AUTH_PATH && fs.existsSync(process.env.WB_AUTH_PATH)) {
      try {
        const auth = readAuth(process.env.WB_AUTH_PATH);
        this.accounts.push({
          name: 'env-account',
          filePath: process.env.WB_AUTH_PATH,
          auth
        });
      } catch {}
      this.currentIndex = 0;
      return;
    }

    // 2. Scan accounts directory
    if (fs.existsSync(this.accountsDir)) {
      let files = [];
      try {
        files = fs.readdirSync(this.accountsDir)
          .filter(f => f.endsWith('.json') && f !== 'active.json')
          .sort();
      } catch {}

      for (const f of files) {
        const fp = path.join(this.accountsDir, f);
        try {
          const auth = readAuth(fp);
          let rawName = f.replace(/\.json$/, '');
          try {
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            rawName = raw.name || raw.account?.email || raw.account?.name || rawName;
          } catch {}

          this.accounts.push({
            name: rawName,
            filePath: fp,
            auth
          });
        } catch (err) {
          // invalid json or missing token, skip
        }
      }
    }

    // 3. Fallback to default auth file if accountsDir is empty
    if (this.accounts.length === 0 && fs.existsSync(this.defaultAuthPath)) {
      try {
        const auth = readAuth(this.defaultAuthPath);
        this.accounts.push({
          name: 'desktop-default',
          filePath: this.defaultAuthPath,
          auth
        });
      } catch {}
    }

    // 4. Load persisted active index
    if (fs.existsSync(this.activePointerFile)) {
      try {
        const activeData = JSON.parse(fs.readFileSync(this.activePointerFile, 'utf8'));
        if (typeof activeData.activeIndex === 'number' && activeData.activeIndex >= 0 && activeData.activeIndex < this.accounts.length) {
          this.currentIndex = activeData.activeIndex;
        } else if (activeData.activeKey) {
          const idx = this.accounts.findIndex(a => a.name === activeData.activeKey);
          if (idx !== -1) this.currentIndex = idx;
        }
      } catch {}
    }

    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = 0;
    }
  }

  getCount() {
    if (process.env.WB_AUTH_PATH !== undefined && process.env.WB_AUTH_PATH !== this._lastEnvAuth) {
      this.reload();
    }
    return this.accounts.length;
  }

  getActiveAccount() {
    if (process.env.WB_AUTH_PATH !== undefined && process.env.WB_AUTH_PATH !== this._lastEnvAuth) {
      this.reload();
    }
    if (this.accounts.length === 0) {
      this.reload();
      if (this.accounts.length === 0) {
        throw Object.assign(new Error('WorkBuddy auth file not found or invalid. Re-login to WorkBuddy.'), { statusCode: 500, code: 'auth_missing' });
      }
    }

    const current = this.accounts[this.currentIndex];
    // Re-check disk file in case token was updated or refreshed externally
    try {
      if (current && current.filePath && fs.existsSync(current.filePath)) {
        current.auth = readAuth(current.filePath);
      }
    } catch {}

    return current;
  }

  rotateNext(reason = '') {
    if (this.accounts.length <= 1) {
      return this.getActiveAccount();
    }
    const prevAccount = this.accounts[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.accounts.length;
    const nextAccount = this.accounts[this.currentIndex];

    console.warn(`[workbuddy-bridge] Account switch: [${prevAccount?.name}] -> [${nextAccount?.name}] (Account ${this.currentIndex + 1}/${this.accounts.length}) ${reason ? `[Reason: ${reason}]` : ''}`);

    try {
      if (!fs.existsSync(this.accountsDir)) fs.mkdirSync(this.accountsDir, { recursive: true });
      fs.writeFileSync(this.activePointerFile, JSON.stringify({
        activeIndex: this.currentIndex,
        activeKey: nextAccount?.name,
        rotatedAt: new Date().toISOString(),
        reason
      }, null, 2), 'utf8');
    } catch {}

    return nextAccount;
  }

  updateAccountToken(account, newToken) {
    if (!account) return;
    account.auth.token = newToken;
    if (account.filePath && fs.existsSync(account.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(account.filePath, 'utf8'));
        if (!raw.auth) raw.auth = {};
        raw.auth.accessToken = newToken;
        raw.updatedAt = new Date().toISOString();
        fs.writeFileSync(account.filePath, JSON.stringify(raw, null, 2), 'utf8');
      } catch (err) {
        console.error(`[workbuddy-bridge] Failed to persist refreshed token for ${account.name}:`, err.message);
      }
    }
  }
}

let _poolInstance = null;
function getAccountPool(options) {
  if (!_poolInstance || options) {
    _poolInstance = new AccountPool(options);
  }
  return _poolInstance;
}

function resetAccountPool() {
  _poolInstance = null;
}

module.exports = {
  AccountPool,
  getAccountPool,
  resetAccountPool,
  isQuotaExhausted,
  DEFAULT_AUTH_PATH
};
