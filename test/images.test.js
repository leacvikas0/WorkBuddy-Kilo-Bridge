const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  optimizeMessageImages,
  compressImageBuffer,
  parseDataUri
} = require('../lib/images');

// 1x1 red PNG
const TINY_RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('parseDataUri parses valid base64 data uri', () => {
  const parsed = parseDataUri(TINY_RED_PNG);
  assert(parsed !== null);
  assert.equal(parsed.mime, 'image/png');
  assert(Buffer.isBuffer(parsed.buffer));
  assert(parsed.buffer.length > 0);
});

test('parseDataUri returns null on invalid uri', () => {
  assert.equal(parseDataUri('https://example.com/test.png'), null);
  assert.equal(parseDataUri('not a uri'), null);
  assert.equal(parseDataUri(null), null);
  assert.equal(parseDataUri(undefined), null);
});

test('optimizeMessageImages returns untouched array when no images present', async () => {
  const msgs = [
    { role: 'system', content: 'hello' },
    { role: 'user', content: 'hi' }
  ];
  const out = await optimizeMessageImages(msgs);
  assert.deepEqual(out, msgs);
});

test('optimizeMessageImages compresses active images and preserves structure', async () => {
  const msgs = [
    { role: 'system', content: 'System prompt' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image' },
        { type: 'image_url', image_url: { url: TINY_RED_PNG } }
      ]
    }
  ];

  const out = await optimizeMessageImages(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
  assert.equal(out[1].content.length, 2);
  assert.equal(out[1].content[0].type, 'text');
  assert.equal(out[1].content[1].type, 'image_url');
  assert(out[1].content[1].image_url.url.startsWith('data:image/'));
});

test('optimizeMessageImages preserves all images in context without omitting', async () => {
  // Create 5 messages each with an image
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_RED_PNG } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_RED_PNG } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_RED_PNG } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_RED_PNG } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_RED_PNG } }] }
  ];

  const out = await optimizeMessageImages(msgs);
  assert.equal(out.length, 6);

  // All 5 images MUST be preserved as image_url, none omitted
  for (let i = 1; i <= 5; i++) {
    assert.equal(out[i].content[0].type, 'image_url');
    assert(out[i].content[0].image_url.url.startsWith('data:image/'));
  }
});

test('compressImageBuffer drastically reduces large PNG buffer', async () => {
  const imgPath = process.env.WB_TEST_IMAGE;
  if (imgPath && fs.existsSync(imgPath)) {
    const rawBuf = fs.readFileSync(imgPath);
    const compressedUri = await compressImageBuffer(rawBuf);
    assert(compressedUri !== null);
    assert(compressedUri.startsWith('data:image/jpeg;base64,'));
    const parsed = parseDataUri(compressedUri);
    assert(parsed.buffer.length < rawBuf.length * 0.2, 'Expected at least 80% reduction');
  }
});

test('optimizeMessageImages prunes raw base64 data URIs from tool messages and arguments', async () => {
  const fakeLargeDataUri = 'data:image/png;base64,' + 'A'.repeat(5000);
  const msgs = [
    {
      role: 'assistant',
      content: 'Calling image edit',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'edit_image',
          arguments: JSON.stringify({ image: fakeLargeDataUri })
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: JSON.stringify({ status: 'ok', attachments: [{ url: fakeLargeDataUri }] })
    }
  ];

  const out = await optimizeMessageImages(msgs);
  assert(!out[0].tool_calls[0].function.arguments.includes(fakeLargeDataUri));
  assert(out[0].tool_calls[0].function.arguments.includes('omitted'));
  assert(!out[1].content.includes(fakeLargeDataUri));
  assert(out[1].content.includes('omitted'));
});

test('optimizeMessageImages sanitizes non-URL and pruned strings into text to prevent 11133', async () => {
  const msgs = [
    {
      role: 'tool',
      tool_call_id: 'call_pruned',
      content: [
        { type: 'text', text: 'Result' },
        { type: 'image_url', image_url: { url: '[Pruned base64 image data]' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: '' } },
        { type: 'image_url', image_url: { url: 'C:\\nonexistent\\image.png' } }
      ]
    }
  ];

  const out = await optimizeMessageImages(msgs);
  assert.equal(out[0].content[1].type, 'text');
  assert(out[0].content[1].text.includes('[Attachment: [Pruned base64 image data]]'));

  assert.equal(out[1].content[0].type, 'text');
  assert(out[1].content[0].text.includes('empty'));

  assert.equal(out[1].content[1].type, 'text');
  assert(out[1].content[1].text.includes('Attachment'));
});


