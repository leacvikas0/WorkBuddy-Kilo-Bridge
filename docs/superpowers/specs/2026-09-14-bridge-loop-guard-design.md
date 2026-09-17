# Bridge Loop Guard — Design

**Date:** 2026-09-14
**Status:** Approved (design), implementation not started
**Component:** `WorkBuddy-Kilo-Bridge`

## Problem

The `workbuddy/deepseek-v4.1-flash` model — the user's primary model — intermittently
degenerates into a repetition loop, most often inside its **reasoning** stream. Observed
forms include:

- A 10-word cycle: `Let me write. / Let me search. / Let me go. / OK.`
- A 14-word cycle: `Let me write. / Writing. / OK.`
- A 21-word cycle: `Let me write. / Writing. / Let me write. / Emit. / OK. / Let me write. / Now. / Writing. / Let me write. / Go. / I'll write. / OK.`

The model keeps emitting until the output token ceiling is hit, burning tokens and
wall-clock time for no progress. The user must notice and abort manually.

## Evidence

Scan of the session database (`~/.local/share/kilo/kilo.db`), 23,571 assistant messages:

| minRepeats threshold | Models with a genuine tail loop |
| --- | --- |
| 8 | `workbuddy/deepseek-v4.1-flash` — 3 messages |
| 4 | `workbuddy/deepseek-v4.1-flash` — 3 messages |
| 3 | workbuddy (3) + `xai/grok-4.6` (1) |

All three workbuddy loops were in `reasoning` parts, not `text`. Legitimate repetition in
other models (tables, numbered lists, ASCII-art boxes) did not trip the detector at
`minRepeats = 4`. This confirms the user's observation that the problem is specific to the
proxy-served model.

## Decision: implement in the bridge, not as a Kilo plugin

Alternatives considered:

1. **Kilo plugin** (`~/.config/kilo/plugin/*.ts`, `event` hook on `message.part.delta`,
   `client.session.abort`). Verified feasible: a probe plugin loaded successfully,
   received streaming deltas, and reached the abort call. Rejected as the primary
   solution because abort required a restart to iterate and the loop is model-specific.
2. **Proxy/bridge watcher** — chosen.
3. **Config-only mitigation** — not applicable; no built-in loop detection exists.

Rationale for the bridge:

- The bridge serves **only** workbuddy traffic (5,237 `deepseek-v4.1-flash` + 3 `hy4-preview`
  requests in the log). Coverage is complete for the affected model.
- `lib/translate.js` already relays `reasoning_content` (lines 91, 159, 174), so the loops
  are visible in the stream.
- Only Kilo points at port 4121 (verified by grepping all harness configs), so other
  harnesses are unaffected.
- It is the user's own Node.js code with an existing `node --test` suite — fast iteration,
  no restart.

## Architecture

One new module plus one integration point:

```
lib/loop-detector.js    NEW — pure detection, no I/O, no timers, no global state
lib/translate.js        MODIFIED — relayStream() feeds deltas to the detector
test/loop-detector.test.js  NEW — unit tests with verbatim fixtures
test/translate.test.js  MODIFIED — integration test for the cut
docs/API_REFERENCE.md   MODIFIED — document the new env vars
```

The detector is a pure function so it can be tested with plain strings and reasoned about
without sockets. It retains only a bounded tail buffer, never the transcript.

## Detection algorithm

Input: the accumulating text for a single stream, split into two independent channels
(`content` and `reasoning_content`).

1. Tokenize into whitespace-delimited words.
2. Keep only the last `tailWords` words (default 1200). Bounded memory.
3. For candidate cycle length `c` from `2` to `maxCycleWords` (default 80):
   - Require at least `minRepeats * c` words available.
   - Require the candidate cycle to be **meaningful**: it must use at least two
     distinct tokens, or its single token must contain a letter or digit.
   - Compare the last `c * minRepeats` words against the candidate cycle.
   - If every block matches exactly, a loop is present; return `{ cycleWords: c, repeats }`.
4. Otherwise return `null`.

The meaningful-cycle rule exists because of a real false positive found by sweeping the
whole workbuddy corpus: an ASCII-art dashed rule (`- - - - - - - -`) is a perfect
2-token cycle carrying zero information, and the model draws such rules routinely.
Without the rule the guard cuts legitimate drawing output. A single repeated *word*
(`OK. OK. OK.`) still fires, since it carries meaning.

Complexity is O(tailWords × maxCycleWords) per check in the worst case. With defaults that
is ≤ 96,000 word comparisons per chunk, over a fixed 1200-word window. To keep per-chunk
cost low, detection runs at most once every `checkEveryWords` new words (default 40)
rather than on every chunk.

This algorithm was validated against the real data: it finds all three known loops
(cycles of 10, 14, and 21 words) and reports no false positives at `minRepeats = 4` across
the other 23,568 assistant messages.

It was then re-validated by replaying every workbuddy `text`/`reasoning` part in the
session DB (5,476 parts ≥ 200 chars) through the *streaming* guard in 8-word chunks, which
is how the bridge actually feeds it: 6/6 genuine degenerate loops detected, 0 false
positives, 0 unclassified. The whole-document check alone missed the false positive
because it only appears in the chunked path.

## Which channels are watched

Both `content` and `reasoning_content`, tracked independently. A loop in one channel does
not contaminate the other's buffer. All three observed loops were in reasoning, so
text-only detection would have caught none of them.

## On detection

The bridge stops relaying and terminates the turn:

1. Stop forwarding further chunks.
2. Cancel the upstream reader.
3. End the client response **without** `[DONE]`, so the turn errors out rather than
   appearing to complete successfully.
4. Log a structured warning with `sessionless` context available (cycle length, repeat
   count, channel, model, a short excerpt).

The exact termination primitive (SSE `error` event vs `res.destroy()`) will be decided
during implementation by testing against the live bridge with
`test/live-smoke.js`-style probing, choosing whichever Kilo surfaces most reliably as a
failed turn. The implementation must not send `[DONE]` on a loop.

## Configuration

Environment variables, following the bridge's existing `WB_*` convention:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WB_LOOP_GUARD` | `1` | Enable/disable the guard (`0` disables) |
| `WB_LOOP_MIN_REPEATS` | `8` | Consecutive repeats required to fire |
| `WB_LOOP_MAX_CYCLE_WORDS` | `80` | Longest cycle length considered |
| `WB_LOOP_TAIL_WORDS` | `1200` | Bounded tail buffer size |
| `WB_LOOP_CHECK_EVERY_WORDS` | `40` | Minimum new words between checks |

Invalid or unparseable values fall back to the default and log a warning; the bridge must
never fail to start because of a bad tuning value.

## Error handling

- Detector exceptions are caught and logged; they must never break relaying. A failure in
  detection degrades to "no guard", not "no streaming".
- Detection is skipped entirely when the guard is disabled.
- A guard that has already fired for a stream does not fire again for that stream.

## Testing

`test/loop-detector.test.js`, using the existing `node --test` harness:

- **Positives** — the three verbatim loops extracted from the database (10, 14, and 21
  word cycles), asserted to fire with the correct `cycleWords`.
- **Negatives** — real non-looping output that must not fire: an ASCII-art box table and
  a normal prose message, both taken from the database.
- **Boundaries** — 7 repeats does not fire, 8 fires; a 2-word cycle fires; a cycle at the
  tail-buffer edge fires; a cycle longer than `maxCycleWords` does not fire.
- **Channel independence** — a loop in `reasoning_content` fires while `content` stays
  clean, and vice versa.
- **Configuration** — `WB_LOOP_GUARD=0` disables; a custom `minRepeats` is respected.

`test/translate.test.js` gains an integration test asserting that when a loop is fed
through `relayStream`, the stream is terminated and **no** `[DONE]` is emitted, while a
normal stream still ends with `[DONE]` as before.

## Risks and accepted tradeoffs

1. **Abrupt termination.** Kilo will surface the cut as a turn error rather than a tidy
   stop. Accepted: stopping is the goal, and the user requested this behavior.
2. **Model-specific.** Only workbuddy traffic is protected. If the user switches primary
   models, this guard does not apply. The plugin approach remains the general solution and
   is parked, not discarded.
3. **Possible false positive.** A model legitimately emitting the same 8-line block would
   trip the guard. Mitigated by validating negatives against real data and by exposing
   `WB_LOOP_MIN_REPEATS`.

## Out of scope

- The Kilo plugin implementation (probe remains at
  `~/.config/kilo/plugin/loop-watchdog-probe.ts`; it is inert and only reacts to the
  `@@LOOPPROBE@@` sentinel).
- Any change to `kilo.jsonc`.
- Guarding non-workbuddy providers.
- Detecting loops that are not contiguous tail repetition (e.g. semantically drifting
  repetition).
