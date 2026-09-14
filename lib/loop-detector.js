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

module.exports = { findTailLoop, DEFAULT_OPTIONS };
