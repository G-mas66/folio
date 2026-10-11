'use strict';

(() => {
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const MAX_CANDIDATES = 20;
  const DOI_PATTERN = /\b10\.\d{4,9}\/[\w.()/:;-]+/i;

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isPrivateIpv4(host) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second, third] = parts;
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 168 || (second === 0 && third === 0) || (second === 0 && third === 2)))
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0 && third === 113);
  }

  function safeUrl(value, base = undefined) {
    if (typeof value !== 'string' || !value.trim()) return '';
    let url;
    try { url = new URL(value.trim(), base); } catch { return ''; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
        || host.endsWith('.internal') || host.endsWith('.lan') || isPrivateIpv4(host)) return '';
    if (!host.includes('.') && !host.includes(':')) return '';
    if (host.includes(':')) {
      if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
          || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea')
          || host.startsWith('feb') || host.startsWith('ff')) return '';
      if (host.startsWith('::ffff:')) return '';
    }
    return url.href;
  }

  function parseAuthor(name) {
    const value = cleanText(name);
    if (!value) return null;
    const comma = value.match(/^([^,]+),\s*(.+)$/);
    if (comma) return { given: cleanText(comma[2]), family: cleanText(comma[1]) };
    const pieces = value.split(' ');
    if (pieces.length > 1) return { given: pieces.slice(0, -1).join(' '), family: pieces[pieces.length - 1] };
    return { given: '', family: value };
  }

  function parseAuthors(values) {
    return values.map(parseAuthor).filter(Boolean).slice(0, 100);
  }

  function metaValues(document, names) {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    return Array.from(document.querySelectorAll('meta[name], meta[property], meta[itemprop]'))
      .filter((node) => wanted.has((node.getAttribute('name') || node.getAttribute('property') || node.getAttribute('itemprop') || '').toLowerCase()))
      .map((node) => cleanText(node.getAttribute('content')))
      .filter(Boolean);
  }

  function metaValue(document, names) {
    return metaValues(document, names)[0] || '';
  }

  function yearFrom(values) {
    for (const value of values) {
      const match = /(?:^|\D)(1\d{3}|2\d{3})(?:\D|$)/.exec(value);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function doiFrom(value) {
    const match = DOI_PATTERN.exec(String(value || ''));
    return match ? match[0].replace(/[.,;]+$/, '') : '';
  }

  function pdfCandidates(document, baseUrl, candidates = []) {
    const values = new Set();
    for (const value of candidates) {
      const url = safeUrl(value, baseUrl);
      if (url) values.add(url);
    }
    for (const link of Array.from(document.querySelectorAll('a[href], link[href]')).slice(0, 300)) {
      const raw = link.getAttribute('href') || '';
      const text = cleanText(link.textContent);
      const type = (link.getAttribute('type') || '').toLowerCase();
      if (type === 'application/pdf' || /\.pdf(?:$|[?#])/i.test(raw) || /^pdf$/i.test(text)) {
        const url = safeUrl(raw, baseUrl);
        if (url) values.add(url);
      }
    }
    return Array.from(values).slice(0, 5);
  }

  function extractPageMetadata(document, pageUrl) {
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    const authors = metaValues(document, ['citation_author', 'dc.creator', 'dc.contributor.author', 'author']);
    const title = metaValue(document, ['citation_title', 'dc.title', 'og:title', 'twitter:title'])
      || cleanText(document.title).replace(/\s+[|–—-]\s+Google Scholar$/i, '');
    const dateValues = metaValues(document, ['citation_publication_date', 'citation_date', 'dc.date', 'date', 'article:published_time']);
    const doiValue = metaValue(document, ['citation_doi', 'dc.identifier', 'prism.doi', 'doi']);
    const prismUrl = metaValue(document, ['prism.url']);
    const articleUrl = safeUrl(canonical, pageUrl) || safeUrl(prismUrl, pageUrl) || safeUrl(pageUrl);
    const pdfValues = metaValues(document, ['citation_pdf_url', 'pdf_url']);
    const journalTitle = metaValue(document, ['citation_journal_title']);
    const conferenceTitle = metaValue(document, ['citation_conference_title']);
    const otherContainer = metaValue(document, ['dc.source', 'prism.publicationName']);
    const containerTitle = conferenceTitle || journalTitle || otherContainer;
    const volume = metaValue(document, ['citation_volume', 'prism.volume']);
    const issue = metaValue(document, ['citation_issue', 'prism.number']);
    const firstPage = metaValue(document, ['citation_firstpage', 'citation_start_page', 'prism.startingPage']);
    const lastPage = metaValue(document, ['citation_lastpage', 'citation_end_page', 'prism.endingPage']);
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    const doi = doiFrom(doiValue) || doiFrom(bodyText);
    const pageYear = yearFrom(dateValues);
    const itemType = conferenceTitle ? 'paper-conference' : containerTitle ? 'journal-article' : 'article';
    const pdfs = pdfCandidates(document, articleUrl || pageUrl, pdfValues);
    return {
      title,
      authors: parseAuthors(authors),
      year: pageYear,
      container_title: containerTitle,
      doi,
      url: articleUrl,
      pdf_url: pdfs[0] || '',
      pdf_candidates: pdfs,
      volume,
      issue,
      pages: firstPage && lastPage ? firstPage + '-' + lastPage : (firstPage || lastPage),
      item_type: itemType,
      source: 'browser',
    };
  }

  function extractScholarResults(document) {
    const results = Array.from(document.querySelectorAll('.gs_r.gs_or.gs_scl, .gs_r.gs_or')).slice(0, MAX_CANDIDATES);
    const candidates = [];
    for (const result of results) {
      const titleLink = result.querySelector('.gs_rt a[href]');
      const titleNode = result.querySelector('.gs_rt');
      const title = cleanText(titleLink?.textContent || titleNode?.textContent).replace(/^\[(?:PDF|HTML)\]\s*/i, '');
      const pageUrl = safeUrl(titleLink?.getAttribute('href') || '');
      if (!title && !pageUrl) continue;
      const authorsLine = cleanText(result.querySelector('.gs_a')?.textContent);
      const parts = authorsLine.split(/\s+[–-]\s+/);
      const authors = parts[0] ? parseAuthors(parts[0].split(/,\s*/).filter(Boolean)) : [];
      const year = yearFrom([authorsLine, result.textContent || '']);
      const venue = parts[1] ? cleanText(parts[1].replace(/,?\s+(?:19|20)\d{2}\b.*$/i, '')) : '';
      const anchors = Array.from(result.querySelectorAll('a[href]'));
      const doi = doiFrom((result.textContent || '') + ' ' + anchors.map((anchor) => anchor.href || '').join(' '));
      const pdfs = pdfCandidates(
        result,
        pageUrl || undefined,
        anchors.filter((anchor) => /pdf/i.test(cleanText(anchor.textContent)) || /\.pdf(?:$|[?#])/i.test(anchor.getAttribute('href') || ''))
          .map((anchor) => anchor.getAttribute('href') || ''),
      );
      candidates.push({
        title,
        authors,
        year,
        container_title: venue,
        doi,
        url: pageUrl,
        pdf_url: pdfs[0] || '',
        pdf_candidates: pdfs,
        volume: '',
        issue: '',
        pages: '',
        item_type: venue ? 'journal-article' : 'article',
        source: 'scholar',
      });
    }
    return candidates;
  }

  function extractPage(document, pageUrl) {
    const scholar = extractScholarResults(document);
    if (scholar.length) return { kind: 'scholar', candidates: scholar };
    return { kind: 'page', candidates: [extractPageMetadata(document, pageUrl)] };
  }

  function pdfUrlFromTab(tabUrl) {
    let url;
    try { url = new URL(tabUrl); } catch { return ''; }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return /\.pdf$/i.test(url.pathname) ? safeUrl(url.href) : '';
    }
    const source = url.searchParams.get('src') || url.searchParams.get('file') || '';
    const safe = safeUrl(source);
    return safe && /\.pdf(?:$|[?#])/i.test(safe) ? safe : '';
  }

  function fileNameFromUrl(url, title = '') {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (name && name.toLowerCase().endsWith('.pdf')) return name.slice(0, 180);
    } catch {}
    const fallback = cleanText(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'captured-paper';
    return fallback.toLowerCase().endsWith('.pdf') ? fallback : fallback + '.pdf';
  }

  function encodeBase64(bytes) {
    const blockSize = 24576;
    let output = '';
    for (let start = 0; start < bytes.length; start += blockSize) {
      const slice = bytes.subarray(start, Math.min(start + blockSize, bytes.length));
      let binary = '';
      for (let offset = 0; offset < slice.length; offset += 8192) {
        binary += String.fromCharCode(...slice.subarray(offset, Math.min(offset + 8192, slice.length)));
      }
      output += btoa(binary);
    }
    return output;
  }

  async function downloadPdf(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    const safe = safeUrl(url);
    if (!safe) throw new Error('PDF 链接不安全或无效。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(safe, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('PDF 下载失败（HTTP ' + response.status + '）。');
      const length = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(length) && length > MAX_PDF_BYTES) throw new Error('PDF 超过 25 MiB 限制。');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取 PDF 数据。');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_PDF_BYTES) {
            await reader.cancel();
            throw new Error('PDF 超过 25 MiB 限制。');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!size) throw new Error('PDF 文件为空。');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const prefix = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
      if (!prefix.includes('%PDF-')) throw new Error('下载内容不是 PDF。');
      return {
        base64: encodeBase64(bytes),
        name: fileNameFromUrl(response.url || safe),
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PDF 下载超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error('PDF 请求失败。若链接会跳转，请直接打开最终 PDF 地址后重试。');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const api = {
    MAX_PDF_BYTES,
    MAX_CANDIDATES,
    cleanText,
    safeUrl,
    parseAuthors,
    doiFrom,
    extractPageMetadata,
    extractScholarResults,
    extractPage,
    pdfUrlFromTab,
    fileNameFromUrl,
    encodeBase64,
    downloadPdf,
  };
  globalThis.FolioCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
