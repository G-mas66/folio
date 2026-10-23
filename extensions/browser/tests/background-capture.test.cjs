'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function createBackground(disconnectReason = '') {
  const runtimeListeners = [];
  const nativeMessages = [];
  let nativeMessageListener;
  let nativeDisconnectListener;
  const nativePort = {
    onMessage: { addListener(listener) { nativeMessageListener = listener; } },
    onDisconnect: { addListener(listener) { nativeDisconnectListener = listener; } },
    postMessage(message) {
      nativeMessages.push(message);
      if (disconnectReason) {
        queueMicrotask(() => {
          chrome.runtime.lastError = { message: disconnectReason };
          nativeDisconnectListener();
          delete chrome.runtime.lastError;
        });
        return;
      }
      const results = {
        FOLIO_STATUS: { connected: true },
        FOLIO_CAPTURE_BEGIN: { captureId: 'capture-1' },
        FOLIO_CAPTURE_PDF_CHUNK: { received: 1 },
        FOLIO_CAPTURE_FINISH: { item: { id: 'record-1' }, pdf_import: { status: 'imported' } },
        FOLIO_CAPTURE: { item: { id: 'record-1' } },
      };
      queueMicrotask(() => nativeMessageListener({ id: message.id, ok: true, result: results[message.type] }));
    },
  };
  const chrome = {
    runtime: {
      id: 'extension-id',
      getURL: (file) => 'chrome-extension://extension-id/' + file,
      connectNative: () => nativePort,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
    },
    permissions: { contains: async () => true },
  };
  const context = {
    chrome,
    FolioCapture: require('../shared.js'),
    importScripts() {},
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'), context);
  return { listener: runtimeListeners[0], nativeMessages };
}

function send(listener, message) {
  return new Promise((resolve) => {
    listener(message, { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' }, resolve);
  });
}

test('background validates page-context PDF bytes before sending native chunks', async () => {
  const { listener, nativeMessages } = createBackground();
  await new Promise((resolve) => setTimeout(resolve, 0));
  nativeMessages.length = 0;

  const pdfBase64 = Buffer.from('%PDF-1.7\nfixture', 'utf8').toString('base64');
  const imported = await send(listener, {
    type: 'FOLIO_CAPTURE', fetchPdf: true, pdfUrl: 'https://publisher.example/paper.pdf',
    pdfBase64, item: { title: 'Page capture', csl: {} }, folderId: 'folder-1',
  });
  assert.equal(imported.result.pdf_import.status, 'imported');
  assert.deepEqual(Array.from(nativeMessages, ({ type }) => type), [
    'FOLIO_CAPTURE_BEGIN', 'FOLIO_CAPTURE_PDF_CHUNK', 'FOLIO_CAPTURE_FINISH',
  ]);
  assert.equal(nativeMessages[1].chunk, pdfBase64);

  nativeMessages.length = 0;
  const rejected = await send(listener, {
    type: 'FOLIO_CAPTURE', fetchPdf: true, pdfUrl: 'https://publisher.example/paper.pdf',
    pdfBase64: Buffer.from('<html>login</html>').toString('base64'),
    item: { title: 'Page capture', csl: {} }, folderId: 'folder-1',
  });
  assert.equal(rejected.result.pdf_import.status, 'failed');
  assert.deepEqual(Array.from(nativeMessages, ({ type }) => type), ['FOLIO_CAPTURE']);
});

test('forbidden native connection explains extension identity repair to the popup', async () => {
  const { listener } = createBackground('Access to the specified native messaging host is forbidden.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = await send(listener, { type: 'FOLIO_STATUS' });
  assert.equal(response.ok, false);
  assert.match(response.error, /浏览器未获准连接 Folio/);
  assert.match(response.error, /扩展 ID：extension-id/);
  assert.match(response.error, /更新并重启 Folio/);
});
