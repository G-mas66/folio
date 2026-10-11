'use strict';

importScripts('shared.js');

const BRIDGE = 'http://127.0.0.1:37861';
const TOKEN_KEY = 'folioPluginToken';

function popupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  return '本机 Folio 服务暂不可用。';
}

async function tokenValue() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
}

async function bridgeRequest(route, { token = '', method = 'GET', body = undefined, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BRIDGE + route, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = payload?.detail;
      throw new Error(typeof detail === 'string' ? detail : '本机 Folio 服务返回错误（' + response.status + '）。');
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接本机 Folio 服务超时。');
    if (error instanceof TypeError) throw new Error('无法连接本机 Folio，请确认桌面工作台已打开。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function pair(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token.trim())) {
    throw new Error('请粘贴 Folio 设置页中的 64 位配对凭证。');
  }
  await bridgeRequest('/health', { timeoutMs: 5000 });
  const normalized = token.trim();
  const folders = await bridgeRequest('/v1/folders', { token: normalized });
  await chrome.storage.local.set({ [TOKEN_KEY]: normalized });
  return { paired: true, folders };
}

async function ensureToken() {
  const token = await tokenValue();
  if (!token) throw new Error('请先在扩展中粘贴 Folio 配对凭证。');
  return token;
}

function permissionOrigin(url) {
  const safe = FolioCapture.safeUrl(url);
  if (!safe) return '';
  const parsed = new URL(safe);
  return parsed.protocol + '//' + parsed.hostname + '/*';
}

async function collect(message) {
  const token = await ensureToken();
  const item = message.item && typeof message.item === 'object' ? message.item : {};
  const body = {};
  for (const field of [
    'title', 'authors', 'year', 'container_title', 'doi', 'url', 'pdf_url',
    'volume', 'issue', 'pages', 'item_type',
  ]) {
    if (Object.hasOwn(item, field) && item[field] !== undefined && item[field] !== null) body[field] = item[field];
  }
  body.source = item.source === 'scholar' ? 'scholar' : 'browser';
  if (typeof message.folderId === 'string' && message.folderId) body.folder_id = message.folderId;

  let pdfDownloadError = '';
  if (message.fetchPdf && typeof message.pdfUrl === 'string' && message.pdfUrl) {
    const origin = permissionOrigin(message.pdfUrl);
    if (!origin || !(await chrome.permissions.contains({ origins: [origin] }))) {
      pdfDownloadError = '浏览器尚未授权读取 PDF 来源。';
    } else {
      try {
        const pdf = await FolioCapture.downloadPdf(message.pdfUrl);
        body.pdf_content_base64 = pdf.base64;
        body.pdf_name = pdf.name;
      } catch (error) {
        pdfDownloadError = errorMessage(error);
      }
    }
  }

  const payload = await bridgeRequest('/v1/capture', {
    token,
    method: 'POST',
    body,
    timeoutMs: 120000,
  });
  if (pdfDownloadError) {
    payload.pdf_import = { status: 'failed', error: pdfDownloadError };
  }
  return payload;
}

async function handle(message) {
  if (!message || typeof message.type !== 'string') throw new Error('扩展请求无效。');
  if (message.type === 'FOLIO_STATUS') {
    const token = await tokenValue();
    return { paired: Boolean(token) };
  }
  if (message.type === 'FOLIO_PAIR') return pair(message.token);
  if (message.type === 'FOLIO_UNPAIR') {
    await chrome.storage.local.remove(TOKEN_KEY);
    return { paired: false };
  }
  const token = await ensureToken();
  if (message.type === 'FOLIO_FOLDERS') {
    const folders = await bridgeRequest('/v1/folders', { token });
    return { folders };
  }
  if (message.type === 'FOLIO_SEARCH') {
    const query = typeof message.query === 'string' ? message.query.trim().slice(0, 300) : '';
    const result = await bridgeRequest('/v1/literature?q=' + encodeURIComponent(query), { token });
    return result;
  }
  if (message.type === 'FOLIO_CAPTURE') return collect(message);
  throw new Error('不支持的扩展请求。');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!popupSender(sender)) return false;
  handle(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});
