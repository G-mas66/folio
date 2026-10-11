'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const FolioCapture = require('../shared.js');

function meta(name, content) {
  return {
    getAttribute(attribute) {
      if (attribute === 'name') return name;
      if (attribute === 'content') return content;
      return null;
    },
  };
}

function link(href, text = '', type = '') {
  return {
    href,
    textContent: text,
    getAttribute(attribute) {
      if (attribute === 'href') return href;
      if (attribute === 'type') return type;
      return null;
    },
  };
}

test('safeUrl accepts public HTTP(S) links and rejects local or credential-bearing URLs', () => {
  assert.equal(FolioCapture.safeUrl('https://example.org/article'), 'https://example.org/article');
  assert.equal(FolioCapture.safeUrl('https://fcu-journal.example/article'), 'https://fcu-journal.example/article');
  for (const url of [
    'file:///tmp/paper.pdf',
    'javascript:alert(1)',
    'http://localhost/private.pdf',
    'http://127.0.0.1/private.pdf',
    'http://[::ffff:7f00:1]/private.pdf',
    'http://192.168.1.5/private.pdf',
    'http://user:pass@example.org/paper.pdf',
    'http://printer.local/paper.pdf',
  ]) {
    assert.equal(FolioCapture.safeUrl(url), '', url);
  }
});

test('conference citation metadata maps to the CSL conference type', () => {
  const metas = [
    meta('citation_title', 'Proceedings paper'),
    meta('citation_conference_title', 'Research Conference'),
  ];
  const document = {
    title: 'Proceedings paper',
    body: { textContent: '' },
    querySelectorAll: (selector) => selector.startsWith('meta') ? metas : [],
    querySelector: () => null,
  };
  const result = FolioCapture.extractPageMetadata(document, 'https://conference.example/paper');
  assert.equal(result.container_title, 'Research Conference');
  assert.equal(result.item_type, 'paper-conference');
});

test('page extraction reads common citation metadata while leaving absent fields empty', () => {
  const metas = [
    meta('citation_title', 'A Study of Safe Collectors'),
    meta('citation_author', 'Ada Lovelace'),
    meta('citation_author', 'Hopper, Grace'),
    meta('citation_publication_date', '2024-06-01'),
    meta('citation_journal_title', 'Journal of Tools'),
    meta('citation_doi', 'https://doi.org/10.5555/folio.24'),
    meta('citation_pdf_url', '/paper.pdf'),
  ];
  const document = {
    title: 'Ignored browser title',
    body: { textContent: '' },
    querySelectorAll(selector) {
      return selector.startsWith('meta') ? metas : [link('https://example.org/paper.pdf', 'PDF', 'application/pdf')];
    },
    querySelector(selector) {
      return selector === 'link[rel="canonical"]' ? { getAttribute: () => 'https://example.org/article' } : null;
    },
  };
  const result = FolioCapture.extractPageMetadata(document, 'https://example.org/redirected');
  assert.equal(result.title, 'A Study of Safe Collectors');
  assert.deepEqual(result.authors, [
    { given: 'Ada', family: 'Lovelace' },
    { given: 'Grace', family: 'Hopper' },
  ]);
  assert.equal(result.year, 2024);
  assert.equal(result.container_title, 'Journal of Tools');
  assert.equal(result.doi, '10.5555/folio.24');
  assert.equal(result.url, 'https://example.org/article');
  assert.equal(result.pdf_url, 'https://example.org/paper.pdf');
  assert.equal(result.pages, '');
});

test('PRISM URL is an article link fallback and never a PDF candidate', () => {
  const metas = [meta('prism.url', 'https://publisher.example/article/123')];
  const document = {
    title: 'Publisher article',
    body: { textContent: '' },
    querySelectorAll: (selector) => selector.startsWith('meta') ? metas : [],
    querySelector: () => null,
  };
  const result = FolioCapture.extractPageMetadata(document, 'https://landing.example/article/123');
  assert.equal(result.url, 'https://publisher.example/article/123');
  assert.equal(result.pdf_url, '');
  assert.deepEqual(result.pdf_candidates, []);
});

test('Scholar extraction returns multiple selectable records and associated PDF candidates', () => {
  const createResult = (title, href, pdfHref, authors) => {
    const titleAnchor = link(href, title);
    const pdfAnchor = link(pdfHref, 'PDF');
    return {
      textContent: authors + ' DOI 10.5555/folio.2024',
      querySelector(selector) {
        if (selector === '.gs_rt a[href]') return titleAnchor;
        if (selector === '.gs_rt') return titleAnchor;
        if (selector === '.gs_a') return { textContent: authors };
        return null;
      },
      querySelectorAll() { return [titleAnchor, pdfAnchor]; },
    };
  };
  const results = [
    createResult('Paper One', 'https://example.org/one', 'https://example.org/one.pdf', 'Ada Lovelace, Grace Hopper - Journal, 2024 - Google Scholar'),
    createResult('Paper Two', 'https://example.net/two', 'https://example.net/two.pdf', 'Alan Turing - Conference, 2023 - Google Scholar'),
  ];
  const document = { querySelectorAll: () => results };
  const found = FolioCapture.extractScholarResults(document);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((item) => item.title), ['Paper One', 'Paper Two']);
  assert.equal(found[0].authors.length, 2);
  assert.equal(found[0].year, 2024);
  assert.equal(found[0].container_title, 'Journal');
  assert.equal(found[0].pdf_url, 'https://example.org/one.pdf');
});

test('PDF tab detection supports direct URLs and the built-in viewer source', () => {
  assert.equal(FolioCapture.pdfUrlFromTab('https://example.org/files/paper.PDF?download=1'), 'https://example.org/files/paper.PDF?download=1');
  assert.equal(
    FolioCapture.pdfUrlFromTab('chrome-extension://viewer/index.html?src=' + encodeURIComponent('https://example.org/files/paper.pdf')),
    'https://example.org/files/paper.pdf',
  );
  assert.equal(FolioCapture.pdfUrlFromTab('chrome://settings'), '');
});

test('base64 encoding handles multi-block files without changing bytes', () => {
  const bytes = Uint8Array.from({ length: 50000 }, (_, index) => index % 251);
  assert.equal(FolioCapture.encodeBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('PDF download checks Content-Length before reading the response body', async () => {
  const response = new Response(null, { status: 200, headers: { 'content-length': String(FolioCapture.MAX_PDF_BYTES + 1) } });
  await assert.rejects(
    FolioCapture.downloadPdf('https://example.org/large.pdf', { fetchImpl: async () => response }),
    /超过 25 MiB/,
  );
});

test('PDF download enforces the streaming cap even without Content-Length', async () => {
  let canceled = false;
  const response = {
    ok: true,
    status: 200,
    url: 'https://example.org/paper.pdf',
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(FolioCapture.MAX_PDF_BYTES + 1) }),
        cancel: async () => { canceled = true; },
        releaseLock() {},
      }),
    },
  };
  await assert.rejects(
    FolioCapture.downloadPdf('https://example.org/paper.pdf', { fetchImpl: async () => response }),
    /超过 25 MiB/,
  );
  assert.equal(canceled, true);
});

test('PDF download aborts when the read times out', async () => {
  await assert.rejects(
    FolioCapture.downloadPdf('https://example.org/paper.pdf', {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    }),
    /超时/,
  );
});

test('PDF download refuses redirects and suggests opening the final PDF URL', async () => {
  const requests = [];
  await assert.rejects(
    FolioCapture.downloadPdf('https://example.org/paper.pdf', {
      fetchImpl: async (url, options) => {
        requests.push({ url, redirect: options.redirect });
        if (options.redirect === 'error') throw new TypeError('Failed to fetch');
        return new Response('%PDF-1.7', { status: 200 });
      },
    }),
    /直接打开最终 PDF 地址后重试/,
  );
  assert.deepEqual(requests, [{ url: 'https://example.org/paper.pdf', redirect: 'error' }]);
});
