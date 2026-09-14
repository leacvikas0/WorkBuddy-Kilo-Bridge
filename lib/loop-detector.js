'use strict';

const DEFAULT_OPTIONS = {
  enabled: true,
  minRepeats: 8,
  maxCycleWords: 80,
  tailWords: 1200,
  checkEveryWords: 40,
};

/**
 * A cycle is only meaningful if it carries information: either it uses more
 * than one distinct token, or its single token is a real word/number.
 *
 * Without this, a run of identical punctuation tokens — an ASCII-art dashed
 * rule like "- - - - - - - -" — reads as a perfect 2-word cycle and fires on
 * legitimate drawing output. That is a real observed false positive, not a
 * hypothetical one. A single repeated *word* ("OK. OK. OK.") still fires.
 */
function isMeaningfulCycle(cycle) {
  if (new Set(cycle).size >= 2) return true;
  return /[A-Za-z0-9]/.test(cycle[0]);
}

/**
 * Find a cycle that repeats consecutively at the very end of `words`.
 * Returns { cycleWords, repeats } or null.
 */
function findTailLoop(words, options = {}) {
  const minRepeats = options.minRepeats ?? DEFAULT_OPTIONS.minRepeats;
  const maxCycleWords = options.maxCycleWords ?? DEFAULT_OPTIONS.maxCycleWords;
  if (!Array.isArray(words) || words.length < minRepeats * 2) return null;

  const maxCycle = Math.min(maxCycleWords, Math.floor(words.length / minRepeats));
  for (let c = 2; c <= maxCycle; c++) {
    const need = c * minRepeats;
    const tail = words.slice(words.length - need);
    if (!isMeaningfulCycle(tail.slice(0, c))) continue;
    let ok = true;
    for (let k = 1; k < minRepeats && ok; k++) {
      for (let i = 0; i < c; i++) {
        if (tail[k * c + i] !== tail[i]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return { cycleWords: c, repeats: minRepeats };
  }
  return null;
}

function readPositiveInt(env, key, fallback, min) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return n;
}

/** Read guard configuration from environment variables. Never throws. */
function readConfigFromEnv(env = process.env) {
  const e = env || {};
  return {
    enabled: e.WB_LOOP_GUARD === undefined ? true : e.WB_LOOP_GUARD !== '0',
    minRepeats: readPositiveInt(e, 'WB_LOOP_MIN_REPEATS', DEFAULT_OPTIONS.minRepeats, 2),
    maxCycleWords: readPositiveInt(e, 'WB_LOOP_MAX_CYCLE_WORDS', DEFAULT_OPTIONS.maxCycleWords, 2),
    tailWords: readPositiveInt(e, 'WB_LOOP_TAIL_WORDS', DEFAULT_OPTIONS.tailWords, 32),
    checkEveryWords: readPositiveInt(e, 'WB_LOOP_CHECK_EVERY_WORDS', DEFAULT_OPTIONS.checkEveryWords, 1),
  };
}

/**
 * Create an independent guard for one stream. Channels (content, reasoning)
 * are tracked separately so a loop in one never contaminates the other.
 */
function createStreamGuard(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const channels = new Map();

  function stateFor(channel) {
    let st = channels.get(channel);
    if (!st) {
      st = { words: [], sinceCheck: 0, fired: false };
      channels.set(channel, st);
    }
    return st;
  }

  return {
    push(channel, text) {
      if (!opts.enabled) return null;
      if (typeof text !== 'string' || !text) return null;

      const st = stateFor(channel);
      if (st.fired) return null;

      const newWords = text.split(/\s+/).filter(Boolean);
      if (newWords.length === 0) return null;

      for (const w of newWords) st.words.push(w);
      if (st.words.length > opts.tailWords) {
        st.words.splice(0, st.words.length - opts.tailWords);
      }

      st.sinceCheck += newWords.length;
      if (st.sinceCheck < opts.checkEveryWords) return null;
      st.sinceCheck = 0;

      const hit = findTailLoop(st.words, opts);
      if (!hit) return null;

      st.fired = true;
      return { cycleWords: hit.cycleWords, repeats: hit.repeats, channel };
    },
    bufferSize(channel) {
      const st = channels.get(channel);
      return st ? st.words.length : 0;
    },
  };
}

module.exports = { findTailLoop, readConfigFromEnv, createStreamGuard, DEFAULT_OPTIONS };
