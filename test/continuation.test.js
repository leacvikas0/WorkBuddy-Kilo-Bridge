const test = require('node:test');
const assert = require('node:assert');
const { buildContinuationBody } = require('../lib/continuation');

test('buildContinuationBody appends one user message and preserves the rest of the body', () => {
  const upBody = {
    model: 'm',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    max_tokens: 5,
    tools: [{ type: 'function' }],
  };
  const out = buildContinuationBody(upBody, { reasoning: 'thinking hard', content: 'partial answer' });
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[0], { role: 'system', content: 's' });
  assert.deepEqual(out.messages[1], { role: 'user', content: 'u' });
  assert.equal(out.messages[2].role, 'user');
  assert.match(out.messages[2].content, /thinking hard/);
  assert.match(out.messages[2].content, /partial answer/);
  assert.equal(out.model, 'm');
  assert.equal(out.max_tokens, 5);
  assert.deepEqual(out.tools, upBody.tools);
  assert.equal(upBody.messages.length, 2, 'must not mutate the input body');
});

test('buildContinuationBody tells the model to continue without repeating', () => {
  const out = buildContinuationBody({ messages: [] }, { reasoning: 'r' });
  assert.match(out.messages[0].content, /repeat/i);
  assert.match(out.messages[0].content, /continue/i);
});

test('buildContinuationBody caps quoted text and omits empty channels', () => {
  const out = buildContinuationBody({ messages: [] }, { reasoning: 'R'.repeat(5000), content: '' });
  const msg = out.messages[0].content;
  assert.ok(msg.length < 5000, 'quoted reasoning must be capped');
  assert.equal(msg.includes('text you had already written'), false);
});

test('buildContinuationBody tolerates missing messages and partial output', () => {
  const out = buildContinuationBody({ model: 'm' }, {});
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
  const out2 = buildContinuationBody({ messages: [] });
  assert.equal(out2.messages.length, 1);
});

test('buildContinuationBody strips the degenerate cycle from the quoted tail', () => {
  const cycle = ['Let', 'me', 'write.'];
  const words = ['I', 'will', 'now', 'edit', 'the', 'file.'];
  for (let i = 0; i < 10; i++) words.push(...cycle);
  const out = buildContinuationBody(
    { messages: [] },
    { reasoning: words.join(' ') + ' ' },
    { channel: 'reasoning', cycleWords: 3, repeats: 8 }
  );
  const msg = out.messages[0].content;
  assert.ok(msg.includes('edit the file'), 'real prior text must be quoted');
  const occurrences = (msg.match(/Let me write\./g) || []).length;
  assert.ok(occurrences <= 2, `cycle must be stripped from the quote, found ${occurrences} repeats`);
});

test('buildContinuationBody leaves the other channel untouched when stripping', () => {
  const cycle = ['Let', 'me', 'write.'];
  const looped = [];
  for (let i = 0; i < 10; i++) looped.push(...cycle);
  const out = buildContinuationBody(
    { messages: [] },
    { reasoning: looped.join(' ') + ' ', content: 'real answer text' },
    { channel: 'reasoning', cycleWords: 3, repeats: 8 }
  );
  assert.match(out.messages[0].content, /real answer text/);
});
