'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = 37861;
const MAX_BODY_BYTES = 36 * 1024 * 1024;
const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_NATIVE_SECRET_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'),
  'Folio',
  'browser-bridge.secret',
);
const NATIVE_PIPE = process.platform === 'win32'
  ? '\\\\.\\pipe\\folio-browser-bridge-v1'
  : path.join(require('node:os').tmpdir(), 'folio-browser-bridge-v1.sock');
const ALLOWED_CAPTURE_FIELDS = new Set([
  'title', 'authors', 'year', 'container_title', 'doi', 'url', 'pdf_url',
  'volume', 'issue', 'pages', 'item_type', 'paper_id', 'folder_id', 'source', 'source_url',
  'pdf_content_base64', 'pdf_name', 'csl', 'source_citation', 'version_label',
  'publisher', 'publisher_place', 'edition', 'series', 'series_number', 'issn', 'isbn',
]);
const WORD_ORIGIN = 'https://localhost:37862';

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(origin) {
  return origin === WORD_ORIGIN;
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

function loadOrCreateNativeSecret(filename) {
  try {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('本机浏览器桥凭证文件无效。');
    const secret = fs.readFileSync(filename, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(secret)) return secret;
    throw new Error('本机浏览器桥凭证文件无效。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${secret}\n`, 'utf8');
  } catch (error) {
    if (error.code === 'EEXIST') return loadOrCreateNativeSecret(filename);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try { fs.chmodSync(filename, 0o600); } catch {}
  return secret;
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

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCitationStyle(value) {
  return value === 'apa' || value === 'gb-t-7714-2015-numeric';
}

function createNativeMessagingBridge({
  getBackendBase,
  getBackendToken,
  pipeName = NATIVE_PIPE,
  secretPath = DEFAULT_NATIVE_SECRET_PATH,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof getBackendBase !== 'function' || typeof getBackendToken !== 'function') throw new TypeError('backend getters are required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (typeof pipeName !== 'string' || !pipeName) throw new TypeError('pipeName is required');
  if (typeof secretPath !== 'string' || !secretPath) throw new TypeError('secretPath is required');

  const secret = loadOrCreateNativeSecret(secretPath);
  let server = null;
  let starting = null;
  let stopped = false;
  const sockets = new Set();
  const upstreamRequests = new Set();

  function status() {
    return { running: Boolean(server?.listening), pipeName };
  }

  function reply(socket, payload) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (bytes.length > MAX_NATIVE_MESSAGE_BYTES) {
      return writeFrame(socket, { ok: false, error: '本机响应内容过大。' });
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(bytes.length);
    socket.write(Buffer.concat([length, bytes]));
  }

  function writeFrame(socket, payload) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(bytes.length);
    socket.write(Buffer.concat([length, bytes]));
  }

  async function backendRequest(route, body = undefined, timeoutMs = 15000) {
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
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    upstreamRequests.add(controller);
    try {
      const upstream = await fetchImpl(`${base}${route}`, {
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
      try { payload = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
      catch { throw new BridgeError(502, '本机文献服务返回了无效响应。'); }
      if (!upstream.ok) {
        const message = typeof payload?.detail === 'string' ? payload.detail : '本机文献服务处理失败。';
        return { ok: false, error: message, status: upstream.status, detail: payload?.detail };
      }
      return { ok: true, result: payload };
    } catch (error) {
      if (error instanceof BridgeError) return { ok: false, error: error.message, status: error.status };
      if (stopped) return { ok: false, error: '本机连接服务已停止。', status: 503 };
      if (controller.signal.aborted) return { ok: false, error: '本机文献服务处理超时，请检查收藏列表后重试。', status: 504 };
      return { ok: false, error: '本机文献服务暂不可用。', status: 502 };
    } finally {
      clearTimeout(timeout);
      upstreamRequests.delete(controller);
    }
  }

  function captureBody(message) {
    const item = plainObject(message.item) ? message.item : {};
    const unknown = Object.keys(item).filter((key) => !ALLOWED_CAPTURE_FIELDS.has(key) || ['folder_id', 'pdf_content_base64', 'pdf_name'].includes(key));
    if (unknown.length) throw new BridgeError(422, '请求包含不支持的书目字段。');
    const body = Object.fromEntries(Object.entries(item).filter(([key, value]) => ALLOWED_CAPTURE_FIELDS.has(key) && value !== undefined && value !== null));
    body.source = item.source === 'scholar' ? 'scholar' : 'browser';
    if (typeof message.folderId === 'string' && message.folderId) body.folder_id = message.folderId;
    return body;
  }

  async function dispatch(message, captures) {
    try {
      if (!plainObject(message) || typeof message.type !== 'string') throw new BridgeError(400, '扩展请求无效。');
      if (message.type === 'FOLIO_STATUS') return { ok: true, result: { connected: true } };
      if (message.type === 'FOLIO_FOLDERS') return backendRequest('/folders');
      if (message.type === 'FOLIO_GET_RECORD') {
        const id = String(message.recordId ?? '');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new BridgeError(422, '书目编号无效。');
        return backendRequest(`/literature/${encodeURIComponent(id)}`);
      }
      if (message.type === 'FOLIO_SEARCH') {
        const query = typeof message.query === 'string' ? message.query.trim().slice(0, 300) : '';
        const params = new URLSearchParams({ q: query });
        if (typeof message.folderId === 'string' && message.folderId) params.set('folder_id', message.folderId);
        if (isCitationStyle(message.confirmedStyle)) params.set('confirmed_style', message.confirmedStyle);
        return backendRequest(`/literature?${params.toString()}`);
      }
      if (message.type === 'FOLIO_PREVIEW') {
        if (!plainObject(message.record) || !isCitationStyle(message.style)) throw new BridgeError(422, '引用预览参数无效。');
        return backendRequest('/literature/preview', { record: message.record, style: message.style });
      }
      if (message.type === 'FOLIO_CONFIRM') {
        const id = String(message.recordId ?? '');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !isCitationStyle(message.style)
            || typeof message.fingerprint !== 'string' || !/^[a-f0-9]{32,128}$/i.test(message.fingerprint)) {
          throw new BridgeError(422, '引用确认参数无效。');
        }
        return backendRequest(`/literature/${encodeURIComponent(id)}/citations`, {
          style: message.style,
          fingerprint: message.fingerprint,
        });
      }
      if (message.type === 'FOLIO_RENDER_DOCUMENT') {
        const state = message.state;
        if (!plainObject(state) || state.version !== 1 || !plainObject(state.items) || !Array.isArray(state.citations)
            || state.citations.length > 500 || Object.keys(state.items).length > 200
            || Buffer.byteLength(JSON.stringify(state), 'utf8') > 900 * 1024
            || Object.entries(state.items).some(([id, record]) => !/^[A-Za-z0-9_-]{1,128}$/.test(id)
              || !plainObject(record) || String(record.id || '') !== id)
            || state.citations.some((citation) => !plainObject(citation)
              || typeof citation.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(citation.id)
              || !Array.isArray(citation.items) || citation.items.length > 200
              || citation.items.some((item) => !plainObject(item) || typeof item.id !== 'string'
                || !Object.hasOwn(state.items, item.id)
                || (item.locator !== undefined && (typeof item.locator !== 'string' || item.locator.length > 100))
                || (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 100))))) {
          throw new BridgeError(422, 'Word 引用文档状态无效或过大。');
        }
        if (!isCitationStyle(message.style)) throw new BridgeError(422, '引用格式无效。');
        return backendRequest('/literature/render-document', { state, style: message.style }, 120000);
      }
      if (message.type === 'FOLIO_PARSE') {
        if (!['bibtex', 'ris', 'csl-json'].includes(message.format) || typeof message.data !== 'string' || message.data.length > MAX_BODY_BYTES) {
          throw new BridgeError(422, '书目文件内容无效或过大。');
        }
        return backendRequest('/literature/parse', { format: message.format, data: message.data }, 120000);
      }
      if (message.type === 'FOLIO_RESOLVE') {
        const doi = typeof message.doi === 'string' ? message.doi.trim().slice(0, 300) : '';
        if (!doi) throw new BridgeError(422, 'DOI 无效。');
        return backendRequest('/literature/resolve', { doi }, 120000);
      }
      if (message.type === 'FOLIO_SUPPLEMENT_PREVIEW' || message.type === 'FOLIO_SUPPLEMENT_APPLY') {
        const id = String(message.recordId ?? '');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new BridgeError(422, '书目编号无效。');
        if (message.type === 'FOLIO_SUPPLEMENT_PREVIEW') {
          return backendRequest(`/literature/${encodeURIComponent(id)}/supplement/preview`, {});
        }
        if (!Array.isArray(message.fields) || message.fields.length > 32 || message.fields.some((field) => typeof field !== 'string' || field.length > 128)) {
          throw new BridgeError(422, '补全字段无效。');
        }
        return backendRequest(`/literature/${encodeURIComponent(id)}/supplement/apply`, {
          fields: message.fields,
          ...(typeof message.source_fingerprint === 'string' ? { source_fingerprint: message.source_fingerprint } : {}),
        });
      }
      if (message.type === 'FOLIO_CAPTURE') {
        const body = captureBody(message);
        const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
        if (bodyBytes > MAX_BODY_BYTES) throw new BridgeError(413, '请求超过 36 MiB 限制。');
        return backendRequest('/literature/capture', body, 120000);
      }
      if (message.type === 'FOLIO_CAPTURE_BEGIN') {
        if (captures.size >= 2) throw new BridgeError(429, '已有 PDF 收藏任务正在处理。');
        const body = captureBody(message);
        const captureId = crypto.randomBytes(16).toString('hex');
        captures.set(captureId, { body, chunks: [], nextIndex: 0, size: 0, createdAt: Date.now() });
        return { ok: true, result: { captureId } };
      }
      if (message.type === 'FOLIO_CAPTURE_PDF_CHUNK') {
        const pending = captures.get(message.captureId);
        if (!pending || Date.now() - pending.createdAt > 120000) {
          captures.delete(message.captureId);
          throw new BridgeError(410, 'PDF 收藏任务已过期，请重试。');
        }
        if (!Number.isInteger(message.index) || message.index !== pending.nextIndex
            || typeof message.chunk !== 'string' || message.chunk.length > 512 * 1024
            || message.chunk.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.chunk)) {
          captures.delete(message.captureId);
          throw new BridgeError(422, 'PDF 分段内容无效，请重试。');
        }
        pending.size += message.chunk.length;
        if (pending.size > Math.ceil(MAX_PDF_BYTES / 3) * 4) {
          captures.delete(message.captureId);
          throw new BridgeError(413, 'PDF 超过 25 MiB 限制。');
        }
        pending.chunks.push(message.chunk);
        pending.nextIndex += 1;
        return { ok: true, result: { received: pending.nextIndex } };
      }
      if (message.type === 'FOLIO_CAPTURE_FINISH') {
        const pending = captures.get(message.captureId);
        captures.delete(message.captureId);
        if (!pending || Date.now() - pending.createdAt > 120000 || pending.nextIndex === 0) {
          throw new BridgeError(410, 'PDF 收藏任务已过期，请重试。');
        }
        if (typeof message.pdfName === 'string') pending.body.pdf_name = message.pdfName.slice(0, 255);
        pending.body.pdf_content_base64 = pending.chunks.join('');
        const bodyBytes = Buffer.byteLength(JSON.stringify(pending.body), 'utf8');
        if (bodyBytes > MAX_BODY_BYTES) throw new BridgeError(413, '请求超过 36 MiB 限制。');
        return backendRequest('/literature/capture', pending.body, 120000);
      }
      throw new BridgeError(400, '不支持的扩展请求。');
    } catch (error) {
      return { ok: false, error: error instanceof BridgeError ? error.message : '本机连接请求失败。', status: error instanceof BridgeError ? error.status : 500 };
    }
  }

  function accept(socket) {
    sockets.add(socket);
    const client = { captures: new Map(), authenticated: false };
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > MAX_NATIVE_MESSAGE_BYTES) {
          socket.destroy();
          return;
        }
        if (buffer.length < length + 4) return;
        const bytes = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        chain = chain.then(async () => {
          let message;
          try { message = JSON.parse(bytes.toString('utf8')); }
          catch { return reply(socket, { ok: false, error: '扩展请求 JSON 无效。', status: 400 }); }
          if (!client.authenticated) {
            const suppliedValue = plainObject(message) && typeof message.secret === 'string' ? message.secret : '';
            const supplied = Buffer.from(/^[a-f0-9]{64}$/.test(suppliedValue) ? suppliedValue : '0'.repeat(64), 'utf8');
            const expected = Buffer.from(secret, 'utf8');
            const valid = plainObject(message) && message.type === 'FOLIO_NATIVE_AUTH'
              && crypto.timingSafeEqual(supplied, expected) && suppliedValue.length === 64;
            if (!valid) {
              const response = { ok: false, error: '本机浏览器连接未经授权。', status: 403 };
              if (plainObject(message) && Object.hasOwn(message, 'id')) response.id = message.id;
              reply(socket, response);
              socket.end();
              return;
            }
            client.authenticated = true;
            return reply(socket, { ok: true, result: { authenticated: true }, id: message.id });
          }
          const response = await dispatch(message, client.captures);
          if (plainObject(message) && Object.hasOwn(message, 'id')) response.id = message.id;
          return reply(socket, response);
        }).catch(() => {
          if (!socket.destroyed) reply(socket, { ok: false, error: '本机连接请求失败。', status: 500 });
        });
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      client.captures.clear();
    });
    socket.on('error', () => {});
  }

  async function start() {
    if (server?.listening && !stopped) return status();
    if (starting && !stopped) return starting;
    stopped = false;
    const operation = new Promise((resolve, reject) => {
      const candidate = net.createServer(accept);
      server = candidate;
      candidate.once('error', (error) => {
        if (server === candidate) server = null;
        if (starting === operation) starting = null;
        reject(error);
      });
      candidate.listen(pipeName, () => {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(pipeName, 0o600); } catch {}
        }
        if (starting === operation) starting = null;
        resolve(status());
      });
    });
    starting = operation;
    return operation;
  }

  async function stop() {
    stopped = true;
    for (const controller of upstreamRequests) controller.abort();
    for (const socket of sockets) socket.destroy();
    const candidate = server;
    server = null;
    if (candidate) await new Promise((resolve) => {
      try {
        candidate.close(() => resolve());
        candidate.closeAllConnections?.();
      } catch { resolve(); }
    });
    if (starting) await starting.catch(() => {});
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(pipeName); } catch {}
    }
  }

  return { start, stop, getStatus: status };
}

module.exports = { createPluginBridge, createNativeMessagingBridge, MAX_BODY_BYTES, MAX_NATIVE_MESSAGE_BYTES };
