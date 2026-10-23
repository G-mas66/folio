'use strict';

importScripts('shared.js');

const NATIVE_HOST = 'com.folio.browser_bridge';
const PDF_CHUNK_CHARS = 512 * 1024;
let nativePort = null;
let nextRequestId = 0;
const pendingRequests = new Map();

function popupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  return '本机 Folio 服务暂不可用。';
}

function scheduleReconnect() {
  chrome.alarms?.create('folio-native-status', { periodInMinutes: 0.5 });
}

function nativeConnectionError(reason) {
  if (/Access to the specified native messaging host is forbidden/i.test(reason)) {
    return `浏览器未获准连接 Folio（扩展 ID：${chrome.runtime.id}）。请更新并重启 Folio 桌面版，再重试连接；如仍失败，请核对已安装的扩展是否来自 Folio 安装包。`;
  }
  return reason;
}

function connectNative() {
  if (nativePort) return nativePort;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    throw new Error('无法连接 Folio，请确认桌面工作台已打开并完成浏览器桥接安装。');
  }
  nativePort = port;
  port.onMessage.addListener((response) => {
    const request = pendingRequests.get(response?.id);
    if (!request) return;
    pendingRequests.delete(response.id);
    clearTimeout(request.timeout);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(errorMessage(response.error)));
  });
  port.onDisconnect.addListener(() => {
    const reason = nativeConnectionError(chrome.runtime.lastError?.message || 'Folio 浏览器桥已断开。');
    if (nativePort === port) nativePort = null;
    for (const [id, request] of pendingRequests) {
      pendingRequests.delete(id);
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    }
    scheduleReconnect();
  });
  scheduleReconnect();
  return port;
}

function nativeRequest(message, timeoutMs = 15000) {
  const port = connectNative();
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('本机 Folio 请求超时，请重试。'));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
    try {
      port.postMessage({ ...message, id });
    } catch {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      if (nativePort === port) nativePort = null;
      reject(new Error('Folio 浏览器桥已断开，请稍后重试。'));
    }
  });
}

function permissionOrigin(url) {
  return FolioCapture.pdfPermissionOrigins(url)[0] || '';
}

async function captureWithoutPdf(message, pdfError = '') {
  const result = await nativeRequest({
    type: 'FOLIO_CAPTURE',
    item: message.item,
    folderId: message.folderId,
  }, 120000);
  if (pdfError) result.pdf_import = { status: 'failed', error: pdfError };
  return result;
}

async function capture(message) {
  const pdfUrl = typeof message.pdfUrl === 'string' ? message.pdfUrl : '';
  if (!pdfUrl) return captureWithoutPdf(message);
  const origin = permissionOrigin(pdfUrl);
  if (!message.fetchPdf || !origin || !(await chrome.permissions.contains({ origins: [origin] }))) {
    return captureWithoutPdf(message, '浏览器尚未授权读取 PDF 来源。');
  }

  let pdf;
  if (typeof message.pdfBase64 === 'string') {
    try {
      FolioCapture.validatePdfBase64(message.pdfBase64);
      pdf = {
        base64: message.pdfBase64,
        name: FolioCapture.fileNameFromUrl(pdfUrl, message.item?.title || ''),
      };
    } catch (error) {
      return captureWithoutPdf(message, errorMessage(error));
    }
  } else {
    try {
      pdf = await FolioCapture.downloadPdf(pdfUrl);
    } catch (error) {
      return captureWithoutPdf(message, errorMessage(error));
    }
  }

  let captureId = '';
  try {
    const begun = await nativeRequest({
      type: 'FOLIO_CAPTURE_BEGIN',
      item: message.item,
      folderId: message.folderId,
    }, 15000);
    captureId = begun.captureId;
    for (let start = 0, index = 0; start < pdf.base64.length; start += PDF_CHUNK_CHARS, index += 1) {
      await nativeRequest({
        type: 'FOLIO_CAPTURE_PDF_CHUNK',
        captureId,
        index,
        chunk: pdf.base64.slice(start, start + PDF_CHUNK_CHARS),
      }, 30000);
    }
    return await nativeRequest({
      type: 'FOLIO_CAPTURE_FINISH',
      captureId,
      pdfName: pdf.name,
    }, 120000);
  } catch (error) {
    if (captureId) {
      return captureWithoutPdf(message, errorMessage(error));
    }
    throw error;
  }
}

async function importCitationExport(message) {
  if (!['bibtex', 'ris'].includes(message.format)) throw new Error('仅支持 BibTeX 和 RIS 导出。');
  const url = FolioCapture.safeUrl(message.url);
  const origin = permissionOrigin(url);
  if (!url || !origin || !(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new Error('请先授权读取该文献来源。');
  }
  const data = await FolioCapture.downloadCitationExport(url);
  return nativeRequest({ type: 'FOLIO_PARSE', format: message.format, data }, 120000);
}

async function handle(message) {
  if (!message || typeof message.type !== 'string') throw new Error('扩展请求无效。');
  if (message.type === 'FOLIO_CAPTURE') return capture(message);
  if (message.type === 'FOLIO_IMPORT_EXPORT') return importCitationExport(message);
  return nativeRequest(message, message.type === 'FOLIO_PARSE' ? 120000 : 15000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!popupSender(sender)) return false;
  handle(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'folio-native-status') void nativeRequest({ type: 'FOLIO_STATUS' }).catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  scheduleReconnect();
  void nativeRequest({ type: 'FOLIO_STATUS' }).catch(() => {});
});

chrome.runtime.onInstalled?.addListener(() => {
  scheduleReconnect();
  void nativeRequest({ type: 'FOLIO_STATUS' }).catch(() => {});
});

scheduleReconnect();
void nativeRequest({ type: 'FOLIO_STATUS' }).catch(() => {});
