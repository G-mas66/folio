'use strict';

var assert = require('node:assert/strict');
var EventEmitter = require('node:events');
var fs = require('node:fs');
var http = require('node:http');
var os = require('node:os');
var path = require('node:path');
var PassThrough = require('node:stream').PassThrough;
var test = require('node:test');
var wordHost = require('../server.cjs');

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(function (resolve, reject) {
    server.close(function (error) { if (error) reject(error); else resolve(); });
  });
}

function get(port, requestPath, method, headers) {
  return new Promise(function (resolve, reject) {
    var request = http.request({ host: '127.0.0.1', port: port, path: requestPath, method: method || 'GET', headers: headers || {} }, function (response) {
      var chunks = [];
      response.on('data', function (chunk) { chunks.push(chunk); });
      response.on('end', function () {
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function installUpstreamMock(body, contentLength, behavior) {
  var originalRequest = http.request;
  var requests = [];
  var destroyCount = 0;
  http.request = function (options, callback) {
    if (Number(options.port) !== 37861) return originalRequest.apply(http, arguments);
    requests.push(options);
    var upstream = new EventEmitter();
    upstream.setTimeout = function (_milliseconds, onTimeout) {
      if (behavior === 'timeout') process.nextTick(onTimeout);
    };
    upstream.end = function () {
      if (behavior === 'timeout' || behavior === 'pending') return;
      var result = new PassThrough();
      result.statusCode = 200;
      result.headers = { 'content-type': 'application/json; charset=utf-8' };
      if (contentLength !== undefined) result.headers['content-length'] = String(contentLength);
      callback(result);
      process.nextTick(function () { result.end(body); });
    };
    upstream.destroy = function (error) {
      destroyCount += 1;
      if (error) process.nextTick(function () { upstream.emit('error', error); });
    };
    return upstream;
  };
  return {
    requests: requests,
    get destroyCount() { return destroyCount; },
    restore: function () { http.request = originalRequest; }
  };
}

test('host status reports prepared files without asserting OS trust', function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-status-'));
  try {
    var assets = path.join(temp, 'dist');
    var certs = path.join(temp, 'certs');
    fs.mkdirSync(path.join(assets, 'styles'), { recursive: true });
    fs.mkdirSync(certs);
    fs.writeFileSync(path.join(assets, 'taskpane.html'), 'ok');
    fs.writeFileSync(path.join(assets, 'taskpane.js'), 'ok');
    fs.writeFileSync(path.join(certs, 'localhost.pfx'), 'test');
    fs.writeFileSync(path.join(certs, 'localhost.password'), 'test');
    fs.writeFileSync(path.join(certs, 'localhost.trusted'), 'test');

    var status = wordHost.getWordHostStatus({ assetsRoot: assets, certDir: certs });
    assert.equal(status.state, 'ready');
    assert.match(status.message, /trust store is not checked/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('local host serves assets and rejects unsupported relay methods and queries', async function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-assets-'));
  var assets = path.join(temp, 'dist');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'taskpane.html'), '<main>Folio</main>');
  var server = http.createServer(wordHost.createHandler({ assetsRoot: assets, bridgeUrl: new URL('http://127.0.0.1:37861') }));
  var port = await listen(server);
  try {
    var page = await get(port, '/taskpane.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.body, '<main>Folio</main>');

    var head = await get(port, '/taskpane.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');

    var method = await get(port, '/bridge/v1/literature', 'POST');
    assert.equal(method.status, 405);
    assert.deepEqual(JSON.parse(method.body), { error: 'method_not_allowed' });

    var token = await get(port, '/bridge/v1/literature?q=alpha');
    assert.equal(token.status, 401);
    var query = await get(port, '/bridge/v1/literature?q=alpha&path=%2Fv1%2Ffolders', 'GET', { Authorization: 'Bearer plugin-token' });
    assert.equal(query.status, 400);
    var traversal = await get(port, '/..%5cserver.cjs');
    assert.equal(traversal.status, 403);
  } finally {
    await close(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('literature relay forwards only the fixed query and caps response size', async function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-relay-'));
  var assets = path.join(temp, 'dist');
  fs.mkdirSync(assets);
  var server = http.createServer(wordHost.createHandler({ assetsRoot: assets, bridgeUrl: new URL('http://127.0.0.1:37861') }));
  var port = await listen(server);
  var mock = installUpstreamMock('{"items":[],"total":0}');
  try {
    var result = await get(port, '/bridge/v1/literature?q=Alpha%20%26%20Beta', 'GET', { Authorization: 'Bearer plugin-token' });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { items: [], total: 0 });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].path, '/v1/literature?q=Alpha%20%26%20Beta');
    assert.equal(mock.requests[0].method, 'GET');
    assert.equal(mock.requests[0].headers.Authorization, 'Bearer plugin-token');

    mock.restore();
    mock = installUpstreamMock('ignored', wordHost.MAX_RELAY_RESPONSE_BYTES + 1);
    var large = await get(port, '/bridge/v1/literature?q=alpha', 'GET', { Authorization: 'Bearer plugin-token' });
    assert.equal(large.status, 502);
    assert.deepEqual(JSON.parse(large.body), { error: 'folio_response_too_large' });
  } finally {
    mock.restore();
    await close(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('literature relay times out and cancels an upstream after client disconnect', async function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-timeout-'));
  var assets = path.join(temp, 'dist');
  fs.mkdirSync(assets);
  var server = http.createServer(wordHost.createHandler({ assetsRoot: assets, bridgeUrl: new URL('http://127.0.0.1:37861') }));
  var port = await listen(server);
  var mock = installUpstreamMock('', undefined, 'timeout');
  try {
    var timeout = await get(port, '/bridge/v1/literature?q=alpha', 'GET', { Authorization: 'Bearer plugin-token' });
    assert.equal(timeout.status, 504);
    assert.deepEqual(JSON.parse(timeout.body), { error: 'folio_bridge_timeout' });
    mock.restore();

    mock = installUpstreamMock('', undefined, 'pending');
    var request = http.request({ host: '127.0.0.1', port: port, path: '/bridge/v1/literature?q=alpha', headers: { Authorization: 'Bearer plugin-token' } });
    request.on('error', function () {});
    request.end();
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    request.destroy();
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    assert.equal(mock.destroyCount, 1);
  } finally {
    mock.restore();
    await close(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('static asset stream errors receive a server error response', async function () {
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-stream-'));
  var assets = path.join(temp, 'dist');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'taskpane.js'), 'placeholder');
  var server = http.createServer(wordHost.createHandler({ assetsRoot: assets, bridgeUrl: new URL('http://127.0.0.1:37861') }));
  var port = await listen(server);
  var originalCreateReadStream = fs.createReadStream;
  try {
    fs.createReadStream = function () {
      var stream = new EventEmitter();
      process.nextTick(function () { stream.emit('error', new Error('read failed')); });
      return stream;
    };
    var result = await get(port, '/taskpane.js');
    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(result.body), { error: 'asset_unavailable' });
  } finally {
    fs.createReadStream = originalCreateReadStream;
    await close(server);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
