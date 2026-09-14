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
