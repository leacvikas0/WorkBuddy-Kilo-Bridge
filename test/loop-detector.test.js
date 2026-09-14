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
