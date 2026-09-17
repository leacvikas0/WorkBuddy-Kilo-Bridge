# Bridge Loop Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when the workbuddy model degenerates into a repeated-phrase loop and terminate that stream so the turn fails fast instead of burning tokens.

**Architecture:** A new pure module `lib/loop-detector.js` holds all detection logic (no I/O, no timers, no global state). `lib/translate.js`'s `relayStream()` feeds streamed `content` and `reasoning_content` deltas into a per-stream guard; when the guard fires, relaying stops and the response ends **without** `[DONE]` so Kilo sees a failed turn. `server.js` wires the guard in for streaming requests.

**Tech Stack:** Node.js (CommonJS, `"type": "commonjs"`), `node:test` + `node:assert`, no new dependencies.

## Global Constraints

- Repo root: the repository root (referred to below as `<REPO>`)
- Node `>=18` (from `package.json` `engines`). CommonJS only — use `require`, never `import`.
- No new npm dependencies. `sharp` is the only existing dependency and is unrelated.
- Existing tests must keep passing. Run the whole suite with `npm test` (`node --test test/*.test.js`).
- A normal (non-looping) stream must still end with `data: [DONE]` exactly as today.
- Detection failures must never break relaying: a thrown detector degrades to "no guard", not "no streaming".
- Env var prefix is `WB_LOOP_*`, matching the existing `WB_AUTH_PATH` / `WB_LIVE` convention.
- Defaults: `WB_LOOP_GUARD=1`, `WB_LOOP_MIN_REPEATS=8`, `WB_LOOP_MAX_CYCLE_WORDS=80`, `WB_LOOP_TAIL_WORDS=1200`, `WB_LOOP_CHECK_EVERY_WORDS=40`.
- Detection watches **both** channels independently: `content` and `reasoning_content`. All three known loops were in `reasoning_content`.
- Do not send `[DONE]` when a loop is detected.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/loop-detector.js` | **New.** Pure detection (`findTailLoop`), per-stream state (`createStreamGuard`), env parsing (`readConfigFromEnv`). No I/O. |
| `lib/translate.js` | **Modified.** `relayStream()` accepts `{ guard, onLoop }` and cuts the stream on a hit. |
| `server.js` | **Modified.** Builds the guard from env and passes it to `relayStream()`. |
| `test/loop-detector.test.js` | **New.** Unit tests: real positives, real negatives (including the ASCII-art false positive), boundaries, config, chunked streaming. |
| `test/translate.test.js` | **Modified.** Integration: looping stream is cut with no `[DONE]`; normal stream unaffected. |
| `tools/extract-loop-fixtures.py` | **New.** One-off generator that pulls verbatim loop samples out of the session DB into JSON. |
| `tools/loop-guard-harness.js` | **New.** End-to-end verification over real HTTP with a stubbed upstream. |
| `test/fixtures/loop-samples.json` | **New, committed.** Verbatim positive/negative fixtures so tests never touch the DB. |
| `docs/API_REFERENCE.md` | **Modified.** Document the new env vars. |

---

## Task 1: Generate verbatim test fixtures from the session database

Detection must be validated against real degenerate output, not invented strings. This task extracts the three known loops and two known non-loops into a committed JSON fixture so the test suite has no database dependency.

**Files:**
- Create: `tools/extract-loop-fixtures.py`
- Create: `test/fixtures/loop-samples.json` (generated, then committed)

**Interfaces:**
- Consumes: nothing.
- Produces: `test/fixtures/loop-samples.json` with this exact shape:

```json
{
  "positives": [
    { "name": "cycle-21", "channel": "reasoning", "expectedCycleWords": 21, "words": ["..."] },
    { "name": "cycle-14", "channel": "reasoning", "expectedCycleWords": 14, "words": ["..."] },
    { "name": "cycle-10", "channel": "reasoning", "expectedCycleWords": 10, "words": ["..."] }
  ],
  "negatives": [
    { "name": "repetitive-but-legit", "channel": "content", "words": ["..."] },
    { "name": "repetitive-but-legit", "channel": "content", "words": ["..."] },
    { "name": "ascii-dashed-rule", "channel": "reasoning", "note": "...", "words": ["..."] }
  ]
}
```

The extraction order is whatever the DB returns; tests must not assume a fixed order, so they key off `name`/`expectedCycleWords` rather than array position. The `ascii-dashed-rule` negative is the regression guard for the meaningful-cycle rule in Task 2 — it is a run of identical `-` tokens (an ASCII-art rule) that a naive detector reads as a perfect 2-word cycle.

- [ ] **Step 1: Write the extraction script**

Create `tools/extract-loop-fixtures.py`:

```python
#!/usr/bin/env python3
"""One-off generator: pull verbatim loop/non-loop samples from the Kilo session DB.

Run from the bridge repo root:
    python tools/extract-loop-fixtures.py
Writes test/fixtures/loop-samples.json. Re-run only if you want to refresh samples.

Samples are verbatim: three real degenerate loops (all in reasoning) and three
real non-loops, including an ASCII-art dashed rule that a naive detector
false-positives on when streamed.
"""
import sqlite3, os, json, re

DB = os.path.expanduser(r"~/.local/share/kilo/kilo.db")
OUT = os.path.join("test", "fixtures", "loop-samples.json")
WORD = re.compile(r"\S+")
MIN_REPEATS = 8
TAIL_WORDS = 400
ASCII_MIN_RUN = 12


def tail_cycle(words, min_repeats=MIN_REPEATS, max_cycle=80):
    if len(words) < min_repeats * 2:
        return None
    for c in range(2, min(max_cycle, len(words) // min_repeats + 1)):
        need = c * min_repeats
        if need > len(words):
            break
        tail = words[-need:]
        seq = tail[:c]
        if all(tail[k * c:(k + 1) * c] == seq for k in range(1, min_repeats)):
            return c
    return None


def max_same_word_run(words):
    best = run = 1
    for a, b in zip(words, words[1:]):
        if a == b:
            run += 1
            best = max(best, run)
        else:
            run = 1
    return best


def longest_identical_run(words):
    """Return (run_length, start_index) for the longest run of identical tokens."""
    best_len, best_start = 0, 0
    run_start = 0
    for i in range(1, len(words) + 1):
        if i < len(words) and words[i] == words[run_start]:
            continue
        if i - run_start > best_len:
            best_len, best_start = i - run_start, run_start
        run_start = i
    return best_len, best_start


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute(
        "SELECT id FROM message WHERE json_extract(data,'$.role')='assistant' "
        "AND json_extract(data,'$.providerID')='workbuddy'"
    )
    ids = [r[0] for r in cur.fetchall()]

    positives, negatives = [], []
    ascii_best = None  # (run_length, window_words)

    for mid in ids:
        for kind, field in (("reasoning", "reasoning"), ("content", "text")):
            cur.execute(
                "SELECT data FROM part WHERE message_id=? AND json_extract(data,'$.type')=?",
                (mid, field),
            )
            txt = "".join(json.loads(d).get("text") or "" for (d,) in cur.fetchall())
            if len(txt) < 300:
                continue
            words = WORD.findall(txt)
            c = tail_cycle(words)
            if c and len(positives) < 3:
                positives.append({
                    "name": f"cycle-{c}",
                    "channel": kind,
                    "expectedCycleWords": c,
                    "words": words[-TAIL_WORDS:],
                })
                continue
            if not c and kind == "content" and max_same_word_run(words) >= 5 and len(negatives) < 2:
                negatives.append({
                    "name": "repetitive-but-legit",
                    "channel": kind,
                    "words": words[-TAIL_WORDS:],
                })
            run_len, run_start = longest_identical_run(words)
            if run_len >= ASCII_MIN_RUN and (ascii_best is None or run_len > ascii_best[0]):
                lo = max(0, run_start - 120)
                hi = min(len(words), run_start + run_len + 120)
                ascii_best = (run_len, words[lo:hi])

    if ascii_best:
        negatives.append({
            "name": "ascii-dashed-rule",
            "channel": "reasoning",
            "note": (
                "A run of identical punctuation tokens (an ASCII-art dashed rule). "
                "Must not fire, including when streamed in chunks; this is the "
                "regression guard for the meaningful-cycle refinement."
            ),
            "words": ascii_best[1],
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"positives": positives, "negatives": negatives}, f, indent=2)
    print(f"positives={len(positives)} negatives={len(negatives)} -> {OUT}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the generator**

Run: `python tools/extract-loop-fixtures.py`
Expected: `positives=3 negatives=3 -> test/fixtures/loop-samples.json`

If it prints fewer positives than 3, the DB has rotated; report the counts and stop rather than hand-writing fixtures.

- [ ] **Step 3: Verify the fixture is sane**

Run: `node -e "const f=require('./test/fixtures/loop-samples.json'); console.log(f.positives.map(p=>p.name+':'+p.expectedCycleWords).join(', '), '| neg:', f.negatives.map(n=>n.name).join(','))"`
Expected: three positives with `expectedCycleWords` 10, 14, and 21 (in any order), and `neg: repetitive-but-legit,repetitive-but-legit,ascii-dashed-rule`

- [ ] **Step 4: Commit**

```bash
git add tools/extract-loop-fixtures.py test/fixtures/loop-samples.json
git commit -m "test: add verbatim loop fixtures extracted from session DB"
```

---

## Task 2: Pure tail-loop detection

**Files:**
- Create: `lib/loop-detector.js`
- Test: `test/loop-detector.test.js`

**Interfaces:**
- Consumes: `test/fixtures/loop-samples.json` from Task 1.
- Produces: `findTailLoop(words, options) -> { cycleWords: number, repeats: number } | null`

- [ ] **Step 1: Write the failing test**

Create `test/loop-detector.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/loop-detector.test.js`
Expected: FAIL — `Cannot find module '../lib/loop-detector'`

- [ ] **Step 3: Write the minimal implementation**

Create `lib/loop-detector.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/loop-detector.test.js`
Expected: PASS — 8 tests passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add lib/loop-detector.js test/loop-detector.test.js
git commit -m "feat(loop-detector): detect tail repetition cycles"
```

---

## Task 3: Environment configuration parsing

**Files:**
- Modify: `lib/loop-detector.js`
- Test: `test/loop-detector.test.js`

**Interfaces:**
- Consumes: `DEFAULT_OPTIONS` from Task 2.
- Produces: `readConfigFromEnv(env) -> { enabled, minRepeats, maxCycleWords, tailWords, checkEveryWords }`

- [ ] **Step 1: Write the failing test**

Append to `test/loop-detector.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/loop-detector.test.js`
Expected: FAIL — `readConfigFromEnv is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `lib/loop-detector.js`, add above `module.exports`:

```js
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
```

Update the exports line:

```js
module.exports = { findTailLoop, readConfigFromEnv, DEFAULT_OPTIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/loop-detector.test.js`
Expected: PASS — 12 tests passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add lib/loop-detector.js test/loop-detector.test.js
git commit -m "feat(loop-detector): read guard configuration from WB_LOOP_* env vars"
```

---

## Task 4: Per-stream stateful guard

**Files:**
- Modify: `lib/loop-detector.js`
- Test: `test/loop-detector.test.js`

**Interfaces:**
- Consumes: `findTailLoop`, `DEFAULT_OPTIONS`.
- Produces: `createStreamGuard(options) -> { push(channel, text) -> { cycleWords, repeats, channel } | null }`

- [ ] **Step 1: Write the failing test**

Append to `test/loop-detector.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/loop-detector.test.js`
Expected: FAIL — `createStreamGuard is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `lib/loop-detector.js`, add above `module.exports`:

```js
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
```

Update the exports line:

```js
module.exports = { findTailLoop, readConfigFromEnv, createStreamGuard, DEFAULT_OPTIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/loop-detector.test.js`
Expected: PASS — 20 tests passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add lib/loop-detector.js test/loop-detector.test.js
git commit -m "feat(loop-detector): add per-stream guard with bounded buffers"
```

---

## Task 5: Cut the stream on a detected loop

**Files:**
- Modify: `lib/translate.js:16-79` (`relayStream`)
- Test: `test/translate.test.js`

**Interfaces:**
- Consumes: `createStreamGuard` from Task 4 (as an injected object; `translate.js` does not import it).
- Produces: `relayStream(upstreamRes, clientRes, options)` where `options = { guard?, onLoop? }`.
  - `guard.push(channel, text)` returns a hit or null.
  - `onLoop(hit)` is called once with `{ cycleWords, repeats, channel }`.

- [ ] **Step 1: Write the failing test**

Append to `test/translate.test.js`:

```js
const { createStreamGuard } = require('../lib/loop-detector');

const CYCLE = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];

function loopSse() {
  const events = [];
  events.push('data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}');
  for (let i = 0; i < 8 * CYCLE.length; i++) {
    const tok = CYCLE[i % CYCLE.length];
    events.push('data: ' + JSON.stringify({
      id: 'c9', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: tok + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: {"id":"c9","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
  events.push('data: [DONE]');
  return events.join('\n\n');
}

function sseUpstream(text) {
  const bytes = Buffer.from(text, 'utf8');
  let sent = false;
  return {
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value: bytes });
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  };
}

function captureRes() {
  const writes = [];
  let ended = false;
  return {
    writeHead() {},
    write(c) { writes.push(String(c)); },
    end(c) { if (c !== undefined) writes.push(String(c)); ended = true; },
    get writes() { return writes; },
    get ended() { return ended; },
  };
}

test('relayStream cuts the stream and omits [DONE] when a loop is detected', async () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const hits = [];
  const res = captureRes();
  await relayStream(sseUpstream(loopSse()), res, { guard, onLoop: (h) => hits.push(h) });

  const body = res.writes.join('');
  assert.equal(body.includes('[DONE]'), false, 'must not send [DONE] on a loop');
  assert.equal(hits.length, 1, 'onLoop must fire exactly once');
  assert.equal(hits[0].cycleWords, 10);
  assert.equal(hits[0].channel, 'reasoning');
  assert.equal(res.ended, true, 'response must be ended');
});

test('relayStream still ends normally with [DONE] when no guard is passed', async () => {
  const res = captureRes();
  await relayStream(sseUpstream(loopSse()), res);
  assert.equal(res.writes.join('').includes('[DONE]'), true);
});

test('relayStream ends normally when the guard never fires', async () => {
  const guard = createStreamGuard({ minRepeats: 8, maxCycleWords: 80, tailWords: 1200, checkEveryWords: 40 });
  const res = captureRes();
  await relayStream(sseUpstream(RSSE), res, { guard });
  assert.equal(res.writes.join('').includes('[DONE]'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/translate.test.js`
Expected: FAIL — the loop test reports `must not send [DONE] on a loop`, because `relayStream` ignores the third argument.

- [ ] **Step 3: Replace `relayStream` with the guarded version**

In `lib/translate.js`, replace the whole existing `relayStream` function (currently lines 16–79) with:

```js
function relayStream(upstreamRes, clientRes, options = {}) {
  const guard = options.guard || null;
  const onLoop = options.onLoop || null;
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const body = upstreamRes.body;
  if (!body || typeof body.getReader !== 'function') {
    clientRes.end('data: [DONE]\n\n');
    return Promise.resolve();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;
  let stopped = false;
  if (typeof clientRes.on === 'function') {
    clientRes.on('close', () => {
      closed = true;
      try { reader.cancel(); } catch { /* ignore */ }
    });
  }

  // Terminate the turn without [DONE] so the client sees a failed stream
  // rather than a clean completion.
  const stopForLoop = (hit) => {
    if (stopped) return;
    stopped = true;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* ignore */ }
    if (typeof onLoop === 'function') {
      try { onLoop(hit); } catch { /* ignore */ }
    }
    try { clientRes.end(); } catch { /* ignore */ }
  };

  const emitBlock = (block) => {
    if (stopped) return;
    const datas = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      datas.push(line.slice(5).trim());
    }
    if (datas.some((d) => d === '[DONE]')) {
      try { clientRes.write('data: [DONE]\n\n'); } catch {}
      return;
    }
    const payload = datas.join('\n');
    if (!payload) return;
    let ev;
    try { ev = JSON.parse(payload); } catch { return; /* skip keep-alive noise */ }
    const clean = sanitizeChunkEvent(ev);

    if (guard) {
      const choice = clean && clean.choices && clean.choices[0];
      const delta = choice && choice.delta;
      if (delta) {
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          const hit = guard.push('reasoning', delta.reasoning_content);
          if (hit) { stopForLoop(hit); return; }
        }
        if (typeof delta.content === 'string' && delta.content) {
          const hit = guard.push('content', delta.content);
          if (hit) { stopForLoop(hit); return; }
        }
      }
    }

    try { clientRes.write('data: ' + JSON.stringify(clean) + '\n\n'); } catch {}
  };

  const pump = () => {
    if (closed || stopped) return Promise.resolve();
    return reader.read().then(({ done, value }) => {
      if (closed || stopped) return;
      if (done) {
        buf += decoder.decode();
        if (buf.trim()) emitBlock(buf);
        if (!stopped) { try { clientRes.end(); } catch { /* client gone */ } }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop();
      for (const b of blocks) {
        if (b.trim()) emitBlock(b);
        if (stopped) return;
      }
      return pump();
    }).catch(() => {
      if (!stopped) { try { clientRes.end(); } catch { /* client gone */ } }
    });
  };

  return pump();
}
```

- [ ] **Step 4: Run the whole suite to verify it passes and nothing regressed**

Run: `npm test`
Expected: all tests pass, including the pre-existing `relayStream sanitizes split-byte chunks without buffering the turn`.

- [ ] **Step 5: Commit**

```bash
git add lib/translate.js test/translate.test.js
git commit -m "feat(translate): cut the stream when the loop guard fires"
```

---

## Task 6: Wire the guard into the server

**Files:**
- Modify: `server.js` (imports near line 10; the `wantStream` branch at line 205)
- Modify: `docs/API_REFERENCE.md`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `readConfigFromEnv`, `createStreamGuard` from Task 4; `relayStream(upstreamRes, clientRes, options)` from Task 5.
- Produces: streaming requests are guarded according to `WB_LOOP_*`.

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.js`, matching the file's existing stub style exactly (temp auth file + `process.env.WB_AUTH_PATH`, `globalThis.fetch` returning a real `Response`, `req`/`res` plain objects):

```js
test('POST chat streaming cuts a looping stream and omits [DONE]', async () => {
  const fp = path.join(os.tmpdir(), 'wb-loop-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';
  // server.js reads config at require time, so reload it with the env in place.
  delete require.cache[require.resolve('../server')];
  const { handleChat: guardedHandleChat } = require('../server');

  const cycle = ['Let', 'me', 'write.', 'OK.'];
  const events = ['data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'];
  for (let i = 0; i < 8 * cycle.length; i++) {
    events.push('data: ' + JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: cycle[i % cycle.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: [DONE]');
  const LOOP_SSE = events.join('\n\n');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(LOOP_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  try {
    await guardedHandleChat(req, res);
    assert.equal(res.status, 200);
    const body = res.chunks.join('');
    assert.equal(body.includes('[DONE]'), false, 'looping stream must not complete with [DONE]');
    assert.ok(body.includes('reasoning_content'), 'the good prefix should still be relayed');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    delete process.env.WB_LOOP_MIN_REPEATS;
    delete process.env.WB_LOOP_CHECK_EVERY_WORDS;
    delete require.cache[require.resolve('../server')];
    fs.unlinkSync(fp);
  }
});

test('POST chat streaming still completes normally for non-looping output', async () => {
  const fp = path.join(os.tmpdir(), 'wb-noloop-auth-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const req = { method: 'POST', url: '/v1/chat/completions', on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })); if (ev === 'end') fn(); return this; }, destroy() {} };
  const res = { status: 0, chunks: [], writeHead(s) { this.status = s; }, write(c) { this.chunks.push(String(c)); }, end(c) { if (c !== undefined) this.chunks.push(String(c)); } };
  try {
    await handleChat(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.chunks.join('').includes('[DONE]'), 'normal stream must still end with [DONE]');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.WB_AUTH_PATH;
    fs.unlinkSync(fp);
  }
});
```

Note: `server.js` reads `WB_LOOP_*` at require time, which is why the looping test reloads the module via `delete require.cache`. The second test uses the already-loaded module and only exercises the no-loop path.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.js`
Expected: FAIL — the response contains `[DONE]` because `server.js` does not pass a guard.

- [ ] **Step 3: Wire the guard in**

In `server.js`, add to the requires near line 10:

```js
const { readConfigFromEnv, createStreamGuard } = require('./lib/loop-detector');
```

Add at module scope, after the `MAX_BODY_BYTES` constant:

```js
const LOOP_GUARD_CONFIG = readConfigFromEnv();
```

Replace line 205 (`if (wantStream) return relayStream(upRes, res);`) with:

```js
  if (wantStream) {
    if (!LOOP_GUARD_CONFIG.enabled) return relayStream(upRes, res);
    return relayStream(upRes, res, {
      guard: createStreamGuard(LOOP_GUARD_CONFIG),
      onLoop: (hit) => {
        console.warn(
          `[workbuddy-bridge] loop guard fired: model=${upBody.model} channel=${hit.channel} ` +
          `cycleWords=${hit.cycleWords} repeats=${hit.repeats}`
        );
      },
    });
  }
```

- [ ] **Step 4: Run the whole suite to verify it passes**

Run: `npm test`
Expected: all tests pass, including the pre-existing `server.test.js` cases.

- [ ] **Step 5: Document the env vars**

Append to `docs/API_REFERENCE.md`:

```markdown
## Loop guard

The bridge terminates a stream when the model degenerates into a repeated-phrase loop,
ending the turn without `[DONE]` so the client sees a failed response.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WB_LOOP_GUARD` | `1` | Set to `0` to disable the guard entirely |
| `WB_LOOP_MIN_REPEATS` | `8` | Consecutive repeats of a cycle required to fire |
| `WB_LOOP_MAX_CYCLE_WORDS` | `80` | Longest cycle length (in words) considered |
| `WB_LOOP_TAIL_WORDS` | `1200` | Size of the bounded tail buffer, in words |
| `WB_LOOP_CHECK_EVERY_WORDS` | `40` | Minimum new words between detection passes |

Both `content` and `reasoning_content` are watched, independently. Invalid values fall
back to the default; the bridge always starts.
```

- [ ] **Step 6: Commit**

```bash
git add server.js docs/API_REFERENCE.md test/server.test.js
git commit -m "feat(server): guard streaming responses against repetition loops"
```

---

## Task 7: End-to-end verification over real HTTP

Unit tests use stub `res` objects. This task proves the guard works through real sockets — the actual `http.Server`, real `res.end()` semantics, and a real client reading the stream. It also settles the one open question from the spec: whether ending the response without `[DONE]` is surfaced as a failed turn.

**Files:**
- Create: `tools/loop-guard-harness.js`
- No changes to `lib/` or `server.js`. Verification only.

**Interfaces:**
- Consumes: `requestListener` and `handleChat` from `server.js`; `lib/loop-detector.js`.
- Produces: a go/no-go on the termination primitive.

- [ ] **Step 1: Write the harness**

Create `tools/loop-guard-harness.js`:

```js
#!/usr/bin/env node
'use strict';
// Manual verification: drives the bridge over real HTTP with a stubbed upstream
// that emits a known loop, and reports how the stream terminates.
//
//   node tools/loop-guard-harness.js
//
// Exits 0 if the guard cut the stream without [DONE]; 1 otherwise.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CYCLE = ['Let', 'me', 'write.', 'Let', 'me', 'search.', 'Let', 'me', 'go.', 'OK.'];

function loopSse() {
  const events = ['data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}'];
  for (let i = 0; i < 8 * CYCLE.length; i++) {
    events.push('data: ' + JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, delta: { reasoning_content: CYCLE[i % CYCLE.length] + ' ' }, finish_reason: null }],
    }));
  }
  events.push('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
  events.push('data: [DONE]');
  return events.join('\n\n');
}

async function main() {
  const fp = path.join(os.tmpdir(), 'wb-harness-auth-' + Date.now() + '.json');
  fs.writeFileSync(fp, JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', refreshToken: 'r', domain: 'www.workbuddy.ai' } }));
  process.env.WB_AUTH_PATH = fp;
  process.env.WB_LOOP_MIN_REPEATS = process.env.WB_LOOP_MIN_REPEATS || '8';
  process.env.WB_LOOP_CHECK_EVERY_WORDS = '1';

  // Stub upstream before server.js loads.
  globalThis.fetch = async () => new Response(loopSse(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  const { requestListener } = require('../server');
  const server = http.createServer(requestListener);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('harness listening on ' + port);

  const body = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });

  const result = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text, aborted: false }));
      res.on('aborted', () => resolve({ status: res.statusCode, text, aborted: true }));
      res.on('error', (e) => resolve({ status: res.statusCode, text, aborted: true, error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, text: '', aborted: true, error: e.message }));
    req.write(body);
    req.end();
  });

  await new Promise((r) => server.close(r));
  fs.unlinkSync(fp);

  const hasDone = result.text.includes('[DONE]');
  const hasContent = result.text.includes('reasoning_content');
  console.log('status=' + result.status + ' aborted=' + result.aborted + ' bytes=' + result.text.length);
  console.log('relayed good prefix=' + hasContent);
  console.log('sent [DONE]=' + hasDone);

  if (hasDone) {
    console.error('FAIL: guard did not cut the stream ([DONE] was sent)');
    process.exit(1);
  }
  console.log('PASS: stream was cut without [DONE]');
  process.exit(0);
}

main().catch((e) => { console.error('harness error: ' + e.message); process.exit(1); });
```

- [ ] **Step 2: Run the harness**

Run: `node tools/loop-guard-harness.js`
Expected:

```
harness listening on <port>
status=200 aborted=false bytes=<n>
relayed good prefix=true
sent [DONE]=false
PASS: stream was cut without [DONE]
```

If it prints `FAIL: guard did not cut the stream`, the guard is not wired correctly — return to Task 6.

- [ ] **Step 3: Confirm no false positives against real traffic**

Restart the bridge so the new code is live, then use Kilo normally for a few turns:

Run: `Select-String -LiteralPath "workbuddy-bridge.log" -Pattern "loop guard fired"`
Expected: no matches. If matches appear during ordinary work, `WB_LOOP_MIN_REPEATS` is too low — raise it and re-test before continuing.

- [ ] **Step 4: Trigger a real loop and confirm the guard fires in production**

In Kilo, send a prompt that reliably induces the reasoning loop (a task that invites repeated deliberation without a concrete first action, e.g. "review this repo thoroughly and then tell me what you'd do" on a large unfamiliar codebase).

Then:

Run: `Select-String -LiteralPath "workbuddy-bridge.log" -Pattern "loop guard fired" | Select-Object -Last 5`
Expected: at least one line naming `channel=reasoning` and a `cycleWords` value.

Record the elapsed time from request start to the cut.

- [ ] **Step 5: Decide on the termination primitive**

Observe how Kilo presented the cut turn:

- If Kilo showed the turn as **failed/errored** — the design holds; the task is done.
- If Kilo showed the turn as **successfully completed** (treating stream end as completion regardless of `[DONE]`) — then `res.end()` is insufficient. **Stop and report before changing anything.** The alternatives are sending an explicit SSE `error` event or `res.destroy()`, and that is a design change worth deciding deliberately rather than guessing.

- [ ] **Step 6: Commit the harness**

```bash
git add tools/loop-guard-harness.js
git commit -m "test: add end-to-end loop guard harness over real HTTP"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Detection algorithm | Task 2 |
| Meaningful-cycle refinement (real false positive) | Task 2 (`isMeaningfulCycle`), Task 4 (chunked regression test) |
| Both channels watched | Task 4 (`createStreamGuard` per-channel state), Task 5 (feeds both) |
| On detection: stop, cancel, no `[DONE]` | Task 5, verified live in Task 7 |
| Configuration env vars + defaults + safe fallback | Task 3, documented in Task 6 |
| Error handling: detector failure never breaks relaying | Task 5 (guarded calls), Task 4 (`push` returns null on bad input) |
| Testing: positives, negatives, boundaries, channel independence, config | Tasks 2–5 |
| Testing: integration that stream is cut with no `[DONE]` | Task 5 (stub res), Task 7 (real HTTP) |
| workbuddy-only scope | Structural: the bridge only serves workbuddy. No model filter is added, per YAGNI. |
| Out of scope: plugin, kilo.jsonc, non-workbuddy | Not implemented. |

**Placeholder scan:** no TBD/TODO; every code step contains complete code; every command has expected output.

**Type consistency:** `findTailLoop(words, options)` returns `{ cycleWords, repeats }`; `createStreamGuard().push(channel, text)` returns `{ cycleWords, repeats, channel }`; `relayStream(upstreamRes, clientRes, options)` where `options = { guard, onLoop }` and `onLoop` receives the guard's hit object. `readConfigFromEnv` returns exactly the keys `DEFAULT_OPTIONS` declares, so `{ ...DEFAULT_OPTIONS, ...options }` in `createStreamGuard` is consistent.

**Plan validated before handoff.** The detector, config parser, and guard code from Tasks 2–4 were executed against the real fixture data: 20/20 unit assertions pass, including all three real loops and all three real negatives. The Task 5 `relayStream` was staged and driven with synthetic SSE: 4/4 integration assertions pass (loop cut with no `[DONE]`, good prefix still relayed, normal streams unaffected). Task 6's server wiring and Task 7's harness were then applied to a staged copy of the real repo and run: the full suite passes 71/71 and the harness exits 0 over real HTTP.

Three bugs were found and fixed during that validation:

1. **Fixture construction.** `cycle.join(' ').repeat(8)` fuses the last word of one repetition onto the first of the next (`"OK.Let"`), producing 19 words instead of 20 and hiding the loop. The plan now defines `repeatCycle(cycle, n)` and `CYCLE_10_TEXT = CYCLE_10.join(' ') + ' '`, and warns against the fused form.
2. **Wrong expected cycle length.** A 13-element array was labeled a 14-word cycle. The minimal period of the real observed tail is genuinely 14, so the fixture was replaced with the correct 14-word array.
3. **A real false positive, found only by sweeping the whole corpus.** The detector was run over every workbuddy `text`/`reasoning` part in the session DB (5,476 parts ≥ 200 chars, 8,157 assistant messages). The pure tail-cycle test fired on exactly the three known loops — but the *streaming* guard also fired on an ASCII-art dashed rule (`- - - - - - - -`), which is a perfect 2-token cycle carrying no information. Fixed with `isMeaningfulCycle`: a cycle must have ≥ 2 distinct tokens, or a single alphanumeric token. Re-swept afterwards: **6/6 genuine loops detected, 0 false positives, 0 unclassified**, with the ASCII-art case committed as a fixture and tested through the streaming guard.

   The sweep found 6 genuine degenerate loops in the corpus; the 3 most distinct (cycles of 10, 14, and 21 words) are the committed positives, which is why the fixture count is 3 while the sweep figure is 6.

The sweep is the reason the plan's fixture set has three negatives rather than two. Both synthetic and real data were used: the boundary tests use constructed cycles, the positives and negatives are verbatim DB output, and the false positive is a verbatim DB window.

**Known gap:** Task 7 Step 5 is an intentional decision point rather than a coded step, because the correct termination primitive cannot be determined without observing real client behavior. This is called out rather than guessed.
