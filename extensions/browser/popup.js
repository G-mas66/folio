'use strict';

const $ = (selector) => document.querySelector(selector);
let activeTab;
let candidates = [];

function rpc(type, values = {}) {
  return chrome.runtime.sendMessage({ type, ...values }).then((reply) => {
    if (!reply?.ok) throw new Error(reply?.error || '扩展请求失败。');
    return reply.result;
  });
}

function setBadge(text, kind = '') {
  const badge = $('#connection-state');
  badge.textContent = text;
  badge.className = 'badge' + (kind ? ' ' + kind : '');
}

function setPageMessage(text, isError = false) {
  const message = $('#page-message');
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = !text;
}

function authorText(authors) {
  return (Array.isArray(authors) ? authors : [])
    .map((author) => author.literal || [author.given, author.family].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
}

function addEmpty(parent, text) {
  const row = document.createElement('p');
  row.className = 'empty';
  row.textContent = text;
  parent.replaceChildren(row);
}

function selectedCount() {
  return candidates.filter((item) => item.selected).length;
}

function updateCaptureButton() {
  const count = selectedCount();
  const pendingReview = candidates.some((item) => item.selected && item.doi && !item.doiResolved && !item.doiSkipped);
  $('#capture-button').disabled = count === 0 || pendingReview;
  $('#capture-button').textContent = pendingReview
    ? '收藏前请核对 DOI 信息'
    : (count ? '收藏所选 (' + count + ')' : '收藏所选');
}

function renderCandidates() {
  const list = $('#candidate-list');
  list.replaceChildren();
  if (!candidates.length) addEmpty(list, '没有读取到可收藏的内容。');
  for (const [index, item] of candidates.entries()) {
    const row = document.createElement('article');
    row.className = 'candidate' + (item.selected ? ' selected' : '');
    const titleLine = document.createElement('div');
    titleLine.className = 'candidate-title';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(item.selected);
    checkbox.setAttribute('aria-label', '选择此书目');
    checkbox.addEventListener('change', () => {
      item.selected = checkbox.checked;
      row.classList.toggle('selected', item.selected);
      updateCaptureButton();
    });
    const title = document.createElement('span');
    title.className = 'candidate-name';
    title.textContent = item.title || '标题待补充';
    titleLine.append(checkbox, title);
    row.append(titleLine);

    const metadata = [
      authorText(item.authors),
      item.year || '',
      item.container_title || '',
      item.doi ? 'DOI ' + item.doi : '',
      item.version_label || '',
    ].filter(Boolean);
    const meta = document.createElement('p');
    meta.className = 'candidate-meta';
    meta.textContent = metadata.join(' · ') || '书目信息不完整，可先保存后在 Folio 中修改。';
    row.append(meta);

    const missing = [];
    if (!item.title) missing.push('标题');
    if (!item.authors?.length) missing.push('作者');
    if (!item.year) missing.push('年份');
    if (!item.container_title) missing.push('期刊/来源');
    if (!item.doi) missing.push('DOI');
    if (missing.length) {
      const warning = document.createElement('span');
      warning.className = 'missing';
      warning.textContent = '待补充：' + missing.join('、');
      row.append(warning);
    }

    if (item.doi && !item.doiResolved && !item.doiSkipped) {
      const resolveButton = document.createElement('button');
      resolveButton.type = 'button';
      resolveButton.className = 'export-button';
      resolveButton.textContent = item.doiPreview ? 'DOI 信息已查到' : '核对 DOI 信息';
      resolveButton.disabled = Boolean(item.doiPreview || item.doiLoading);
      if (!item.doiPreview) resolveButton.addEventListener('click', () => { void resolveDoi(item); });
      row.append(resolveButton);
    }
    if (item.doiPreview) {
      const preview = document.createElement('div');
      preview.className = 'doi-preview';
      const previewText = document.createElement('p');
      previewText.textContent = [
        item.doiPreview.candidate.title,
        authorText(item.doiPreview.candidate.authors),
        item.doiPreview.candidate.year || '',
        item.doiPreview.candidate.container_title,
        item.doiPreview.candidate.volume ? '卷 ' + item.doiPreview.candidate.volume : '',
        item.doiPreview.candidate.issue ? '期 ' + item.doiPreview.candidate.issue : '',
        item.doiPreview.candidate.pages,
        item.doiPreview.candidate.publisher,
        item.doiPreview.candidate.publisher_place,
      ].filter(Boolean).join(' · ');
      preview.append(previewText);
      const source = document.createElement('p');
      source.textContent = 'DOI ' + item.doi + ' · 来源：' + item.doiPreview.source;
      preview.append(source);
      const useResult = document.createElement('button');
      useResult.type = 'button';
      useResult.className = 'quiet';
      useResult.textContent = '采用查到的元数据';
      useResult.addEventListener('click', () => acceptDoiPreview(item));
      const keepPage = document.createElement('button');
      keepPage.type = 'button';
      keepPage.className = 'quiet';
      keepPage.textContent = '保留页面元数据';
      keepPage.addEventListener('click', () => keepPageMetadata(item));
      preview.append(useResult, keepPage);
      row.append(preview);
    }
    if (item.doiLookupError && !item.doiSkipped) {
      const error = document.createElement('p');
      error.className = 'message error';
      error.textContent = 'DOI 查询失败：' + item.doiLookupError;
      row.append(error);
      const keepPage = document.createElement('button');
      keepPage.type = 'button';
      keepPage.className = 'export-button';
      keepPage.textContent = '仍用页面元数据收藏';
      keepPage.addEventListener('click', () => keepPageMetadata(item));
      row.append(keepPage);
    }
    if (item.doiResolved) {
      const status = document.createElement('span');
      status.className = 'missing';
      status.textContent = 'DOI 元数据已核对';
      row.append(status);
    }

    const pdfRow = document.createElement('div');
    pdfRow.className = 'pdf-row';
    const pdfLabel = document.createElement('label');
    pdfLabel.textContent = 'PDF';
    pdfLabel.htmlFor = 'pdf-select-' + index;
    const pdfSelect = document.createElement('select');
    pdfSelect.id = 'pdf-select-' + index;
    pdfSelect.setAttribute('aria-label', '选择要导入的 PDF');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '仅收藏书目';
    pdfSelect.append(none);
    for (const url of item.pdf_candidates || []) {
      const safe = FolioCapture.safeUrl(url);
      if (!safe) continue;
      const option = document.createElement('option');
      option.value = safe;
      try { option.textContent = '导入 ' + new URL(safe).hostname; } catch { option.textContent = '导入 PDF'; }
      pdfSelect.append(option);
    }
    pdfSelect.value = item.pdfUrl || '';
    pdfSelect.addEventListener('change', () => {
      item.pdfUrl = pdfSelect.value;
      if (pdfSelect.value) item.pdf_url = pdfSelect.value;
    });
    pdfRow.append(pdfLabel, pdfSelect);
    row.append(pdfRow);

    for (const citationExport of item.citation_exports || []) {
      if (!['bibtex', 'ris'].includes(citationExport.format)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'export-button';
      button.textContent = '获取 ' + citationExport.format.toUpperCase();
      button.addEventListener('click', () => { void importCitationExport(citationExport); });
      row.append(button);
    }
    list.append(row);
  }
  updateCaptureButton();
}

function renderFolders(folders) {
  const select = $('#folder-select');
  const selected = select.value;
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未分类';
  select.append(none);
  for (const folder of Array.isArray(folders) ? folders : []) {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    select.append(option);
  }
  select.value = folders?.some((folder) => folder.id === selected) ? selected : '';
}

function renderLibrary(payload) {
  const root = $('#search-results');
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    addEmpty(root, '没有匹配的书目。');
    return;
  }
  const list = document.createElement('div');
  for (const item of items.slice(0, 15)) {
    const row = document.createElement('article');
    row.className = 'search-item';
    const title = document.createElement('p');
    title.className = 'search-title';
    title.textContent = item.title || '标题待补充';
    const details = document.createElement('p');
    details.className = 'search-meta';
    details.textContent = [
      authorText(item.authors), item.year || '', item.container_title || '',
      item.paper_id ? '已关联 PDF' : '仅书目',
    ].filter(Boolean).join(' · ');
    row.append(title, details);
    list.append(row);
  }
  root.replaceChildren(list);
}

async function extractPage() {
  $('#page-caption').textContent = activeTab?.title || '当前标签页';
  setPageMessage('');
  const pdfUrl = FolioCapture.pdfUrlFromTab(activeTab?.url || '');
  if (pdfUrl) {
    candidates = [{
      title: activeTab?.title || FolioCapture.fileNameFromUrl(pdfUrl),
      authors: [], year: null, container_title: '', doi: '', url: pdfUrl,
      pdf_url: pdfUrl, pdf_candidates: [pdfUrl], item_type: 'article', source: 'browser',
      selected: true, pdfUrl,
    }];
    $('#page-caption').textContent = '当前标签页是 PDF';
    renderCandidates();
    return;
  }
  try {
    if (!activeTab?.id) throw new Error('没有可读取的当前标签页。');
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['shared.js', 'content.js'],
    });
    const extracted = await chrome.tabs.sendMessage(activeTab.id, { type: 'FOLIO_EXTRACT_PAGE' });
    candidates = (extracted?.candidates || []).map((item, index) => ({
      ...item,
      selected: extracted.kind === 'page' || index === 0,
      pdfUrl: item.pdf_url || item.pdf_candidates?.[0] || '',
    }));
    $('#page-caption').textContent = extracted.kind === 'scholar'
      ? 'Google Scholar：选择一篇或多篇结果'
      : (activeTab.title || '当前网页');
    renderCandidates();
    if (extracted.kind === 'scholar') {
      const actions = document.createElement('button');
      actions.className = 'quiet';
      actions.type = 'button';
      actions.textContent = '全选';
      actions.addEventListener('click', () => {
        const selectAll = candidates.some((item) => !item.selected);
        candidates.forEach((item) => { item.selected = selectAll; });
        actions.textContent = selectAll ? '取消全选' : '全选';
        renderCandidates();
      });
      $('#page-caption').append(document.createTextNode('  '));
      $('#page-caption').append(actions);
    }
  } catch {
    candidates = [];
    renderCandidates();
    setPageMessage('此页面受浏览器保护，或无法读取页面内容。请在普通网页或论文页使用。', true);
  }
}

async function loadFolders() {
  const result = await rpc('FOLIO_FOLDERS');
  renderFolders(Array.isArray(result) ? result : result.folders);
}

function captureRecord(item) {
  return {
    title: item.title || '',
    authors: Array.isArray(item.authors) ? item.authors : [],
    year: item.year || null,
    container_title: item.container_title || '',
    doi: item.doi || '',
    url: item.url || '',
    pdf_url: item.pdf_url || item.pdfUrl || '',
    volume: item.volume || '',
    issue: item.issue || '',
    pages: item.pages || '',
    item_type: item.item_type || 'article',
    source: item.source === 'scholar' ? 'scholar' : 'browser',
    publisher: item.publisher || '',
    publisher_place: item.publisher_place || '',
    version_label: item.version_label || '',
    source_citation: item.source_citation || '',
    source_url: item.source_url || '',
    csl: FolioCapture.cslRecord(item),
  };
}

function mergeResolvedCsl(original, incoming, doi, originalUrl) {
  const merged = { ...original };
  for (const [field, value] of Object.entries(incoming || {})) {
    if (field === 'id' || field === 'DOI' || field === 'URL') continue;
    const present = Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : value !== '' && value !== null && value !== undefined;
    if (present) merged[field] = value;
  }
  merged.DOI = original.DOI || doi || incoming?.DOI || '';
  merged.URL = original.URL || originalUrl || incoming?.URL || '';
  if (original.id) merged.id = original.id;
  return merged;
}

async function resolveDoi(item) {
  item.doiLoading = true;
  item.doiLookupError = '';
  renderCandidates();
  try {
    const result = await rpc('FOLIO_RESOLVE', { doi: item.doi });
    const mergedCsl = mergeResolvedCsl(FolioCapture.cslRecord(item), result.record, item.doi, item.url);
    const resolved = FolioCapture.candidateFromCsl(mergedCsl, item.source_citation || '', 'doi');
    item.doiPreview = {
      source: result.source || 'DOI',
      candidate: {
        ...resolved,
        doi: item.doi,
        url: item.url || resolved.url,
        pdf_url: item.pdf_url || '',
        pdf_candidates: item.pdf_candidates || [],
        pdfUrl: item.pdfUrl || '',
        item_type: resolved.item_type || item.item_type,
        version_label: item.version_label || resolved.version_label,
        source: item.source,
        source_citation: item.source_citation || '',
        source_url: result.source_url || item.source_url || '',
        csl: mergedCsl,
      },
    };
  } catch (error) {
    item.doiLookupError = error.message;
  } finally {
    item.doiLoading = false;
    renderCandidates();
  }
}

function acceptDoiPreview(item) {
  if (!item.doiPreview) return;
  const selected = item.selected;
  Object.assign(item, item.doiPreview.candidate, {
    selected,
    doiResolved: true,
    doiPreview: null,
    doiLookupError: '',
  });
  renderCandidates();
}

function keepPageMetadata(item) {
  item.doiSkipped = true;
  item.doiPreview = null;
  item.doiLookupError = '';
  renderCandidates();
}

function pdfOrigins(items) {
  const origins = new Set();
  for (const item of items) {
    if (!item.pdfUrl) continue;
    const safe = FolioCapture.safeUrl(item.pdfUrl);
    if (safe) {
      const url = new URL(safe);
      origins.add(url.protocol + '//' + url.hostname + '/*');
    }
  }
  return Array.from(origins);
}

function addCaptureResult(item, text, isError = false) {
  const row = document.createElement('div');
  row.className = 'capture-result' + (isError ? ' error' : '');
  const message = document.createElement('p');
  message.textContent = (item.title || '无标题书目') + ' — ' + text;
  row.append(message);
  $('#capture-results').prepend(row);
  return row;
}

function addCitationPreview(row, savedItem, preview, style) {
  const citation = document.createElement('p');
  citation.className = 'citation-preview';
  citation.textContent = preview.citation_text || preview.bibliography_text || '引用预览为空。';
  row.append(citation);
  if (preview.bibliography_text && preview.bibliography_text !== preview.citation_text) {
    const bibliography = document.createElement('p');
    bibliography.className = 'citation-preview';
    bibliography.textContent = preview.bibliography_text;
    row.append(bibliography);
  }
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'quiet';
  confirm.textContent = '确认此引用格式';
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await rpc('FOLIO_CONFIRM', {
        recordId: savedItem.id,
        style,
        fingerprint: preview.fingerprint,
      });
      confirm.textContent = '引用已确认';
    } catch (error) {
      confirm.textContent = '确认失败，重新预览';
      const status = document.createElement('span');
      status.className = 'message error';
      status.textContent = error.message;
      row.append(status);
      confirm.disabled = false;
    }
  });
  row.append(confirm);
}

async function captureOne(item, { requestPdfPermission = false } = {}) {
  const pdfUrl = item.pdfUrl || '';
  let fetchPdf = Boolean(pdfUrl);
  if (requestPdfPermission && fetchPdf) {
    const origins = pdfOrigins([item]);
    fetchPdf = Boolean(origins.length && await chrome.permissions.request({ origins }));
  }
  return rpc('FOLIO_CAPTURE', {
    item: captureRecord(item),
    folderId: $('#folder-select').value,
    pdfUrl,
    fetchPdf,
  });
}

async function previewCaptured(row, savedItem, record, style) {
  if (!savedItem?.id || !savedItem.csl) {
    const message = document.createElement('p');
    message.className = 'message error';
    message.textContent = '书目已保存；本次响应未包含稳定记录编号和已保存 CSL，请在书目列表中重新预览。';
    row.append(message);
    return;
  }
  const preview = await rpc('FOLIO_PREVIEW', { record: savedItem.csl, style });
  addCitationPreview(row, savedItem, preview, style);
}

async function captureSelected() {
  const selected = candidates.filter((item) => item.selected);
  if (!selected.length) return;
  $('#capture-button').disabled = true;
  $('#capture-results').replaceChildren();
  const style = $('#citation-style').value;
  for (const [index, item] of selected.entries()) {
    setPageMessage('正在收藏 ' + (index + 1) + ' / ' + selected.length + '…');
    try {
      const result = await captureOne(item, { requestPdfPermission: true });
      const pdf = result.pdf_import || {};
      let status = result.duplicate_record ? '书目已合并到已有记录' : '书目已保存';
      if (pdf.status === 'imported') status += ' · PDF 已导入';
      else if (pdf.status === 'duplicate') status += ' · 已关联相同 PDF';
      else if (pdf.status === 'failed') status += ' · PDF 导入失败：' + (pdf.error || '请重试');
      else if (item.pdfUrl && !pdf.status) status += ' · 仅保存书目';
      const row = addCaptureResult(item, status, pdf.status === 'failed');
      item.selected = false;

      if (pdf.status === 'failed' && item.pdfUrl) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'quiet';
        retry.textContent = '重试 PDF 导入';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            const retried = await captureOne(item, { requestPdfPermission: true });
            const retryStatus = retried.pdf_import || {};
            if (retryStatus.status === 'imported' || retryStatus.status === 'duplicate') {
              retry.textContent = retryStatus.status === 'imported' ? 'PDF 已导入' : '已关联相同 PDF';
            } else {
              retry.textContent = '重试 PDF 导入';
              retry.disabled = false;
              const error = document.createElement('span');
              error.className = 'message error';
              error.textContent = retryStatus.error || 'PDF 导入失败，请重试。';
              row.append(error);
            }
          } catch (error) {
            retry.textContent = '重试 PDF 导入';
            retry.disabled = false;
            const status = document.createElement('span');
            status.className = 'message error';
            status.textContent = error.message;
            row.append(status);
          }
        });
        row.append(retry);
      }

      try {
        await previewCaptured(row, result.item, captureRecord(item).csl, style);
      } catch (error) {
        const message = document.createElement('p');
        message.className = 'message error';
        message.textContent = '书目已保存，但引用预览失败：' + error.message;
        row.append(message);
      }
    } catch (error) {
      addCaptureResult(item, '收藏失败：' + error.message, true);
    }
  }
  setPageMessage('处理完成。');
  renderCandidates();
}

async function importCitationExport(citationExport) {
  const safe = FolioCapture.safeUrl(citationExport.url);
  if (!safe) return;
  try {
    const parsed = new URL(safe);
    const origin = parsed.protocol + '//' + parsed.hostname + '/*';
    if (!(await chrome.permissions.request({ origins: [origin] }))) {
      setPageMessage('未授权读取该站点的 BibTeX/RIS 文件。', true);
      return;
    }
    const result = await rpc('FOLIO_IMPORT_EXPORT', { url: safe, format: citationExport.format });
    const imported = Array.isArray(result.items) ? result.items : [];
    const additions = imported.map((entry) => {
      const item = FolioCapture.candidateFromCsl(entry.record, entry.source_citation || '', citationExport.format);
      item.source_url = safe;
      item.selected = false;
      item.pdfUrl = '';
      return item;
    }).filter((item) => item.title || item.doi || item.url);
    candidates = [...candidates, ...additions].slice(-FolioCapture.MAX_CANDIDATES);
    renderCandidates();
    setPageMessage(additions.length
      ? `已将 ${additions.length} 条 ${citationExport.format.toUpperCase()} 记录加入候选列表；不会替换当前页面记录。`
      : '没有从导出文件读取到文献记录。', !additions.length);
  } catch (error) {
    setPageMessage('读取 BibTeX/RIS 失败：' + error.message, true);
  }
}

async function searchLibrary(event) {
  event.preventDefault();
  $('#search-results').textContent = '正在搜索…';
  try {
    renderLibrary(await rpc('FOLIO_SEARCH', { query: $('#search-query').value }));
  } catch (error) {
    addEmpty($('#search-results'), error.message);
  }
}

async function reconnect() {
  setBadge('连接中');
  try {
    await rpc('FOLIO_STATUS');
    await loadFolders();
    setBadge('已连接', 'good');
  } catch (error) {
    setBadge('未连接', 'bad');
    setPageMessage(error.message, true);
  }
}

$('#refresh-page').addEventListener('click', () => { void extractPage(); });
$('#capture-button').addEventListener('click', () => { void captureSelected(); });
$('#reconnect-button').addEventListener('click', () => { void reconnect(); });
$('#search-form').addEventListener('submit', (event) => { void searchLibrary(event); });

async function initialize() {
  $('#app-view').hidden = false;
  addEmpty($('#search-results'), '输入内容后搜索书目。');
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tabs[0];
  } catch {}
  void extractPage();
  void reconnect();
}

void initialize();
