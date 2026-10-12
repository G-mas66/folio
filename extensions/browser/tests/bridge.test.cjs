'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPluginBridge } = require('../../../electron/plugin-bridge.cjs');

const wordOrigin = 'https://localhost:37862';
const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);

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

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fakeBackend(t) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = request.method === 'POST' ? await jsonBody(request) : undefined;
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/literature?q=') && request.method === 'GET') {
      response.end(JSON.stringify({ items: [{ id: 'r1' }], total: 1 }));
    } else if (request.url === '/folders' && request.method === 'GET') {
      response.end(JSON.stringify([{ id: 'folder1', name: 'Papers' }]));
    } else if (request.url === '/literature/capture' && request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({ item: { id: 'r2' }, pdf_import: { status: 'not_requested' } }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: 'not found' }));
    }
  });
  const base = await listen(server);
  t.after(() => close(server));
  return { base, calls };
}

function bridgeFixture(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-plugin-bridge-'));
  const bridge = createPluginBridge({ dataDir, ...options });
  t.after(async () => {
    await bridge.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return bridge;
}

function requestUrl(bridge, route) {
  return 'http://127.0.0.1:' + bridge.getStatus().port + route;
}

function headers(token = '') {
  return {
    Origin: wordOrigin,
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

test('bridge enforces its route, origin, token, and capture-field allowlists', async (t) => {
  const backend = await fakeBackend(t);
  const bridge = bridgeFixture(t, {
    getBackendBase: () => backend.base,
    getBackendToken: () => 'internal-session-token',
    port: 0,
  });
  await bridge.start();
  const health = await fetch(requestUrl(bridge, '/health'), { headers: headers() });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), wordOrigin);

  const unauthorized = await fetch(requestUrl(bridge, '/v1/folders'), { headers: headers() });
  assert.equal(unauthorized.status, 401);

  const token = bridge.getToken();
  const folders = await fetch(requestUrl(bridge, '/v1/folders'), { headers: headers(token) });
  assert.deepEqual(await folders.json(), [{ id: 'folder1', name: 'Papers' }]);
  assert.equal(backend.calls[0].authorization, 'Bearer internal-session-token');

  const search = await fetch(requestUrl(bridge, '/v1/literature?q=quartz'), { headers: headers(token) });
  assert.deepEqual(await search.json(), { items: [{ id: 'r1' }], total: 1 });

  const capture = await fetch(requestUrl(bridge, '/v1/capture'), {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'A paper',
      item_type: 'journal-article',
      volume: '10',
      issue: '2',
      pages: '12-20',
    }),
  });
  assert.equal(capture.status, 201);
  assert.equal(backend.calls.at(-1).body.item_type, 'journal-article');
  assert.equal(backend.calls.at(-1).body.pages, '12-20');

  const callsBeforeInvalid = backend.calls.length;
  const invalid = await fetch(requestUrl(bridge, '/v1/capture'), {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'A paper', target: 'http://127.0.0.1:9/admin' }),
  });
  assert.equal(invalid.status, 422);
  assert.equal(backend.calls.length, callsBeforeInvalid);

  const arbitraryPath = await fetch(requestUrl(bridge, '/v1/admin'), { headers: headers(token) });
  assert.equal(arbitraryPath.status, 404);
  const badOrigin = await fetch(requestUrl(bridge, '/v1/folders'), {
    headers: { Origin: 'https://attacker.example', Authorization: 'Bearer ' + token },
  });
  assert.equal(badOrigin.status, 403);
  const extensionOriginResponse = await fetch(requestUrl(bridge, '/v1/folders'), {
    headers: { Origin: extensionOrigin, Authorization: 'Bearer ' + token },
  });
  assert.equal(extensionOriginResponse.status, 403);
  const noToken = await fetch(requestUrl(bridge, '/v1/folders'));
  assert.equal(noToken.status, 401);

  const replacement = bridge.rotateToken();
  assert.notEqual(replacement, token);
  assert.equal((await fetch(requestUrl(bridge, '/v1/folders'), { headers: headers(token) })).status, 401);
  assert.equal((await fetch(requestUrl(bridge, '/v1/folders'), { headers: headers(replacement) })).status, 200);
});

test('stop aborts a pending proxy and start-stop startup races leave no listener', async (t) => {
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let aborted = false;
  const bridge = bridgeFixture(t, {
    getBackendBase: () => 'http://127.0.0.1:4444',
    getBackendToken: () => 'internal-session-token',
    port: 0,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
      notifyStarted();
    }),
  });
  await bridge.start();
  const request = fetch(requestUrl(bridge, '/v1/folders'), { headers: headers(bridge.getToken()) }).catch(() => null);
  await started;
  const start = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - start < 1500);
  assert.equal(aborted, true);
  assert.equal(bridge.getStatus().running, false);
  await request;

  const pendingStart = bridge.start();
  const pendingStop = bridge.stop();
  await Promise.all([pendingStart, pendingStop]);
  assert.equal(bridge.getStatus().running, false);
  const restarted = await bridge.start();
  assert.equal(restarted.running, true);
  await bridge.stop();
});
