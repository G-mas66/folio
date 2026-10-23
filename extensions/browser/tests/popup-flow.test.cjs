'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class FakeNode {
  constructor(tagName = 'div', text = '') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this._text = text;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.className = '';
    this.classList = {
      add: (name) => { this.className = [...new Set((this.className + ' ' + name).trim().split(/\s+/))].join(' '); },
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force === undefined ? !names.has(name) : force) names.add(name);
        else names.delete(name);
        this.className = [...names].join(' ');
      },
    };
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent || '').join('');
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeNode('#text', node) : node);
  }

  appendChild(node) { this.append(node); return node; }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  async click() {
    for (const listener of this.listeners.get('click') || []) await listener({ target: this, currentTarget: this });
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    for (const id of [
      'connection-state', 'app-view', 'page-caption', 'refresh-page', 'candidate-list',
      'folder-select', 'capture-button', 'page-message', 'capture-results', 'citation-style',
      'search-results', 'search-query', 'search-form', 'reconnect-button',
    ]) this.nodes.set('#' + id, new FakeNode('div'));
  }

  querySelector(selector) { return this.nodes.get(selector) || null; }
  createElement(tagName) { return new FakeNode(tagName); }
  createTextNode(text) { return new FakeNode('#text', text); }
}

function findByText(root, text) {
  return root.descendants().find((node) => node.textContent === text);
}

function waitForUi() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test('successful reconnect clears its previous error and preserves DOI, capture, and import errors', async () => {
  const document = new FakeDocument();
  let connected = false;
  const chrome = {
    runtime: {
      async sendMessage(message) {
        if (message.type === 'FOLIO_STATUS') return connected
          ? { ok: true, result: { connected: true } }
          : { ok: false, error: 'Access to the specified native messaging host is forbidden.' };
        if (message.type === 'FOLIO_FOLDERS') return { ok: true, result: [] };
        if (message.type === 'FOLIO_RESOLVE') return { ok: false, error: 'DOI service unavailable' };
        if (message.type === 'FOLIO_CAPTURE') return { ok: false, error: 'Capture failed' };
        if (message.type === 'FOLIO_IMPORT_EXPORT') return { ok: false, error: 'Export download failed' };
        throw new Error('Unexpected RPC: ' + message.type);
      },
    },
    tabs: {
      query: async () => [{ id: 12, title: 'Paper', url: 'https://publisher.example/paper' }],
      sendMessage: async () => ({ kind: 'page', candidates: [{
        title: 'Paper', doi: '10.5555/paper', url: 'https://publisher.example/paper',
        citation_exports: [{ url: 'https://publisher.example/export.bib', format: 'bibtex' }],
      }] }),
    },
    scripting: { executeScript: async () => [] },
    permissions: { request: async () => true },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../popup.js'), 'utf8'), {
    document, chrome, FolioCapture: require('../shared.js'), URL,
  });
  await waitForUi();
  const pageMessage = document.querySelector('#page-message');
  const badge = document.querySelector('#connection-state');
  assert.match(pageMessage.textContent, /forbidden/);
  assert.equal(pageMessage.hidden, false);

  connected = true;
  const reconnect = document.querySelector('#reconnect-button');
  await reconnect.click();
  await waitForUi();
  assert.equal(badge.textContent, '已连接');
  assert.equal(pageMessage.textContent, '');
  assert.equal(pageMessage.hidden, true);
  assert.equal(pageMessage.className.includes('error'), false);

  const candidates = document.querySelector('#candidate-list');
  await findByText(candidates, '核对 DOI 信息').click();
  await waitForUi();
  await reconnect.click();
  await waitForUi();
  assert.match(candidates.textContent, /DOI 查询失败：DOI service unavailable/);

  await findByText(candidates, '仍用页面元数据收藏').click();
  await document.querySelector('#capture-button').click();
  await waitForUi();
  await findByText(candidates, '获取 BIBTEX').click();
  await waitForUi();
  await reconnect.click();
  await waitForUi();
  assert.equal(badge.textContent, '已连接');
  assert.match(document.querySelector('#capture-results').textContent, /收藏失败：Capture failed/);
  assert.match(pageMessage.textContent, /读取 BibTeX\/RIS 失败：Export download failed/);
  assert.equal(pageMessage.hidden, false);
  assert.equal(pageMessage.className.includes('error'), true);
});

test('popup reviews DOI metadata before save, keeps the source/PDF, retries PDF, and confirms explicitly', async () => {
  const document = new FakeDocument();
  const calls = [];
  const captureCalls = [];
  const permissionRequests = [];
  const pageScriptCalls = [];
  const pageFetchRequests = [];
  const grantedOrigins = new Set();
  const pagePdfBytes = Buffer.from('%PDF-1.7\npage fixture', 'utf8');
  let pdfImportAttempt = 0;
  const savedCsl = {
    id: 'stable-record-42', type: 'article-journal', title: 'Authoritative DOI title',
    author: [{ given: 'Md Mahfuzur', family: 'Rahman Siddiquee' }],
    issued: { 'date-parts': [[2024]] }, DOI: '10.5555/folio.compound',
    URL: 'https://publisher.example/article/42', 'container-title': 'Formal Journal',
    publisher: 'Acme Press', 'custom-field': 'preserved from source CSL',
  };
  const response = (result) => Promise.resolve({ ok: true, result });
  const chrome = {
    runtime: {
      sendMessage(message) {
        calls.push(message);
        if (message.type === 'FOLIO_STATUS') return response({ connected: true });
        if (message.type === 'FOLIO_FOLDERS') return response([{ id: 'folder-1', name: 'Papers' }]);
        if (message.type === 'FOLIO_RESOLVE') return response({
          doi: '10.5555/folio.compound', source: 'crossref',
          source_url: 'https://api.crossref.org/works/10.5555/folio.compound',
          record: {
            id: 'preview', type: 'article-journal', title: 'Authoritative DOI title',
            author: [{ given: 'Md Mahfuzur', family: 'Rahman Siddiquee' }],
            issued: { 'date-parts': [[2024]] }, DOI: '10.5555/folio.compound',
            URL: 'https://doi.org/10.5555/folio.compound', 'container-title': 'Formal Journal',
            publisher: 'Acme Press',
          },
        });
        if (message.type === 'FOLIO_IMPORT_EXPORT') return response({ items: [{
          record: {
            type: 'article-journal', title: 'BibTeX candidate',
            author: [{ given: 'Grace', family: 'Hopper' }],
            DOI: '10.5555/folio.bib',
          },
          source_citation: '@article{bib, title={BibTeX candidate}}',
        }] });
        if (message.type === 'FOLIO_CAPTURE') {
          captureCalls.push(message);
          pdfImportAttempt += 1;
          return response({
            item: { id: 'stable-record-42', csl: savedCsl },
            duplicate_record: pdfImportAttempt > 1,
            pdf_import: pdfImportAttempt === 1
              ? { status: 'failed', error: 'temporary PDF import failure' }
              : { status: 'imported' },
          });
        }
        if (message.type === 'FOLIO_PREVIEW') {
          assert.equal(message.record.id, 'stable-record-42');
          return response({
            citation_text: 'Doe (2024)', bibliography_text: 'Doe. (2024). Formal Journal.',
            fingerprint: 'a'.repeat(64),
          });
        }
        if (message.type === 'FOLIO_CONFIRM') return response({ confirmed: true });
        throw new Error('Unexpected RPC: ' + message.type);
      },
    },
    tabs: {
      query: async () => [{ id: 12, title: 'A page with an author name', url: 'https://publisher.example/article/42' }],
      sendMessage: async () => ({ kind: 'scholar', candidates: [{
        title: 'Homepage title',
        authors: [{ given: 'Md Mahfuzur Rahman', family: 'Siddiquee' }],
        year: 2023,
        container_title: 'Preprint page',
        doi: '10.5555/folio.compound',
        url: 'https://publisher.example/article/42',
        citation_exports: [{ url: 'https://publisher.example/export.bib', format: 'bibtex' }],
        pdf_url: 'https://publisher.example/article-42.pdf',
        pdf_candidates: ['https://publisher.example/article-42.pdf'],
        item_type: 'journal-article',
        source: 'browser',
        csl: {
          id: 'source-record', type: 'article-journal', title: 'Homepage title',
          author: [{ given: 'Md Mahfuzur Rahman', family: 'Siddiquee' }],
          DOI: '10.5555/folio.compound', URL: 'https://publisher.example/article/42',
          'custom-field': 'preserved from source CSL',
        },
      }, {
        title: 'Second selected paper', authors: [{ given: 'Grace', family: 'Hopper' }],
        year: 2022, container_title: 'Another Journal', url: 'https://other-publisher.example/article/7',
        pdf_url: 'https://other-publisher.example/article-7.pdf',
        pdf_candidates: ['https://other-publisher.example/article-7.pdf'], item_type: 'journal-article',
        source: 'scholar', csl: { type: 'article-journal', title: 'Second selected paper' },
      }] }),
    },
    scripting: {
      executeScript: async (details) => {
        if (!details.func) return [];
        pageScriptCalls.push(details);
        const result = await details.func(...details.args);
        return [{ frameId: 0, result }];
      },
    },
    permissions: {
      request: async (request) => {
        permissionRequests.push({ request, captureCount: captureCalls.length });
        for (const origin of request.origins || []) grantedOrigins.add(origin);
        return true;
      },
      contains: async ({ origins }) => origins.every((origin) => grantedOrigins.has(origin)),
    },
  };
  document.querySelector('#citation-style').value = 'apa';
  const context = {
    document, chrome, FolioCapture: require('../shared.js'), URL, setTimeout, clearTimeout,
    AbortController, btoa, location: { origin: 'https://publisher.example' },
    fetch: async (url, options) => {
      pageFetchRequests.push({ url, options });
      const response = new Response(pagePdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../popup.js'), 'utf8'), context);
  await waitForUi();
  await waitForUi();

  const folderSelect = document.querySelector('#folder-select');
  folderSelect.value = 'folder-1';
  const candidateList = document.querySelector('#candidate-list');
  await findByText(document.querySelector('#page-caption'), '全选').click();
  await waitForUi();
  await findByText(candidateList, '获取 BIBTEX').click();
  await waitForUi();
  assert.ok(candidateList.textContent.includes('BibTeX candidate'));
  assert.ok(candidateList.textContent.includes('Homepage title'), 'BibTeX is added as a separate candidate');
  assert.ok(permissionRequests.some(({ request }) => request.origins?.includes('https://publisher.example/*')));
  assert.equal(calls.find((call) => call.type === 'FOLIO_IMPORT_EXPORT').format, 'bibtex');
  const captureButton = document.querySelector('#capture-button');
  assert.equal(captureButton.disabled, true, 'DOI candidates must be reviewed before saving');
  assert.ok(findByText(document.querySelector('#candidate-list'), '核对 DOI 信息'));

  await findByText(document.querySelector('#candidate-list'), '核对 DOI 信息').click();
  await waitForUi();
  assert.equal(captureButton.disabled, true, 'the user must choose whether to use resolved metadata');
  assert.equal(captureCalls.length, 0);
  assert.ok(candidateList.textContent.includes('Rahman Siddiquee'));
  assert.ok(findByText(candidateList, '采用查到的元数据'));
  await findByText(candidateList, '采用查到的元数据').click();
  assert.equal(captureButton.disabled, false);

  permissionRequests.length = 0;
  await captureButton.click();
  await waitForUi();
  assert.equal(permissionRequests.length, 1, 'one permission request covers all selected PDF origins');
  assert.deepEqual(Array.from(permissionRequests[0].request.origins), [
    'https://publisher.example/*', 'https://other-publisher.example/*',
  ]);
  assert.equal(permissionRequests[0].captureCount, 0, 'permission is requested before asynchronous capture begins');
  const firstCapture = captureCalls[0];
  assert.equal(firstCapture.folderId, 'folder-1');
  assert.equal(firstCapture.pdfUrl, 'https://publisher.example/article-42.pdf');
  assert.equal(firstCapture.fetchPdf, true);
  assert.equal('referrer' in firstCapture, false, 'the page URL is not forwarded as a worker referrer');
  assert.equal(firstCapture.pdfBase64, pagePdfBytes.toString('base64'));
  assert.equal(pageScriptCalls.length, 1, 'same-origin PDFs are fetched in the active page context');
  assert.equal(pageScriptCalls[0].world, 'MAIN');
  assert.equal(pageScriptCalls[0].target.tabId, 12);
  assert.deepEqual(pageFetchRequests.map(({ url }) => url), ['https://publisher.example/article-42.pdf']);
  assert.equal(pageFetchRequests[0].options.credentials, 'same-origin');
  assert.equal(pageFetchRequests[0].options.redirect, 'error');
  assert.equal(captureCalls[1].pdfUrl, 'https://other-publisher.example/article-7.pdf');
  assert.equal(captureCalls[1].fetchPdf, true);
  assert.equal(captureCalls[1].pdfBase64, undefined, 'cross-origin candidates stay on the permissioned worker path');
  assert.deepEqual(firstCapture.item.authors, [{ given: 'Md Mahfuzur', family: 'Rahman Siddiquee' }]);
  assert.equal(firstCapture.item.doi, '10.5555/folio.compound');
  assert.equal(firstCapture.item.url, 'https://publisher.example/article/42');
  assert.equal(firstCapture.item.csl['custom-field'], 'preserved from source CSL');
  assert.equal(firstCapture.item.csl.URL, 'https://publisher.example/article/42');
  assert.equal(calls.filter((call) => call.type === 'FOLIO_CONFIRM').length, 0);

  const retry = findByText(document.querySelector('#capture-results'), '重试 PDF 导入');
  assert.ok(retry);
  await retry.click();
  await waitForUi();
  assert.equal(captureCalls.length, 3);
  assert.deepEqual(Array.from(permissionRequests[1].request.origins), ['https://publisher.example/*']);
  assert.equal(permissionRequests[1].captureCount, 2, 'retry requests permission from its own click gesture');
  assert.equal(captureCalls[2].item.doi, '10.5555/folio.compound');

  const confirm = findByText(document.querySelector('#capture-results'), '确认此引用格式');
  assert.ok(confirm, 'a separate action is required to confirm the preview');
  await confirm.click();
  await waitForUi();
  const confirmation = calls.find((call) => call.type === 'FOLIO_CONFIRM');
  assert.equal(confirmation.recordId, 'stable-record-42');
  assert.equal(confirmation.style, 'apa');
  assert.equal(confirmation.fingerprint, 'a'.repeat(64));
});
