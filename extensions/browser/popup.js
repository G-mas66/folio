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

function showPair(message = '') {
  $('#pair-view').hidden = false;
  $('#app-view').hidden = true;
  $('#pair-error').textContent = message;
  $('#pair-error').hidden = !message;
  setBadge('未配对', 'bad');
}

function showApp() {
  $('#pair-view').hidden = true;
  $('#app-view').hidden = false;
}

function authorText(authors) {
  return (Array.isArray(authors) ? authors : [])
    .map((author) => [author.given, author.family].filter(Boolean).join(' '))
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
    list.append(row);
  }
  updateCaptureButton();
}

function updateCaptureButton() {
  const count = selectedCount();
  $('#capture-button').disabled = count === 0;
  $('#capture-button').textContent = count ? '收藏所选 (' + count + ')' : '收藏所选';
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
      authorText(item.authors),
      item.year || '',
      item.container_title || '',
      item.paper_id ? '已关联 PDF' : '仅书目',
    ].filter(Boolean).join(' · ');
    row.append(title, details);
    list.append(row);
  }
  root.replaceChildren(list);
}

async function extractPage() {
  $('#page-caption').textContent = activeTab?.title || '当前标签页';
  $('#page-message').hidden = true;
  const pdfUrl = FolioCapture.pdfUrlFromTab(activeTab?.url || '');
  if (pdfUrl) {
    candidates = [{
      title: activeTab?.title || FolioCapture.fileNameFromUrl(pdfUrl),
      authors: [],
      year: null,
      container_title: '',
      doi: '',
      url: pdfUrl,
      pdf_url: pdfUrl,
      pdf_candidates: [pdfUrl],
      item_type: 'article',
      source: 'browser',
      selected: true,
      pdfUrl,
    }];
    $('#page-caption').textContent = '当前标签页是 PDF';
    renderCandidates();
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['shared.js', 'content.js'],
    });
    const extracted = await chrome.tabs.sendMessage(activeTab.id, { type: 'FOLIO_EXTRACT_PAGE' });
    candidates = (extracted?.candidates || []).map((item, index) => ({
      ...item,
      selected: extracted.kind === 'page' || index === 0,
      pdfUrl: '',
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
    $('#page-message').textContent = '此页面受浏览器保护，或无法读取页面内容。请在普通网页或论文页使用。';
    $('#page-message').classList.add('error');
    $('#page-message').hidden = false;
  }
}

async function loadFolders() {
  const result = await rpc('FOLIO_FOLDERS');
  renderFolders(result.folders);
  setBadge('已连接', 'good');
}

function addCaptureResult(text, isError = false) {
  const row = document.createElement('div');
  row.className = 'capture-result' + (isError ? ' error' : '');
  row.textContent = text;
  $('#capture-results').prepend(row);
}

function pdfOrigins(selected) {
  const origins = new Set();
  for (const item of selected) {
    if (!item.pdfUrl) continue;
    const safe = FolioCapture.safeUrl(item.pdfUrl);
    if (safe) {
      const url = new URL(safe);
      origins.add(url.protocol + '//' + url.hostname + '/*');
    }
  }
  return Array.from(origins);
}

async function captureSelected() {
  const selected = candidates.filter((item) => item.selected);
  if (!selected.length) return;
  const origins = pdfOrigins(selected);
  const permissionRequest = origins.length
    ? chrome.permissions.request({ origins }).catch(() => false)
    : Promise.resolve(true);
  $('#capture-button').disabled = true;
  $('#capture-results').replaceChildren();
  for (const [index, item] of selected.entries()) {
    $('#page-message').textContent = '正在收藏 ' + (index + 1) + ' / ' + selected.length + '…';
    $('#page-message').hidden = false;
    try {
      const result = await rpc('FOLIO_CAPTURE', {
        item,
        folderId: $('#folder-select').value,
        pdfUrl: item.pdfUrl || '',
        fetchPdf: Boolean(item.pdfUrl) && await permissionRequest,
      });
      const pdf = result.pdf_import || {};
      let status = result.duplicate_record ? '书目已合并到已有记录' : '书目已保存';
      if (pdf.status === 'imported') status += ' · PDF 已导入';
      else if (pdf.status === 'duplicate') status += ' · 已关联相同 PDF';
      else if (pdf.status === 'failed') status += ' · PDF 导入失败：' + (pdf.error || '请在 Folio 中查看');
      else if (item.pdfUrl && !(await Promise.resolve(permissionRequest))) status += ' · 未获 PDF 来源授权，已只保存书目';
      addCaptureResult((item.title || '无标题书目') + ' — ' + status, pdf.status === 'failed');
      item.selected = false;
      item.pdfUrl = '';
    } catch (error) {
      addCaptureResult((item.title || '无标题书目') + ' — 收藏失败：' + error.message, true);
    }
  }
  $('#page-message').textContent = '处理完成。';
  renderCandidates();
}

$('#pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await rpc('FOLIO_PAIR', { token: $('#pair-token').value });
    $('#pair-token').value = '';
    showApp();
    await loadFolders();
    await extractPage();
    addEmpty($('#search-results'), '输入内容后搜索书目。');
  } catch (error) {
    $('#pair-error').textContent = error.message;
    $('#pair-error').hidden = false;
    setBadge('连接失败', 'bad');
  } finally {
    button.disabled = false;
  }
});

$('#refresh-page').addEventListener('click', () => { void extractPage(); });
$('#capture-button').addEventListener('click', () => { void captureSelected(); });
$('#unpair-button').addEventListener('click', async () => {
  await rpc('FOLIO_UNPAIR');
  showPair();
});
$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#search-results').textContent = '正在搜索…';
  try {
    renderLibrary(await rpc('FOLIO_SEARCH', { query: $('#search-query').value }));
  } catch (error) {
    addEmpty($('#search-results'), error.message);
  }
});

async function initialize() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tabs[0];
    const status = await rpc('FOLIO_STATUS');
    if (!status.paired) {
      showPair();
      return;
    }
    showApp();
    if (!activeTab?.id) throw new Error('没有可读取的当前标签页。');
    try { await loadFolders(); }
    catch (error) {
      setBadge('连接失败', 'bad');
      $('#page-message').textContent = error.message;
      $('#page-message').classList.add('error');
      $('#page-message').hidden = false;
    }
    await extractPage();
    addEmpty($('#search-results'), '输入内容后搜索书目。');
  } catch (error) {
    const status = await rpc('FOLIO_STATUS').catch(() => ({ paired: false }));
    if (status.paired) {
      showApp();
      setBadge('连接失败', 'bad');
      $('#page-message').textContent = error.message;
      $('#page-message').classList.add('error');
      $('#page-message').hidden = false;
    } else {
      showPair(error.message);
    }
  }
}

void initialize();
