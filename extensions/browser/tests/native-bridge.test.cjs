'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNativeMessagingBridge, MAX_NATIVE_MESSAGE_BYTES } = require('../../../electron/plugin-bridge.cjs');

const secretValue = '8'.repeat(64);
const extensionOrigin = 'chrome-extension://gdiemkjipojgcalgibamhjaffbbnpfco/';
const nativeHostPath = path.resolve(__dirname, '../../../backend/dist/folio-browser-native-host.exe');

function encodeFrame(value) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}

class FrameReader {
  constructor(stream, writer = stream) {
    this.stream = stream;
    this.writer = writer;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    stream.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size > MAX_NATIVE_MESSAGE_BYTES) throw new Error('frame too large');
        if (this.buffer.length < size + 4) return;
        const frame = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(size + 4);
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  next(timeoutMs = 5000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('native frame response timed out')), timeoutMs);
      this.waiters.push((frame) => { clearTimeout(timeout); resolve(frame); });
    });
  }

  async request(value) {
    const result = this.next();
    this.writer.write(encodeFrame(value));
    return result;
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fakeBackend(t) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/folders') {
      response.end(JSON.stringify([{ id: 'folder-1', name: 'Papers' }]));
    } else if (url.pathname === '/literature/stable-record-42' && request.method === 'GET') {
      response.end(JSON.stringify({ id: 'stable-record-42', title: 'Fresh library record', citations: { apa: { confirmed: true, stale: false } } }));
    } else if (url.pathname === '/literature' && request.method === 'GET') {
      response.end(JSON.stringify({ items: [], total: 0 }));
    } else if (url.pathname === '/literature/capture' && request.method === 'POST') {
      const csl = { ...body.csl, id: 'stable-record-42' };
      response.end(JSON.stringify({
        item: { id: 'stable-record-42', csl },
        pdf_import: { status: body.pdf_content_base64 ? 'imported' : 'not_requested' },
      }));
    } else if (url.pathname === '/literature/preview' && request.method === 'POST') {
      response.end(JSON.stringify({
        style: body.style,
        citation_text: 'Stable citation for ' + body.record.id,
        bibliography_text: 'Stable bibliography for ' + body.record.id,
        fingerprint: 'a'.repeat(64),
      }));
    } else if (url.pathname === '/literature/stable-record-42/citations' && request.method === 'POST') {
      response.end(JSON.stringify({ confirmed: true, style: body.style, fingerprint: body.fingerprint }));
    } else if (url.pathname === '/literature/render-document' && request.method === 'POST') {
      response.end(JSON.stringify({ style: body.style, citations: {}, citation_order: [], bibliography: { entries: [] } }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: 'not found' }));
    }
  });
  const base = await listen(server);
  t.after(() => close(server));
  return { base, calls };
}

async function connect(pipeName) {
  const socket = net.createConnection(pipeName);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { socket, reader: new FrameReader(socket) };
}

function makeBridge(t, backend, suffix = 'direct') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-native-bridge-'));
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\folio-test-${process.pid}-${suffix}-${Date.now()}`
    : path.join(directory, 'bridge.sock');
  const secretPath = path.join(directory, 'browser-bridge.secret');
  fs.writeFileSync(secretPath, secretValue + '\n');
  const bridge = createNativeMessagingBridge({
    getBackendBase: () => backend.base,
    getBackendToken: () => 'internal-backend-token',
    pipeName,
    secretPath,
  });
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { bridge, pipeName, secretPath };
}

test('native pipe requires the per-user secret and restricts backend RPCs', async (t) => {
  const backend = await fakeBackend(t);
  const { bridge, pipeName } = makeBridge(t, backend);
  await bridge.start();

  const denied = await connect(pipeName);
  const rejected = await denied.reader.request({ id: 'bad-auth', type: 'FOLIO_NATIVE_AUTH', secret: '0'.repeat(64) });
  assert.equal(rejected.id, 'bad-auth');
  assert.equal(rejected.status, 403);
  denied.socket.destroy();
  assert.equal(backend.calls.length, 0);

  const client = await connect(pipeName);
  const auth = await client.reader.request({ id: 'native-auth', type: 'FOLIO_NATIVE_AUTH', secret: secretValue });
  assert.deepEqual(auth.result, { authenticated: true });
  assert.equal(auth.id, 'native-auth');

  const folders = await client.reader.request({ id: 1, type: 'FOLIO_FOLDERS' });
  assert.deepEqual(folders.result, [{ id: 'folder-1', name: 'Papers' }]);
  assert.equal(backend.calls.at(-1).authorization, 'Bearer internal-backend-token');

  const current = await client.reader.request({ id: 9, type: 'FOLIO_GET_RECORD', recordId: 'stable-record-42' });
  assert.equal(current.result.id, 'stable-record-42');
  assert.equal(current.result.citations.apa.confirmed, true);
  assert.equal(backend.calls.at(-1).url, '/literature/stable-record-42');

  const search = await client.reader.request({
    id: 2, type: 'FOLIO_SEARCH', query: 'quartz', folderId: 'folder-1', confirmedStyle: 'apa',
  });
  assert.deepEqual(search.result, { items: [], total: 0 });
  assert.equal(backend.calls.at(-1).url, '/literature?q=quartz&folder_id=folder-1&confirmed_style=apa');

  const begin = await client.reader.request({
    id: 3,
    type: 'FOLIO_CAPTURE_BEGIN',
    folderId: 'folder-1',
    item: {
      title: 'Pipe round trip', authors: [{ given: 'Ada', family: 'Lovelace' }],
      year: 2026, doi: '10.5555/folio.42', item_type: 'journal-article',
      csl: { type: 'article-journal', title: 'Pipe round trip', author: [{ given: 'Ada', family: 'Lovelace' }] },
    },
  });
  assert.ok(begin.result.captureId);
  const pdfBase64 = Buffer.from('%PDF-1.7\nfixture', 'utf8').toString('base64');
  const chunk = await client.reader.request({
    id: 4, type: 'FOLIO_CAPTURE_PDF_CHUNK', captureId: begin.result.captureId, index: 0, chunk: pdfBase64,
  });
  assert.deepEqual(chunk.result, { received: 1 });
  const captured = await client.reader.request({
    id: 5, type: 'FOLIO_CAPTURE_FINISH', captureId: begin.result.captureId, pdfName: 'fixture.pdf',
  });
  assert.equal(captured.result.item.id, 'stable-record-42');
  const captureCall = backend.calls.find((call) => call.url === '/literature/capture');
  assert.equal(Buffer.from(captureCall.body.pdf_content_base64, 'base64').toString('utf8'), '%PDF-1.7\nfixture');
  assert.equal(captureCall.body.folder_id, 'folder-1');

  const preview = await client.reader.request({
    id: 6, type: 'FOLIO_PREVIEW', style: 'apa', record: captured.result.item.csl,
  });
  assert.equal(preview.result.fingerprint, 'a'.repeat(64));
  assert.equal(backend.calls.at(-1).body.record.id, 'stable-record-42');
  const confirmation = await client.reader.request({
    id: 7, type: 'FOLIO_CONFIRM', recordId: 'stable-record-42', style: 'apa', fingerprint: preview.result.fingerprint,
  });
  assert.equal(confirmation.result.confirmed, true);
  assert.equal(backend.calls.at(-1).url, '/literature/stable-record-42/citations');

  const invalidRender = await client.reader.request({
    id: 8, type: 'FOLIO_RENDER_DOCUMENT', style: 'apa',
    state: { version: 1, items: { item1: { id: 'other-id' } }, citations: [] },
  });
  assert.equal(invalidRender.ok, false);
  assert.equal(invalidRender.status, 422);
  client.socket.destroy();
});

test('packaged native host bridges real stdin frames to an isolated Folio pipe', {
  skip: process.platform !== 'win32' || !fs.existsSync(nativeHostPath),
}, async (t) => {
  const backend = await fakeBackend(t);
  const { bridge, pipeName, secretPath } = makeBridge(t, backend, 'host');
  await bridge.start();
  const child = spawn(nativeHostPath, [
    extensionOrigin,
    '--folio-test-pipe=' + pipeName,
    '--folio-test-secret=' + secretPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const reader = new FrameReader(child.stdout, child.stdin);
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  t.after(async () => {
    child.stdin.destroy();
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  const status = await reader.request({ id: 1, type: 'FOLIO_STATUS' }).catch((error) => {
    throw new Error(`${error.message}; native host exit=${child.exitCode}; stderr=${Buffer.concat(stderr).toString('utf8')}`);
  });
  assert.equal(status.id, 1);
  assert.equal(status.result.connected, true);

  const begin = await reader.request({
    id: 2, type: 'FOLIO_CAPTURE_BEGIN', folderId: 'folder-1',
    item: {
      title: 'Host round trip', authors: [], year: 2026, doi: '10.5555/folio.host',
      item_type: 'article', csl: { type: 'article-journal', id: 'candidate', title: 'Host round trip' },
    },
  });
  const pdfBase64 = Buffer.from('%PDF-1.7\nhost fixture', 'utf8').toString('base64');
  await reader.request({ id: 3, type: 'FOLIO_CAPTURE_PDF_CHUNK', captureId: begin.result.captureId, index: 0, chunk: pdfBase64 });
  const capture = await reader.request({ id: 4, type: 'FOLIO_CAPTURE_FINISH', captureId: begin.result.captureId, pdfName: 'host.pdf' });
  assert.equal(capture.result.item.id, 'stable-record-42');
  const preview = await reader.request({ id: 5, type: 'FOLIO_PREVIEW', style: 'apa', record: capture.result.item.csl });
  const confirm = await reader.request({
    id: 6, type: 'FOLIO_CONFIRM', recordId: 'stable-record-42', style: 'apa', fingerprint: preview.result.fingerprint,
  });
  assert.equal(confirm.result.confirmed, true);
  assert.equal(backend.calls.find((call) => call.url === '/literature/capture').body.pdf_name, 'host.pdf');
  assert.equal(backend.calls.filter((call) => call.url === '/literature/stable-record-42/citations').length, 1);

  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString('utf8') || `native host exited ${code}`)));
  });
});
