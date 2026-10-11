const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const start = source.indexOf('function sendChatEvent(stream, type, data) {');
const end = source.indexOf('\nfunction startChatStream(', start);
assert.notEqual(start, -1, 'chat stream helpers should exist in electron/main.cjs');
assert.notEqual(end, -1, 'chat stream helpers should end before startChatStream');

const context = {
  backendBase: 'http://127.0.0.1:9000',
  backendToken: 'test-token',
  chatStreams: new Map(),
  fetch: null,
  TextDecoder,
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.consumeChatStream = consumeChatStream;`, context);

let nextId = 0;
async function runCase(fetchImpl) {
  const requestId = `request-${++nextId}`;
  const events = [];
  const stream = {
    requestId,
    controller: new AbortController(),
    buffer: '',
    ended: false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel, event) => events.push(JSON.parse(JSON.stringify(event))),
    },
  };
  context.fetch = fetchImpl;
  context.chatStreams.set(requestId, stream);
  await context.consumeChatStream(stream, '/papers/paper/chat/stream', { question: 'draft' });
  assert.equal(context.chatStreams.has(requestId), false, 'finished stream should be removed');
  assert.equal(stream.ended, true, 'error event should terminate the stream');
  assert.equal(events.length, 1, 'each failure should emit one terminal event');
  return events[0];
}

async function main() {
  const rejected = await runCase(async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: { category: 'validation_error', message: 'Question was rejected.' } }),
  }));
  assert.equal(rejected.type, 'error');
  assert.equal(rejected.data.category, 'validation_error');
  assert.equal(rejected.data.request_rejected, true, 'HTTP 422 must signal that the request was rejected');

  const networkError = await runCase(async () => { throw new Error('offline'); });
  assert.equal(networkError.data.category, 'network');
  assert.equal(Object.hasOwn(networkError.data, 'request_rejected'), false, 'network errors must not signal request rejection');

  const serverError = await runCase(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ detail: { category: 'service_error', message: 'Unavailable.' } }),
  }));
  assert.equal(serverError.data.category, 'service_error');
  assert.equal(serverError.data.request_rejected, false, 'HTTP 5xx must not signal request rejection');

  const incomplete = await runCase(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }));
  assert.equal(incomplete.data.category, 'incomplete_response');
  assert.equal(Object.hasOwn(incomplete.data, 'request_rejected'), false, 'incomplete streams must not signal request rejection');

  console.log('Passed: only HTTP 4xx errors mark the chat request as rejected.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
