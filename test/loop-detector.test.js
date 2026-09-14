const test = require('node:test');
const assert = require('node:assert');
const { findTailLoop } = require('../lib/loop-detector');
const fixtures = require('./fixtures/loop-samples.json');

// Build a word array that repeats `cycle` exactly `n` times.
// NOTE: do not use cycle.join(' ').repeat(n) — that fuses the last word of one
// repetition onto the first word of the next ("OK.Let"), which changes the
// token count and hides the loop.
function repeatCycle(cycle, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...cycle);
  return out;
}

test('findTailLoop detects the three real degenerate loops', () => {
  for (const p of fixtures.positives) {
    const hit = findTailLoop(p.words, { minRepeats: 8, maxCycleWords: 80 });
    assert.ok(hit, `expected a loop for ${p.name}`);
    assert.equal(hit.cycleWords, p.expectedCycleWords, `cycle length for ${p.name}`);
    assert.equal(hit.repeats, 8);
  }
});

test('findTailLoop does not fire on real repetitive-but-legitimate output', () => {
  for (const n of fixtures.negatives) {
    const hit = findTailLoop(n.words, { minRepeats: 8, maxCycleWords: 80 });
    assert.equal(hit, null, `unexpected loop for ${n.name}`);
  }
});

test('findTailLoop fires at exactly minRepeats and not one fewer', () => {
  const cycle = ['alpha', 'beta', 'gamma'];
  assert.equal(findTailLoop(repeatCycle(cycle, 7), { minRepeats: 8, maxCycleWords: 80 }), null);
  assert.deepEqual(findTailLoop(repeatCycle(cycle, 8), { minRepeats: 8, maxCycleWords: 80 }), { cycleWords: 3, repeats: 8 });
});

test('findTailLoop handles a two-word cycle', () => {
  assert.deepEqual(findTailLoop(repeatCycle(['let', 'me'], 8), { minRepeats: 8, maxCycleWords: 80 }), { cycleWords: 2, repeats: 8 });
});

test('findTailLoop ignores a cycle longer than maxCycleWords', () => {
  const cycle = Array.from({ length: 20 }, (_, i) => `w${i}`);
  assert.equal(findTailLoop(repeatCycle(cycle, 8), { minRepeats: 8, maxCycleWords: 10 }), null);
});

test('findTailLoop returns null for empty and short input', () => {
  assert.equal(findTailLoop([], { minRepeats: 8, maxCycleWords: 80 }), null);
  assert.equal(findTailLoop(['a', 'b'], { minRepeats: 8, maxCycleWords: 80 }), null);
});

test('findTailLoop rejects a pure punctuation run (ASCII-art dashed rule)', () => {
  // A real observed false positive: the model draws "- - - - - - - -" as a rule
  // in ASCII art. That is a perfect 2-token cycle carrying zero information.
  const cycle = ['-', '-'];
  assert.equal(findTailLoop(repeatCycle(cycle, 40), { minRepeats: 8, maxCycleWords: 80 }), null);
  const box = ['|', '|'];
  assert.equal(findTailLoop(repeatCycle(box, 40), { minRepeats: 8, maxCycleWords: 80 }), null);
});

test('findTailLoop still fires on a single repeated word', () => {
  // A one-token cycle is reported as cycleWords 2 (both slots equal); the
  // detector's search starts at 2. 16 tokens are needed for 8 repeats.
  assert.deepEqual(findTailLoop(repeatCycle(['OK.'], 16), { minRepeats: 8, maxCycleWords: 80 }), { cycleWords: 2, repeats: 8 });
});

const { readConfigFromEnv, DEFAULT_OPTIONS } = require('../lib/loop-detector');

test('readConfigFromEnv returns defaults for an empty environment', () => {
  assert.deepEqual(readConfigFromEnv({}), DEFAULT_OPTIONS);
});

test('readConfigFromEnv reads each override', () => {
  const cfg = readConfigFromEnv({
    WB_LOOP_MIN_REPEATS: '4',
    WB_LOOP_MAX_CYCLE_WORDS: '12',
    WB_LOOP_TAIL_WORDS: '500',
    WB_LOOP_CHECK_EVERY_WORDS: '1',
  });
  assert.equal(cfg.minRepeats, 4);
  assert.equal(cfg.maxCycleWords, 12);
  assert.equal(cfg.tailWords, 500);
  assert.equal(cfg.checkEveryWords, 1);
  assert.equal(cfg.enabled, true);
});

test('readConfigFromEnv treats WB_LOOP_GUARD=0 as disabled', () => {
  assert.equal(readConfigFromEnv({ WB_LOOP_GUARD: '0' }).enabled, false);
  assert.equal(readConfigFromEnv({ WB_LOOP_GUARD: '1' }).enabled, true);
});

test('readConfigFromEnv falls back to defaults on garbage values', () => {
  const cfg = readConfigFromEnv({
    WB_LOOP_MIN_REPEATS: 'banana',
    WB_LOOP_TAIL_WORDS: '-5',
    WB_LOOP_MAX_CYCLE_WORDS: '',
  });
  assert.equal(cfg.minRepeats, DEFAULT_OPTIONS.minRepeats);
  assert.equal(cfg.tailWords, DEFAULT_OPTIONS.tailWords);
  assert.equal(cfg.maxCycleWords, DEFAULT_OPTIONS.maxCycleWords);
});

const { createStreamGuard } = require('../lib/loop-detector');

const CYCLE_10 = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];
// Trailing space matters: joining without it fuses "OK.Let" into one token.
const CYCLE_10_TEXT = CYCLE_10.join(' ') + ' ';

test('createStreamGuard fires on a loop fed in one push', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const hit = guard.push('reasoning', CYCLE_10_TEXT.repeat(8));
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.cycleWords, 10);
  assert.equal(hit.channel, 'reasoning');
});

test('createStreamGuard fires when the loop arrives in many small chunks', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  let hit = null;
  for (let i = 0; i < 8 * 10 && !hit; i++) {
    hit = guard.push('reasoning', CYCLE_10[i % 10] + ' ');
  }
  assert.ok(hit, 'expected a hit across chunks');
  assert.equal(hit.cycleWords, 10);
});

test('createStreamGuard keeps channels independent', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  assert.equal(guard.push('content', 'normal prose that is not looping at all'), null);
  const hit = guard.push('reasoning', CYCLE_10_TEXT.repeat(8));
  assert.ok(hit);
  assert.equal(hit.channel, 'reasoning');
});

test('createStreamGuard fires once and then stays quiet', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const loop = CYCLE_10_TEXT.repeat(8);
  assert.ok(guard.push('reasoning', loop));
  assert.equal(guard.push('reasoning', loop), null);
});

test('createStreamGuard does nothing when disabled', () => {
  const guard = createStreamGuard({ enabled: false, minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  assert.equal(guard.push('reasoning', CYCLE_10_TEXT.repeat(20)), null);
});

test('createStreamGuard bounds its buffer to tailWords', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 64, checkEveryWords: 1 });
  for (let i = 0; i < 500; i++) guard.push('content', `word${i} `);
  assert.equal(guard.bufferSize('content') <= 64, true);
});

test('createStreamGuard ignores empty and whitespace input', () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 1 });
  assert.equal(guard.push('content', ''), null);
  assert.equal(guard.push('content', '   \n\t '), null);
});

test('the real ASCII-art negative does not fire when streamed in small chunks', () => {
  // The false positive only appears in the streaming path, so this must be
  // tested through the guard, not just the pure function.
  const ascii = fixtures.negatives.find((n) => n.name === 'ascii-dashed-rule');
  assert.ok(ascii, 'ascii-dashed-rule fixture must exist');
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 1 });
  let hit = null;
  for (let i = 0; i < ascii.words.length && !hit; i += 8) {
    hit = guard.push(ascii.channel, ascii.words.slice(i, i + 8).join(' ') + ' ');
  }
  assert.equal(hit, null, 'ASCII-art dashes must never fire, even chunked');
});
