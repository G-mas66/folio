'use strict';

var fs = require('fs');
var http = require('http');
var https = require('https');
var os = require('os');
var path = require('path');
var URL = require('url').URL;
var MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
var RELAY_TIMEOUT_MS = 5000;

function defaultCertDir() {
  var base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'FolioWordAddin');
}
function resolveOptions(options) {
  options = options || {};
  var bridge = new URL(options.bridgeUrl || 'http://127.0.0.1:37861');
  if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || bridge.port !== '37861' || (bridge.pathname !== '/' && bridge.pathname !== '')) {
    throw new Error('Word host relay only accepts http://127.0.0.1:37861.');
  }
  return {
    assetsRoot: path.resolve(options.assetsRoot || path.join(__dirname, 'dist')),
    certDir: path.resolve(options.certDir || defaultCertDir()),
    bridgeUrl: bridge,
    port: options.port || 37862,
    host: '127.0.0.1'
  };
}
function getWordHostStatus(options) {
  var resolved = resolveOptions(options);
  var pfxPath = path.join(resolved.certDir, 'localhost.pfx');
  var passwordPath = path.join(resolved.certDir, 'localhost.password');
  var trustedPath = path.join(resolved.certDir, 'localhost.trusted');
  var status = {
    url: 'https://localhost:' + resolved.port + '/taskpane.html',
    certDir: resolved.certDir,
    assetsRoot: resolved.assetsRoot,
    bridgeUrl: resolved.bridgeUrl.origin,
    running: false
  };
  if (!fs.existsSync(pfxPath) || !fs.existsSync(passwordPath) || !fs.existsSync(trustedPath)) {
    status.state = 'certificate_missing';
    status.message = 'Word localhost certificate files or the setup marker are missing. Run the setup script and choose whether to trust its certificate for the current Windows user.';
    return status;
  }
  if (!fs.existsSync(path.join(resolved.assetsRoot, 'taskpane.html')) || !fs.existsSync(path.join(resolved.assetsRoot, 'taskpane.js'))) {
    status.state = 'assets_missing';
    status.message = 'Build extensions/word with npm run build before starting the Word host.';
    return status;
  }
  status.state = 'ready';
  status.message = 'Word localhost certificate files are ready. The operating-system trust store is not checked.';
  return status;
}
function mimeType(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.csl': 'application/xml; charset=utf-8',
    '.png': 'image/png'
  })[ext] || 'application/octet-stream';
}
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function relayLiterature(request, response, bridgeUrl) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  var parsed = new URL(request.url, 'https://localhost');
  var keys = [];
  parsed.searchParams.forEach(function (_value, key) { keys.push(key); });
  if (parsed.searchParams.getAll('q').length !== 1 || keys.some(function (key) { return key !== 'q'; })) {
    sendJson(response, 400, { error: 'invalid_query' });
    return;
  }
  var bearer = request.headers.authorization || '';
  if (!/^Bearer [^\r\n]{1,4096}$/.test(bearer)) {
    sendJson(response, 401, { error: 'plugin_token_required' });
    return;
  }
  var query = '?q=' + encodeURIComponent(parsed.searchParams.get('q'));
  var upstream = http.request({
    hostname: bridgeUrl.hostname,
    port: bridgeUrl.port,
    path: '/v1/literature' + query,
    method: 'GET',
    headers: { Authorization: bearer, Accept: 'application/json' }
  }, function (upstreamResponse) {
    var chunks = [];
    var responseBytes = 0;
    var contentLength = Number(upstreamResponse.headers['content-length']);
    if (isFinite(contentLength) && contentLength > MAX_RELAY_RESPONSE_BYTES) {
      finishError(502, 'folio_response_too_large');
      upstreamResponse.destroy();
      return;
    }
    upstreamResponse.on('data', function (chunk) {
      responseBytes += chunk.length;
      if (responseBytes > MAX_RELAY_RESPONSE_BYTES) {
        finishError(502, 'folio_response_too_large');
        upstreamResponse.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    upstreamResponse.on('end', function () {
      if (settled || response.destroyed) return;
      settled = true;
      clearTimeout(deadline);
      response.writeHead(upstreamResponse.statusCode || 502, {
        'Content-Type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(Buffer.concat(chunks, responseBytes));
    });
    upstreamResponse.on('aborted', fail);
    upstreamResponse.on('error', fail);
  });
  var settled = false;
  var deadline = setTimeout(function () {
    if (settled) return;
    upstream.destroy(new Error('bridge_timeout'));
    finishError(504, 'folio_bridge_timeout');
  }, RELAY_TIMEOUT_MS);
  function cleanup() {
    clearTimeout(deadline);
    request.removeListener('aborted', abort);
    response.removeListener('close', abort);
  }
  function finishError(statusCode, error) {
    if (settled) return;
    settled = true;
    cleanup();
    if (!response.destroyed && !response.writableEnded) sendJson(response, statusCode, { error: error });
  }
  function fail() {
    finishError(502, 'folio_bridge_unavailable');
  }
  function abort() {
    if (settled) return;
    settled = true;
    cleanup();
    upstream.destroy();
  }
  upstream.setTimeout(RELAY_TIMEOUT_MS, function () {
    upstream.destroy(new Error('bridge_timeout'));
    finishError(504, 'folio_bridge_timeout');
  });
  upstream.on('error', fail);
  request.on('aborted', abort);
  response.on('close', function () {
    if (!response.writableEnded) abort();
  });
  upstream.end();
}
function createHandler(options) {
  return function (request, response) {
    var parsed;
    try { parsed = new URL(request.url, 'https://localhost'); }
    catch (_error) { sendJson(response, 400, { error: 'bad_request' }); return; }
    if (parsed.pathname === '/health') {
      sendJson(response, 200, { state: 'ready' });
      return;
    }
    if (parsed.pathname === '/bridge/v1/literature') {
      relayLiterature(request, response, options.bridgeUrl);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    var relativePath;
    try { relativePath = decodeURIComponent(parsed.pathname === '/' ? '/taskpane.html' : parsed.pathname).replace(/^[/\\]+/, ''); }
    catch (_error) { sendJson(response, 400, { error: 'bad_path' }); return; }
    var target = path.resolve(options.assetsRoot, relativePath);
    var relative = path.relative(options.assetsRoot, target);
    if (relative === '..' || relative.indexOf('..' + path.sep) === 0 || path.isAbsolute(relative)) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    fs.stat(target, function (error, stat) {
      if (error || !stat.isFile()) { sendJson(response, 404, { error: 'not_found' }); return; }
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': mimeType(target), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end();
        return;
      }
      var stream = fs.createReadStream(target);
      stream.once('open', function () {
        if (response.destroyed) { stream.destroy(); return; }
        response.writeHead(200, { 'Content-Type': mimeType(target), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        stream.pipe(response);
      });
      stream.once('error', function () {
        if (!response.headersSent && !response.destroyed) sendJson(response, 500, { error: 'asset_unavailable' });
        else if (!response.destroyed) response.destroy();
      });
    });
  };
}
function startWordHost(options) {
  var resolved = resolveOptions(options);
  var status = getWordHostStatus(options);
  if (status.state !== 'ready') {
    var error = new Error(status.message);
    error.code = status.state;
    error.status = status;
    return Promise.reject(error);
  }
  var pfxPath = path.join(resolved.certDir, 'localhost.pfx');
  var passwordPath = path.join(resolved.certDir, 'localhost.password');
  var server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: fs.readFileSync(passwordPath, 'utf8').trim() }, createHandler(resolved));
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(resolved.port, resolved.host, function () {
      server.removeListener('error', reject);
      resolve({
        url: status.url,
        stop: function () {
          return new Promise(function (done, fail) { server.close(function (error) { if (error) fail(error); else done(); }); });
        },
        getStatus: function () {
          var current = getWordHostStatus(options);
          current.running = server.listening;
          if (server.listening) current.state = 'running';
          return current;
        }
      });
    });
  });
}

module.exports = {
  startWordHost: startWordHost,
  getWordHostStatus: getWordHostStatus,
  createHandler: createHandler,
  MAX_RELAY_RESPONSE_BYTES: MAX_RELAY_RESPONSE_BYTES
};

if (require.main === module) {
  startWordHost().then(function (host) {
    process.stdout.write('Folio Word task pane: ' + host.url + '\n');
    process.on('SIGINT', function () { host.stop().then(function () { process.exit(0); }); });
  }).catch(function (error) {
    process.stderr.write((error.message || String(error)) + '\n');
    process.exitCode = 1;
  });
}
