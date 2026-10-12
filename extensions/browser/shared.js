'use strict';

(() => {
  const MAX_PDF_BYTES = 25 * 1024 * 1024;
  const MAX_EXPORT_BYTES = 512 * 1024;
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
    if (value.startsWith('{{') && value.endsWith('}}')) return { literal: cleanText(value.slice(2, -2)) };
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

  function jsonLdValues(document) {
    const values = [];
    for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 30)) {
      try {
        const parsed = JSON.parse(node.textContent || '');
        const queue = Array.isArray(parsed) ? parsed.slice(0, 100) : [parsed];
        for (const value of queue) {
          if (!value || typeof value !== 'object') continue;
          values.push(value);
          if (Array.isArray(value['@graph'])) values.push(...value['@graph'].filter((item) => item && typeof item === 'object').slice(0, 100));
        }
      } catch {}
    }
    return values;
  }

  function jsonLdArticle(document) {
    return jsonLdValues(document).find((value) => {
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      return types.some((type) => /article|chapter|thesis|creativework/i.test(String(type || '')))
        && (value.headline || value.name || value.identifier || value.author);
    }) || {};
  }

  function jsonLdName(value) {
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return jsonLdName(value[0]);
    return cleanText(value?.name || value?.alternateName || value?.headline || '');
  }

  function jsonLdAuthors(values) {
    const authors = Array.isArray(values) ? values : values ? [values] : [];
    return authors.map((author) => {
      if (typeof author === 'string') return parseAuthor(author);
      if (!author || typeof author !== 'object') return null;
      const name = jsonLdName(author);
      const type = String(author['@type'] || '').toLowerCase();
      if (type === 'organization') {
        return name ? { literal: name } : null;
      }
      const given = cleanText(author.givenName || author.given || '');
      const family = cleanText(author.familyName || author.family || '');
      return given || family ? { given, family } : (name ? parseAuthor(name) : null);
    }).filter(Boolean).slice(0, 100);
  }

  function dedupeAuthors(authors) {
    const seen = new Set();
    return authors.filter((author) => {
      const key = [author.literal || '', author.given || '', author.family || ''].join('\u0000').toLowerCase();
      if (!key.replace(/\u0000/g, '')) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 100);
  }

  function citationExports(document, baseUrl) {
    const exports = [];
    const seen = new Set();
    for (const link of Array.from(document.querySelectorAll('a[href], link[href]')).slice(0, 300)) {
      const raw = link.getAttribute('href') || '';
      const safe = safeUrl(raw, baseUrl);
      if (!safe || seen.has(safe)) continue;
      const text = cleanText((link.textContent || '') + ' ' + (link.getAttribute('aria-label') || '') + ' ' + (link.getAttribute('title') || '')).toLowerCase();
      const parsed = new URL(safe);
      const hint = (parsed.pathname + parsed.search).toLowerCase();
      let format = '';
      if (/\.bib(?:tex)?(?:$|[?#])|bibtex|bib\s*tex/.test(hint + ' ' + text)) format = 'bibtex';
      else if (/\.ris(?:$|[?#])|\bris\b|endnote/.test(hint + ' ' + text)) format = 'ris';
      if (!format) continue;
      seen.add(safe);
      exports.push({ url: safe, format });
      if (exports.length >= 5) break;
    }
    return exports;
  }

  function publisherAdapter(pageUrl) {
    let host = '';
    let path = '';
    try {
      const parsed = new URL(pageUrl);
      host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      path = parsed.pathname;
    } catch {}
    if (host === 'arxiv.org' || host === 'export.arxiv.org') {
      const version = /v(\d+)(?:\.pdf)?(?:$|\/)/i.exec(path)?.[1] || '';
      return { containerTitle: 'arXiv', publisher: 'arXiv', version: version ? 'v' + version : '' };
    }
    if (host === 'link.springer.com' || host.endsWith('.springer.com')) return { publisher: 'Springer Nature' };
    if (host === 'ieeexplore.ieee.org') return { publisher: 'IEEE' };
    if (host === 'dl.acm.org') return { publisher: 'Association for Computing Machinery' };
    if (host === 'sciencedirect.com' || host.endsWith('.sciencedirect.com')) return { publisher: 'Elsevier' };
    return {};
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
    const jsonLd = jsonLdArticle(document);
    const authors = metaValues(document, ['citation_author', 'citation_authors', 'dc.creator', 'dc.contributor.author', 'author']);
    const title = metaValue(document, ['citation_title', 'dc.title', 'og:title', 'twitter:title'])
      || cleanText(jsonLd.headline || jsonLd.name || '')
      || cleanText(document.title).replace(/\s+[|–—-]\s+Google Scholar$/i, '');
    const dateValues = metaValues(document, ['citation_publication_date', 'citation_date', 'dc.date', 'date', 'article:published_time']);
    if (!dateValues.length && (jsonLd.datePublished || jsonLd.dateCreated)) dateValues.push(jsonLd.datePublished || jsonLd.dateCreated);
    const jsonLdIdentifiers = Array.isArray(jsonLd.identifier) ? jsonLd.identifier : [jsonLd.identifier];
    const jsonLdDoi = jsonLdIdentifiers.map((value) => typeof value === 'string' ? value : value?.value || value?.propertyID || value?.name || '').join(' ');
    const doiValue = metaValue(document, ['citation_doi', 'dc.identifier', 'prism.doi', 'doi']) || jsonLdDoi;
    const prismUrl = metaValue(document, ['prism.url']);
    const jsonLdUrl = typeof jsonLd.mainEntityOfPage === 'string' ? jsonLd.mainEntityOfPage : jsonLd.mainEntityOfPage?.['@id'];
    const articleUrl = safeUrl(canonical, pageUrl) || safeUrl(jsonLdUrl, pageUrl) || safeUrl(prismUrl, pageUrl) || safeUrl(pageUrl);
    const pdfValues = metaValues(document, ['citation_pdf_url', 'pdf_url']);
    const journalTitle = metaValue(document, ['citation_journal_title', 'prism.publicationName']);
    const conferenceTitle = metaValue(document, ['citation_conference_title', 'citation_inbook_title']);
    const jsonLdContainer = jsonLdName(jsonLd.isPartOf || jsonLd.publication || jsonLd.book);
    const otherContainer = metaValue(document, ['dc.source', 'citation_series_title']);
    const adapter = publisherAdapter(articleUrl || pageUrl);
    const containerTitle = conferenceTitle || journalTitle || otherContainer || jsonLdContainer || adapter.containerTitle || '';
    const volume = metaValue(document, ['citation_volume', 'prism.volume']) || jsonLd.volumeNumber || '';
    const issue = metaValue(document, ['citation_issue', 'prism.number']) || jsonLd.issueNumber || '';
    const firstPage = metaValue(document, ['citation_firstpage', 'citation_start_page', 'prism.startingPage']) || jsonLd.pageStart || '';
    const lastPage = metaValue(document, ['citation_lastpage', 'citation_end_page', 'prism.endingPage']) || jsonLd.pageEnd || '';
    const publisher = metaValue(document, ['citation_publisher', 'dc.publisher', 'prism.publisher']) || jsonLdName(jsonLd.publisher) || adapter.publisher || '';
    const publisherPlace = metaValue(document, ['citation_publication_place', 'citation_place_of_publication', 'dc.publisher.place', 'dc.coverage.spatial'])
      || jsonLdName(jsonLd.locationCreated || jsonLd.contentLocation || jsonLd.location);
    const versionLabel = metaValue(document, ['citation_version', 'version', 'prism.version']) || adapter.version || (jsonLd.version ? String(jsonLd.version) : '');
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    const doi = doiFrom(doiValue) || doiFrom(bodyText);
    const pageYear = yearFrom(dateValues);
    const jsonTypes = Array.isArray(jsonLd['@type']) ? jsonLd['@type'].join(' ') : String(jsonLd['@type'] || '');
    const itemType = /conference|event/i.test(jsonTypes) || conferenceTitle ? 'paper-conference'
      : /bookchapter|chapter/i.test(jsonTypes) ? 'chapter'
        : /\bbook\b/i.test(jsonTypes) ? 'book'
          : containerTitle ? 'journal-article' : 'article';
    const pdfs = pdfCandidates(document, articleUrl || pageUrl, [...pdfValues, jsonLd.encoding?.contentUrl || jsonLd.associatedMedia?.contentUrl || '']);
    const parsedMetaAuthors = parseAuthors(authors);
    const parsedJsonAuthors = jsonLdAuthors(jsonLd.author);
    const mergedAuthors = dedupeAuthors(parsedMetaAuthors.length ? parsedMetaAuthors : parsedJsonAuthors);
    return {
      title,
      authors: mergedAuthors,
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
      publisher,
      publisher_place: publisherPlace,
      version_label: versionLabel,
      citation_exports: citationExports(document, articleUrl || pageUrl),
      source: 'browser',
    };
  }

  function cslYear(record) {
    const parts = record?.issued?.['date-parts']?.[0] || record?.['original-date']?.['date-parts']?.[0] || [];
    return Number.isInteger(Number(parts[0])) ? Number(parts[0]) : null;
  }

  function candidateFromCsl(record, sourceCitation = '', source = 'bibtex') {
    const value = record && typeof record === 'object' ? record : {};
    const authors = Array.isArray(value.author) ? value.author.map((author) => ({
      ...(author.literal ? { literal: cleanText(author.literal) } : {}),
      ...(author.given ? { given: cleanText(author.given) } : {}),
      ...(author.family ? { family: cleanText(author.family) } : {}),
    })).filter((author) => author.literal || author.given || author.family) : [];
    const container = value['container-title'] || value['collection-title'] || value['event-title'] || '';
    const itemType = value.type === 'article-journal' ? 'journal-article' : value.type || 'article';
    const url = safeUrl(value.URL || value.url || '');
    const doi = doiFrom(value.DOI || value.doi || '');
    return {
      title: cleanText(value.title || ''),
      authors,
      year: cslYear(value),
      container_title: cleanText(Array.isArray(container) ? container[0] : container),
      doi,
      url,
      pdf_url: '',
      pdf_candidates: [],
      volume: cleanText(value.volume || ''),
      issue: cleanText(value.issue || ''),
      pages: cleanText(value.page || ''),
      item_type: itemType,
      publisher: cleanText(value.publisher || ''),
      publisher_place: cleanText(value['publisher-place'] || ''),
      version_label: cleanText(value.version || value['version-label'] || ''),
      source_citation: sourceCitation,
      csl: value,
      source,
      citation_exports: [],
    };
  }

  function cslRecord(item) {
    if (item?.csl && typeof item.csl === 'object' && !Array.isArray(item.csl)) return item.csl;
    const type = item?.item_type === 'journal-article' ? 'article-journal'
      : item?.item_type === 'paper-conference' ? 'paper-conference'
        : item?.item_type || 'article-journal';
    const authors = Array.isArray(item?.authors) ? item.authors.map((author) => ({
      ...(author.literal ? { literal: cleanText(author.literal) } : {}),
      ...(author.given ? { given: cleanText(author.given) } : {}),
      ...(author.family ? { family: cleanText(author.family) } : {}),
    })).filter((author) => author.literal || author.given || author.family) : [];
    const record = {
      type,
      title: cleanText(item?.title || ''),
      author: authors,
    };
    if (item?.container_title) record['container-title'] = cleanText(item.container_title);
    if (item?.doi) record.DOI = cleanText(item.doi);
    if (item?.url) record.URL = safeUrl(item.url);
    if (item?.year) record.issued = { 'date-parts': [[Number(item.year)]] };
    for (const [source, target] of [
      ['volume', 'volume'], ['issue', 'issue'], ['pages', 'page'], ['publisher', 'publisher'],
      ['publisher_place', 'publisher-place'], ['version_label', 'version'],
    ]) {
      if (item?.[source]) record[target] = cleanText(item[source]);
    }
    return record;
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

  async function downloadCitationExport(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    const safe = safeUrl(url);
    if (!safe) throw new Error('BibTeX/RIS 链接不安全或无效。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(safe, {
        method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('文献导出下载失败（HTTP ' + response.status + '）。');
      const length = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(length) && length > MAX_EXPORT_BYTES) throw new Error('BibTeX/RIS 文件超过 512 KiB 限制。');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('无法读取文献导出文件。');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_EXPORT_BYTES) {
            await reader.cancel();
            throw new Error('BibTeX/RIS 文件超过 512 KiB 限制。');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!size) throw new Error('文献导出文件为空。');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('文献导出下载超时，请稍后重试。');
      if (error instanceof TypeError) throw new Error('文献导出请求失败。若链接会跳转，请打开来源页面后重试。');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const api = {
    MAX_PDF_BYTES,
    MAX_EXPORT_BYTES,
    MAX_CANDIDATES,
    cleanText,
    safeUrl,
    parseAuthors,
    doiFrom,
    candidateFromCsl,
    cslRecord,
    extractPageMetadata,
    extractScholarResults,
    extractPage,
    pdfUrlFromTab,
    fileNameFromUrl,
    encodeBase64,
    downloadPdf,
    downloadCitationExport,
  };
  globalThis.FolioCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
