const http = require('node:http');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { timingSafeEqual } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');

const id = '[a-f0-9]{32}';
const paperRoutes = {
  GET: new RegExp(`^/papers/${id}(?:/(?:pdf|chat|analysis|agent-actions|chat-sessions|chat-sessions/${id}/attachments(?:/${id}/content)?))?$`),
  POST: new RegExp(`^/papers/${id}/(?:translation/(?:retry|continue|stop)|ai-annotation|translate-selection|chat/stream(?:/${id}/cancel)?|analysis/${id}/stream|agent-actions/${id}/(?:confirm|cancel)|chat-sessions(?:/${id}/attachments)?)$`),
  PUT: new RegExp(`^/papers/${id}/chat-sessions/${id}/selection$`),
  PATCH: new RegExp(`^/papers/${id}/model$`),
  DELETE: new RegExp(`^/papers/${id}/chat-sessions/${id}(?:/attachments/${id})?$`),
};

async function startTabletBridge({ token, host, backendBase, backendToken }) {
  const expected = Buffer.from('Bearer ' + token);
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    const origin = request.headers.origin;
    if (origin && origin !== 'http://localhost') return send(403, { detail: '请求来源无效。' });
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Folio-Name');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      return send(204);
    }
    const actual = Buffer.from(request.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(401, { detail: '配对密钥无效。' });
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
    const settings = request.method === 'GET' && url.pathname === '/reader-settings';
    const upload = request.method === 'POST' && url.pathname === '/upload';
    if (!settings && !upload && !paperRoutes[request.method]?.test(url.pathname)) return send(404, { detail: '接口不存在。' });

    const headers = { Authorization: 'Bearer ' + backendToken };
    let directory;
    try {
      if (upload) {
        const maxBytes = 200 * 1024 * 1024;
        if (Number(request.headers['content-length']) > maxBytes) return send(413, { detail: 'PDF 超过 200 MB。' });
        const name = decodeURIComponent(request.headers['x-folio-name'] || 'paper.pdf').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-140);
        directory = await fs.mkdtemp(path.join(tmpdir(), 'folio-tablet-'));
        const target = path.join(directory, /\.pdf$/i.test(name) ? name : name + '.pdf');
        let received = 0;
        await pipeline(request, new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) return callback(new Error('PDF 超过 200 MB。'));
            callback(null, chunk);
          },
        }), createWriteStream(target, { flags: 'wx' }));
        const imported = await fetch(backendBase + '/papers/import', {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: [target], defer_translation: url.searchParams.get('purpose') === 'ai' }),
        });
        const result = await imported.json();
        return send(imported.status, imported.ok ? result.results[0].paper : result);
      }
      if (settings) {
        const upstream = await fetch(backendBase + '/settings', { headers });
        if (!upstream.ok) return send(upstream.status, { detail: '无法读取电脑端 AI 设置。' });
        const { model, model_options, web_search_enabled } = await upstream.json();
        return send(200, { model, model_options, web_search_enabled });
      }
      let body;
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const maxJsonBytes = 48 * 1024 * 1024;
        if (Number(request.headers['content-length']) > maxJsonBytes) return send(413, { detail: '请求内容过大。' });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > maxJsonBytes) return send(413, { detail: '请求内容过大。' });
          chunks.push(chunk);
        }
        if (size) {
          body = Buffer.concat(chunks);
          headers['Content-Type'] = 'application/json';
        }
      }
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      const upstream = await fetch(backendBase + url.pathname + url.search, {
        method: request.method, headers, body, signal: controller.signal,
      });
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream' });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch {
      if (!response.headersSent && !response.destroyed) send(502, { detail: '电脑端文献服务请求失败。' });
      else response.destroy();
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(37862, host, resolve);
  });
  server.unref();
  return server;
}
module.exports = { startTabletBridge };
