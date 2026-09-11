const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const bridgeDir = __dirname;
const serverPath = path.join(bridgeDir, 'server.js');
const logFile = path.join(bridgeDir, 'workbuddy-bridge.log');
const logOldFile = path.join(bridgeDir, 'workbuddy-bridge.log.old');
const PORT = Number(process.env.PORT || 4121);
const MUTEX_PORT = Number(process.env.MUTEX_PORT || 4122);
const HOST = '127.0.0.1';

// Single-instance mutex: prevent dual-supervisor collisions
const mutexServer = net.createServer();
mutexServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    try {
      const line = `[${new Date().toISOString()}] [supervisor] Another supervisor daemon is already running (port ${MUTEX_PORT} occupied). Exiting duplicate instance.\n`;
      fs.appendFileSync(logFile, line);
    } catch {}
    process.exit(0);
  }
});
mutexServer.on('listening', () => {
  log(`[supervisor] Mutex acquired on port ${MUTEX_PORT}. Initializing bridge supervisor...`);
  spawnChild();
  probeTimer = setInterval(checkHealth, PROBE_INTERVAL_MS);
});
mutexServer.listen(MUTEX_PORT, HOST);

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const PROBE_INTERVAL_MS = 15000;      // 15s
const PROBE_TIMEOUT_MS = 10000;       // 10s (was 5s)
const MAX_CONSECUTIVE_PROBE_FAILURES = 3; // Require 3 consecutive failures before restarting child
const CRASH_THRESHOLD_MS = 2000;      // 2s
const CRASH_BACKOFF_MS = 5000;        // 5s
const NORMAL_RESTART_MS = 1000;       // 1s

let child = null;
let childStartTime = 0;
let shuttingDown = false;
let restartTimer = null;
let probeTimer = null;
let isProbing = false;
let isRestarting = false;
let consecutiveProbeFailures = 0;
let lastProbeTime = Date.now();

function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size >= MAX_LOG_SIZE) {
        try {
          if (fs.existsSync(logOldFile)) {
            fs.unlinkSync(logOldFile);
          }
          fs.renameSync(logFile, logOldFile);
        } catch {
          fs.truncateSync(logFile, 0);
        }
      }
    }
  } catch {}
}

function log(msg) {
  rotateLogIfNeeded();
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
  } catch {}
}

function freePort(port) {
  try {
    const stdout = execSync('netstat -ano -p tcp', {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const lines = stdout.split(/\r?\n/);
    const pidsToKill = new Set();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('TCP')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddr = parts[1];
      const state = parts[3];
      const pid = parseInt(parts[4], 10);

      if (localAddr.endsWith(`:${port}`) && (state === 'LISTENING' || state === 'LISTEN')) {
        if (pid > 0 && pid !== process.pid) {
          pidsToKill.add(pid);
        }
      }
    }

    for (const pid of pidsToKill) {
      log(`[supervisor] Killing process ${pid} occupying port ${port}`);
      try {
        execSync(`taskkill /F /T /PID ${pid}`, {
          windowsHide: true,
          stdio: 'ignore'
        });
      } catch (e) {
        log(`[supervisor] taskkill failed for PID ${pid}: ${e.message}`);
      }
    }

    if (pidsToKill.size > 0) {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      } catch {}
    }
  } catch (err) {
    log(`[supervisor] Error during port check: ${err.message}`);
  }
}

function restartChild(reason) {
  if (shuttingDown || isRestarting) return;
  isRestarting = true;
  log(`[supervisor] Triggering restart (reason: ${reason})...`);

  if (!child) {
    isRestarting = false;
    spawnChild();
    return;
  }

  const pidToKill = child.pid;
  try {
    child.kill('SIGTERM');
  } catch {}

  // Fallback 1: Force kill after 2s if child has not exited yet
  const forceKillTimer = setTimeout(() => {
    if (child && child.pid === pidToKill) {
      log(`[supervisor] Child ${pidToKill} still alive after SIGTERM, force killing with taskkill...`);
      try {
        execSync(`taskkill /F /T /PID ${pidToKill}`, {
          windowsHide: true,
          stdio: 'ignore'
        });
      } catch {}
    }
  }, 2000);

  // Fallback 2: Failsafe after 4s to ensure supervisor never gets stuck if exit event was missed
  setTimeout(() => {
    if (isRestarting && (!child || child.pid === pidToKill)) {
      log(`[supervisor] Failsafe recovery: resetting restart state and spawning child...`);
      clearTimeout(forceKillTimer);
      child = null;
      isRestarting = false;
      spawnChild();
    }
  }, 4000);
}

function checkHealth() {
  if (shuttingDown || !child || isRestarting) return;
  // Grace period: allow 3s after startup before running health probes
  if (Date.now() - childStartTime < 3000) return;
  if (isProbing) return;

  const now = Date.now();
  const delta = now - lastProbeTime;
  lastProbeTime = now;

  // Sleep/wake detection: if time elapsed since last probe is > 2.5x interval,
  // the machine was asleep or heavily suspended. Reset counter to avoid false kill.
  if (delta > PROBE_INTERVAL_MS * 2.5) {
    log(`[healthz] System resumed from sleep/pause (delta: ${delta}ms). Resetting probe failure count.`);
    consecutiveProbeFailures = 0;
  }

  isProbing = true;

  let dispatched = false;
  function handleProbeFailure(reason) {
    if (dispatched) return;
    dispatched = true;
    isProbing = false;
    consecutiveProbeFailures++;
    log(`[healthz] Probe failed (${consecutiveProbeFailures}/${MAX_CONSECUTIVE_PROBE_FAILURES}): ${reason}`);
    if (consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
      consecutiveProbeFailures = 0;
      restartChild(`unhealthy (${MAX_CONSECUTIVE_PROBE_FAILURES} consecutive probe timeouts)`);
    }
  }

  function handleProbeSuccess() {
    if (dispatched) return;
    dispatched = true;
    isProbing = false;
    consecutiveProbeFailures = 0;
  }

  try {
    const req = http.get({
      hostname: HOST,
      port: PORT,
      path: '/healthz',
      timeout: PROBE_TIMEOUT_MS,
      agent: false
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          handleProbeSuccess();
        } else {
          handleProbeFailure(`HTTP ${res.statusCode}: ${body.slice(0, 100)}`);
        }
      });
      res.on('error', (err) => {
        handleProbeFailure(`Response error: ${err.message}`);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${PROBE_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      handleProbeFailure(`Request error: ${err.message}`);
    });
  } catch (err) {
    handleProbeFailure(`Dispatch error: ${err.message}`);
  }
}

function spawnChild() {
  if (shuttingDown) return;
  isRestarting = false;

  freePort(PORT);

  log('[supervisor] Starting workbuddy-bridge...');
  childStartTime = Date.now();

  child = spawn(process.execPath, ['--max-old-space-size=2048', serverPath], {
    cwd: bridgeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env
  });

  child.stdout.on('data', (d) => log(`[stdout] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => log(`[stderr] ${d.toString().trim()}`));

  child.on('exit', (code, signal) => {
    const runDuration = Date.now() - childStartTime;
    log(`[supervisor] workbuddy-bridge exited with code: ${code}, signal: ${signal} (ran for ${runDuration}ms)`);
    child = null;

    if (shuttingDown) return;

    const delay = runDuration < CRASH_THRESHOLD_MS ? CRASH_BACKOFF_MS : NORMAL_RESTART_MS;
    log(`[supervisor] Restarting in ${delay}ms...`);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, delay);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[supervisor] Received ${signal}. Shutting down supervisor...`);

  if (probeTimer) clearInterval(probeTimer);
  if (restartTimer) clearTimeout(restartTimer);

  if (child) {
    const pid = child.pid;
    try {
      child.kill('SIGTERM');
    } catch {}
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  if (child) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
  log('[supervisor] Supervisor process exited.');
});

process.on('uncaughtException', (err) => {
  log(`[supervisor] Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`[supervisor] Unhandled rejection: ${reason}`);
});

