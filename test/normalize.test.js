const test = require('node:test');
const assert = require('node:assert');
const {
  ensureSystemFirst,
  buildUpstreamBody,
  normalizeToolChoice,
  normalizeStop,
  FALLBACK_SYSTEM
} = require('../lib/normalize');

test('injects fallback system when missing', () => {
  const out = ensureSystemFirst([{ role: 'user', content: 'hi' }]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, FALLBACK_SYSTEM);
  assert.equal(out[1].role, 'user');
});

test('keeps existing system prompt untouched at front', () => {
  const out = ensureSystemFirst([{ role: 'system', content: 'Kilo rules' }, { role: 'user', content: 'hi' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'Kilo rules');
});

test('empty or invalid array gets fallback system', () => {
  assert.equal(ensureSystemFirst([])[0].role, 'system');
  assert.equal(ensureSystemFirst(null)[0].role, 'system');
  assert.equal(ensureSystemFirst(undefined)[0].role, 'system');
});

test('normalizes multiple developer messages to system and moves first to front', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'Dev rule 1' },
    { role: 'developer', content: 'Dev rule 2' }
  ];
  const out = ensureSystemFirst(messages);
  assert.equal(out.length, 3);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'Dev rule 1');
  assert.equal(out[1].role, 'user');
  assert.equal(out[2].role, 'system');
  assert.equal(out[2].content, 'Dev rule 2');
});

test('normalizes developer messages when system message is already at index 0', () => {
  const messages = [
    { role: 'system', content: 'Base system prompt' },
    { role: 'developer', content: 'Extra developer instruction' },
    { role: 'user', content: 'question' }
  ];
  const out = ensureSystemFirst(messages);
  assert.equal(out.length, 3);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'Base system prompt');
  assert.equal(out[1].role, 'system'); // Must NOT remain 'developer'
  assert.equal(out[1].content, 'Extra developer instruction');
  assert.equal(out[2].role, 'user');
});

test('preserves cache_control tags on system, developer, and user messages', () => {
  const cacheTag = { type: 'ephemeral' };
  const messages = [
    { role: 'developer', content: 'System instruction with cache', cache_control: cacheTag },
    { role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: cacheTag }] }
  ];
  const out = buildUpstreamBody({ messages });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'system');
  assert.deepEqual(out.messages[0].cache_control, cacheTag);
  assert.equal(out.messages[0].content, 'System instruction with cache');
  assert.deepEqual(out.messages[1].content[0].cache_control, cacheTag);
});

test('normalizeToolChoice handles various formats and NEVER returns an object', () => {
  assert.equal(normalizeToolChoice(undefined), undefined);
  assert.equal(normalizeToolChoice(null), undefined);
  assert.equal(normalizeToolChoice('auto'), 'auto');
  assert.equal(normalizeToolChoice('required'), 'required');
  assert.equal(normalizeToolChoice('none'), 'none');
  assert.equal(normalizeToolChoice('calc'), 'calc');

  // OpenAI format
  assert.equal(normalizeToolChoice({ type: 'function', function: { name: 'calc' } }), 'calc');
  assert.equal(normalizeToolChoice({ function: { name: 'calc' } }), 'calc');

  // Vercel AI SDK format
  assert.equal(normalizeToolChoice({ type: 'tool', toolName: 'file_search' }), 'file_search');
  assert.equal(normalizeToolChoice({ tool: { name: 'file_search' } }), 'file_search');
  assert.equal(normalizeToolChoice({ name: 'calc' }), 'calc');

  // Mode objects
  assert.equal(normalizeToolChoice({ type: 'auto' }), 'auto');
  assert.equal(normalizeToolChoice({ type: 'required' }), 'required');
  assert.equal(normalizeToolChoice({ type: 'none' }), 'none');

  // Objects missing function name: must NEVER return an object to upstream
  assert.equal(normalizeToolChoice({ type: 'function' }), 'auto');
  assert.equal(normalizeToolChoice({ type: 'tool' }), 'auto');
  assert.equal(normalizeToolChoice({}), undefined);
  assert.equal(normalizeToolChoice({ unknown: true }), undefined);
});

test('normalizeStop helper handles undefined, strings, arrays, and empty arrays', () => {
  assert.equal(normalizeStop(undefined), undefined);
  assert.equal(normalizeStop(null), undefined);
  assert.deepEqual(normalizeStop('stop'), ['stop']);
  assert.deepEqual(normalizeStop(['a', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeStop(['a', 42, null]), ['a', '42', '']);
  assert.deepEqual(normalizeStop([]), []);
});

test('buildUpstreamBody normalizes max_tokens and max_completion_tokens', () => {
  // max_completion_tokens fallback with legacy 32k expanded to 131072
  const out1 = buildUpstreamBody({
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 32768
  });
  assert.equal(out1.max_tokens, 131072);
  assert.equal(out1.max_completion_tokens, undefined);

  // max_tokens takes precedence
  const out2 = buildUpstreamBody({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16384,
    max_completion_tokens: 32768
  });
  assert.equal(out2.max_tokens, 16384);

  // string numeric conversion to integer and expansion
  const out3 = buildUpstreamBody({
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: '32000'
  });
  assert.equal(out3.max_tokens, 131072);
  assert.strictEqual(typeof out3.max_tokens, 'number');
});

test('buildUpstreamBody forces stream and passes tools through', () => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object', properties: {} } } }];
  const out = buildUpstreamBody({
    model: 'hy4-preview',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    temperature: 0.7,
    top_p: 0.95,
    tools,
    tool_choice: { type: 'function', function: { name: 'read' } },
    stop: '<stop>'
  });
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(out.temperature, 0.7);
  assert.equal(out.top_p, 0.95);
  assert.deepEqual(out.tools, tools);
  assert.equal(out.tool_choice, 'read');
  assert.deepEqual(out.stop, ['<stop>']);
});

test('buildUpstreamBody defaults model and rejects missing messages', () => {
  assert.equal(buildUpstreamBody({ messages: [{ role: 'user', content: 'x' }] }).model, 'hy4-preview');
  assert.throws(() => buildUpstreamBody({}), (e) => e.statusCode === 400);
});

test('normalizeModel handles defaults, aliases, and casing variations', () => {
  const { normalizeModel } = require('../lib/normalize');
  assert.equal(normalizeModel(undefined), 'hy4-preview');
  assert.equal(normalizeModel(''), 'hy4-preview');
  assert.equal(normalizeModel('hy4'), 'hy4-preview');
  assert.equal(normalizeModel('hy4-preview'), 'hy4-preview');
  assert.equal(normalizeModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('Deepseek-V4.1-Flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('deepseek-v4.1'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('deepseek-v41'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('deepseek-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModel('deepseek-v3'), 'deepseek-v3');
  assert.equal(normalizeModel('other-custom-model'), 'other-custom-model');
});

test('normalizeReasoningEffort validates allowed values and strips invalid ones', () => {
  const { normalizeReasoningEffort } = require('../lib/normalize');
  assert.equal(normalizeReasoningEffort('low'), 'low');
  assert.equal(normalizeReasoningEffort('LOW'), 'low');
  assert.equal(normalizeReasoningEffort('medium'), 'medium');
  assert.equal(normalizeReasoningEffort('high'), 'high');
  assert.equal(normalizeReasoningEffort('max'), 'max');
  assert.equal(normalizeReasoningEffort('none'), undefined);
  assert.equal(normalizeReasoningEffort('unknown'), undefined);
  assert.equal(normalizeReasoningEffort(null), undefined);
});

test('buildUpstreamBody wires reasoning_effort, thinking, and budget_tokens', () => {
  const out = buildUpstreamBody({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hello' }],
    reasoning_effort: 'high',
    thinking: { type: 'enabled' },
    budget_tokens: 2048
  });
  assert.equal(out.reasoning_effort, 'high');
  assert.deepEqual(out.thinking, { type: 'enabled' });
  assert.equal(out.budget_tokens, 2048);
});