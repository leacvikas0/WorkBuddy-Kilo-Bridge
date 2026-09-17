'use strict';

// Per-channel character caps for the continuation prompt. Keeping the quoted
// tail small stops the retry request from carrying the full degenerate text
// back into the model's context (which is what caused the loop in the first
// place) and keeps the retry cheap.
const REASONING_QUOTE_CHARS = 1500;
const CONTENT_QUOTE_CHARS = 1500;

function tail(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(s.length - maxChars);
}

/**
 * Remove trailing repetitions of the degenerate cycle from a quoted tail, so
 * the retry request does not feed the loop text straight back into the model.
 * The cycle length comes from the guard hit; without one, the text is
 * returned unchanged.
 */
function stripTrailingCycle(text, hit) {
  const s = String(text || '');
  const c = hit && Number.isInteger(hit.cycleWords) ? hit.cycleWords : 0;
  if (!s || c < 1) return s;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < c) return s;
  const cycle = words.slice(words.length - c);
  let end = words.length;
  while (end >= c) {
    let matches = true;
    for (let i = 0; i < c; i++) {
      if (words[end - c + i] !== cycle[i]) { matches = false; break; }
    }
    if (!matches) break;
    end -= c;
  }
  if (end === words.length) return s;
  return words.slice(0, end).join(' ');
}

/**
 * Build the request body for a continuation attempt after the loop guard cut
 * a stream. The original body is copied, never mutated: the same request is
 * re-sent with one extra user message that quotes the tail of what the model
 * had already produced and instructs it to stop restating intent and produce
 * the actual output.
 */
function buildContinuationBody(upBody, partial = {}, hit = null) {
  const out = { ...(upBody || {}) };
  const base = Array.isArray(out.messages) ? out.messages : [];
  out.messages = base.slice();

  const parts = [
    '[System notice] Your previous response was cut off because you entered a repetition loop, restating the same intent (for example "let me write...", "let me search...") instead of producing the output.',
    'Do not repeat yourself. Do not restate your intent. Stop thinking about what you are about to do and produce the actual answer or tool call now.',
  ];

  const reasoning = stripTrailingCycle(tail(partial.reasoning, REASONING_QUOTE_CHARS), hit && hit.channel === 'reasoning' ? hit : null).trim();
  if (reasoning) {
    parts.push('Text you had already written in your reasoning before the cut (do not repeat it, continue from it):\n' + reasoning);
  }

  const content = stripTrailingCycle(tail(partial.content, CONTENT_QUOTE_CHARS), hit && hit.channel === 'content' ? hit : null).trim();
  if (content) {
    parts.push('Text you had already written in your answer before the cut (do not repeat it, continue from it):\n' + content);
  }

  parts.push('Continue the task now. Reply directly with the next real step.');

  out.messages.push({ role: 'user', content: parts.join('\n\n') });
  return out;
}

module.exports = { buildContinuationBody };
