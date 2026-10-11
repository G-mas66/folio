'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = 37861;
const MAX_BODY_BYTES = 36 * 1024 * 1024;
const ALLOWED_CAPTURE_FIELDS = new Set([
  'title', 'authors', 'year', 'container_title', 'doi', 'url', 'pdf_url',
  'volume', 'issue', 'pages', 'item_type', 'paper_id', 'folder_id', 'source',
  'pdf_content_base64', 'pdf_name',
]);
const WORD_ORIGIN = 'https://localhost:37862';
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(origin) {
  return origin === WORD_ORIGIN || EXTENSION_ORIGIN.test(origin || '');
}

function tokenFile(dataDir) {
  return path.join(dataDir, '.folio-plugin-token');
}

function saveToken(filename, token) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, filename);
    try { fs.chmodSync(filename, 0o600); } catch {}
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function loadOrCreateToken(filename) {
  try {
    const info = fs.lstatSync(filename);
    if (info.isFile() && !info.isSymbolicLink()) {
      const token = fs.readFileSync(filename, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(token)) return token;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(32).toString('hex');
  saveToken(filename, token);
  return token;
}

function safeBackendBase(getBackendBase) {
  const value = getBackendBase();
  let url;
  try { url = new URL(value); } catch { throw new BridgeError(503, '本机文献服务暂不可用。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new BridgeError(503, '本机文献服务暂不可用。');
  }
  return url.origin;
}

function authorize(request, token) {
  const header = request.headers.authorization || '';
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  const supplied = Buffer.from(match ? match[1] : '0'.repeat(64), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  const valid = crypto.timingSafeEqual(supplied, expected) && Boolean(match);
  if (!valid) throw new BridgeError(401, '插件尚未配对或凭证已失效。');
}

function sendJson(response, status, payload, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
  if (origin && allowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function corsHeaders(request, origin) {
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (request.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function isAllowedRoute(method, pathname) {
  return (method === 'GET' && ['/health', '/v1/literature', '/v1/folders'].includes(pathname))
    || (method === 'POST' && pathname === '/v1/capture');
}

async function readJson(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new BridgeError(415, '请求需使用 application/json。');
  }
  const length = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    request.resume();
    throw new BridgeError(413, '请求超过 36 MiB 限制。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new BridgeError(413, '请求超过 36 MiB 限制。');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required');
    return value;
  } catch {
    throw new BridgeError(400, '请求 JSON 无效。');
  }
}

async function readResponse(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(502, '本机服务返回内容超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function createPluginBridge({ dataDir, getBackendBase, getBackendToken, port = PORT, host = HOST, fetchImpl = globalThis.fetch }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (typeof getBackendBase !== 'function' || typeof getBackendToken !== 'function') throw new TypeError('backend getters are required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');

  const filename = tokenFile(dataDir);
  let token = loadOrCreateToken(filename);
  let server = null;
  let pendingServer = null;
  let starting = null;
  let lastError = '';
  let generation = 0;
  let stopped = false;
  const upstreamRequests = new Set();
  const closePromises = new WeakMap();

  function closeServer(candidate) {
    if (!candidate) return Promise.resolve();
    const previous = closePromises.get(candidate);
    if (previous) return previous;
    const closing = new Promise((resolve) => {
      const closeListeningServer = () => {
        if (!candidate.listening) {
          resolve();
          return;
        }
        try {
          candidate.close(() => resolve());
          candidate.closeIdleConnections?.();
          candidate.closeAllConnections?.();
        } catch {
          resolve();
        }
      };
      if (candidate.listening) closeListeningServer();
      else {
        candidate.once('listening', closeListeningServer);
        candidate.once('error', resolve);
      }
    });
    closePromises.set(candidate, closing);
    return closing;
  }

  function status() {
    const address = server?.address();
    return {
      running: Boolean(server?.listening),
      host,
      port: address && typeof address === 'object' ? address.port : port,
      paired: Boolean(token),
      error: lastError,
    };
  }

  function validateHost(request) {
    const address = server?.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const received = String(request.headers.host || '').toLowerCase();
    if (received && ![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(received)) {
      throw new BridgeError(403, '插件桥只接受本机 Host。');
    }
  }

  async function proxy(request, response, upstreamPath, body) {
    let base;
    let internalToken;
    try {
      base = safeBackendBase(getBackendBase);
      internalToken = getBackendToken();
    } catch {
      throw new BridgeError(503, '本机文献服务暂不可用。');
    }
    if (typeof internalToken !== 'string' || !internalToken) throw new BridgeError(503, '本机文献服务暂不可用。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), body === undefined ? 10000 : 120000);
    timeout.unref?.();
    upstreamRequests.add(controller);
    try {
      const upstream = await fetchImpl(`${base}${upstreamPath}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${internalToken}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
      const bytes = await readResponse(upstream);
      let payload;
      try { payload = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; }
      catch { throw new BridgeError(502, '本机文献服务返回了无效响应。'); }
      const origin = request.headers.origin;
      sendJson(response, upstream.status, payload ?? {}, origin);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (stopped) throw new BridgeError(503, '插件桥已停止。');
      if (controller.signal.aborted) throw new BridgeError(504, '本机文献服务处理超时，书目可能已保存，请检查收藏列表。');
      throw new BridgeError(502, '本机文献服务暂不可用。');
    } finally {
      clearTimeout(timeout);
      upstreamRequests.delete(controller);
    }
  }

  async function handle(request, response) {
    const origin = request.headers.origin;
    try {
      validateHost(request);
      if (origin && !allowedOrigin(origin)) throw new BridgeError(403, '此来源无权访问插件桥。');
      const requestUrl = new URL(request.url, `http://${HOST}`);
      const pathname = requestUrl.pathname;

      if (request.method === 'OPTIONS') {
        const requestedMethod = String(request.headers['access-control-request-method'] || '').toUpperCase();
        if (!origin || !allowedOrigin(origin) || !isAllowedRoute(requestedMethod, pathname)) {
          throw new BridgeError(403, '此跨来源请求不受支持。');
        }
        const requestedHeaders = String(request.headers['access-control-request-headers'] || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
        if (requestedHeaders.some((header) => !['authorization', 'content-type', 'accept'].includes(header))) {
          throw new BridgeError(403, '跨来源请求包含不支持的请求头。');
        }
        response.writeHead(204, corsHeaders(request, origin));
        response.end();
        return;
      }

      if (!isAllowedRoute(request.method, pathname)) throw new BridgeError(404, '找不到插件接口。');
      if (pathname === '/health') {
        if (request.method !== 'GET') throw new BridgeError(405, '请求方法不受支持。');
        sendJson(response, 200, { status: 'ok' }, origin);
        return;
      }

      authorize(request, token);
      if (pathname === '/v1/literature') {
        const query = requestUrl.searchParams.get('q') || '';
        if (query.length > 300) throw new BridgeError(422, '搜索内容不能超过 300 个字符。');
        await proxy(request, response, `/literature?q=${encodeURIComponent(query)}`);
        return;
      }
      if (pathname === '/v1/folders') {
        await proxy(request, response, '/folders');
        return;
      }
      if (pathname === '/v1/capture') {
        const incoming = await readJson(request);
        const unknown = Object.keys(incoming).filter((key) => !ALLOWED_CAPTURE_FIELDS.has(key));
        if (unknown.length) throw new BridgeError(422, '请求包含不支持的书目字段。');
        const body = Object.fromEntries(Object.entries(incoming).filter(([key]) => ALLOWED_CAPTURE_FIELDS.has(key)));
        await proxy(request, response, '/literature/capture', body);
      }
    } catch (error) {
      const originForResponse = origin && allowedOrigin(origin) ? origin : undefined;
      const statusCode = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof BridgeError ? error.message : '插件桥请求失败。';
      sendJson(response, statusCode, { detail: message }, originForResponse);
    }
  }

  async function start() {
    if (server?.listening && !stopped) return status();
    if (starting && !stopped) return starting;
    stopped = false;
    const currentGeneration = ++generation;
    const operation = new Promise((resolve, reject) => {
      const candidate = http.createServer(handle);
      pendingServer = candidate;
      candidate.requestTimeout = 120000;
      candidate.headersTimeout = 15000;
      candidate.keepAliveTimeout = 5000;
      candidate.once('error', (error) => {
        lastError = error.code === 'EADDRINUSE'
          ? `插件桥端口 ${port} 已被占用。`
          : '插件桥无法启动。';
        if (server === candidate) server = null;
        if (pendingServer === candidate) pendingServer = null;
        if (starting === operation) starting = null;
        reject(new Error(lastError));
      });
      candidate.listen(port, host, () => {
        if (currentGeneration !== generation || stopped) {
          void closeServer(candidate).then(() => {
            if (pendingServer === candidate) pendingServer = null;
            if (starting === operation) starting = null;
            resolve(status());
          });
          return;
        }
        pendingServer = null;
        server = candidate;
        lastError = '';
        if (starting === operation) starting = null;
        resolve(status());
      });
    });
    starting = operation;
    return operation;
  }

  async function stop() {
    stopped = true;
    generation += 1;
    for (const controller of upstreamRequests) controller.abort();
    const active = server;
    const pending = pendingServer;
    if (server === active) server = null;
    if (pendingServer === pending) pendingServer = null;
    const closePromise = Promise.all([closeServer(active), closeServer(pending)]);
    const startupPromise = starting ? starting.catch(() => {}) : Promise.resolve();
    let timeoutHandle;
    await Promise.race([
      Promise.all([closePromise, startupPromise]),
      new Promise((resolve) => { timeoutHandle = setTimeout(resolve, 1500); }),
    ]);
    clearTimeout(timeoutHandle);
  }

  function getToken() {
    return token;
  }

  function rotateToken() {
    const replacement = crypto.randomBytes(32).toString('hex');
    saveToken(filename, replacement);
    token = replacement;
    return token;
  }

  return { start, stop, getStatus: status, getToken, rotateToken };
}

module.exports = { createPluginBridge, MAX_BODY_BYTES };
