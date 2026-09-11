const fs = require('fs');
const REFRESH_URL = 'https://www.workbuddy.ai/v2/auth/token/refresh';

function readAuth(authPath) {
  let j;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = fs.readFileSync(authPath, 'utf8');
      if (content && content.trim()) {
        j = JSON.parse(content);
        break;
      }
    } catch (err) {
      lastErr = err;
    }
    // Brief synchronous backoff for Windows file contention
    if (attempt < 2) {
      const end = Date.now() + 50;
      while (Date.now() < end) { /* wait */ }
    }
  }
  if (!j) {
    throw Object.assign(new Error('WorkBuddy auth file not found or invalid. Re-login to WorkBuddy.'), { statusCode: 500, code: 'auth_missing', cause: lastErr });
  }
  const token = j?.auth?.accessToken;
  const uid = j?.account?.uid;
  if (!token || !uid) {
    throw Object.assign(new Error('WorkBuddy auth file not found or invalid. Re-login to WorkBuddy.'), { statusCode: 500, code: 'auth_missing' });
  }
  return {
    token,
    uid,
    domain: j.auth.domain || 'www.workbuddy.ai',
    refreshToken: j.auth.refreshToken || ''
  };
}

function buildUpstreamHeaders(auth) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': 'Bearer ' + auth.token,
    'X-User-Id': auth.uid,
    'X-Domain': auth.domain,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'WorkBuddy-Bridge/1.0'
  };
}

async function tryRefresh(auth) {
  if (!auth.refreshToken) return null;
  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Refresh-Token': auth.refreshToken,
      'X-Auth-Refresh-Source': 'plugin'
    },
    body: JSON.stringify({ refreshToken: auth.refreshToken })
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  const token = j?.data?.accessToken || j?.accessToken;
  return token ? { ...auth, token } : null;
}

module.exports = { readAuth, buildUpstreamHeaders, tryRefresh, REFRESH_URL };
