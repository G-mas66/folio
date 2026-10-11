'use strict';

require('core-js/stable');

var stateModule = require('./document-state');
var citationEngine = require('./citation-engine');
var SETTINGS_KEY = 'folio.word.citations.v1';
var CITATION_PREFIX = 'folio-cite:';
var BIBLIOGRAPHY_TAG = 'folio-bibliography:v1';
var styleText = {};
var searchResults = Object.create(null);

function byId(id) { return document.getElementById(id); }
function status(message, isError) {
  var node = byId('status');
  node.textContent = message || '';
  node.className = isError ? 'status error' : 'status';
}
function token() { return (window.localStorage.getItem('folio.plugin.token') || '').trim(); }
function readState() {
  return stateModule.parseState(Office.context.document.settings.get(SETTINGS_KEY));
}
function saveState(state, callback) {
  var settings = Office.context.document.settings;
  settings.set(SETTINGS_KEY, JSON.stringify(state));
  settings.saveAsync(function (result) {
    if (result.status !== Office.AsyncResultStatus.Succeeded) {
      callback(new Error(result.error && result.error.message ? result.error.message : 'Document settings could not be saved.'));
      return;
    }
    callback(null);
  });
}
function makeId() {
  return 'c' + new Date().getTime().toString(36) + Math.floor(Math.random() * 1000000000).toString(36);
}
function requestJson(path, callback) {
  var authToken = token();
  if (!authToken) {
    callback(new Error('Enter the Folio plugin token from Settings first.'));
    return;
  }
  var request = new XMLHttpRequest();
  request.open('GET', path, true);
  request.setRequestHeader('Authorization', 'Bearer ' + authToken);
  request.setRequestHeader('Accept', 'application/json');
  request.onreadystatechange = function () {
    if (request.readyState !== 4) return;
    if (request.status < 200 || request.status >= 300) {
      callback(new Error(request.status === 401 ? 'Folio token was rejected. Copy the current token from Folio Settings.' : 'Folio bridge returned HTTP ' + request.status + '.'));
      return;
    }
    try { callback(null, JSON.parse(request.responseText)); }
    catch (_error) { callback(new Error('Folio returned an invalid literature response.')); }
  };
  request.onerror = function () { callback(new Error('Cannot reach Folio at 127.0.0.1:37861. Start Folio and check its plugin bridge.')); };
  request.send();
}
function loadText(path, callback) {
  var request = new XMLHttpRequest();
  request.open('GET', path, true);
  request.onreadystatechange = function () {
    if (request.readyState !== 4) return;
    if (request.status < 200 || request.status >= 300) callback(new Error('Could not load ' + path + '.'));
    else callback(null, request.responseText);
  };
  request.onerror = function () { callback(new Error('Could not load ' + path + '.')); };
  request.send();
}
function loadStyles(callback) {
  var files = {
    apa: '/styles/apa.csl',
    gb: '/styles/gb-t-7714-2015-numeric.csl',
    en: '/styles/locales-en-US.xml',
    zh: '/styles/locales-zh-CN.xml'
  };
  var keys = Object.keys(files);
  var remaining = keys.length;
  var failure = null;
  keys.forEach(function (key) {
    loadText(files[key], function (error, value) {
      if (error && !failure) failure = error;
      else if (!error) styleText[key] = value;
      remaining -= 1;
      if (remaining === 0) callback(failure);
    });
  });
}
function styleId() { return byId('style').value === 'gb' ? 'gb-t-7714-2015-numeric' : 'apa'; }
function renderState(state) {
  var gb = state.style === 'gb-t-7714-2015-numeric';
  return citationEngine.renderDocument(state, state.style, gb ? styleText.gb : styleText.apa, gb ? styleText.zh : styleText.en);
}
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeFragment(html) {
  var holder = document.createElement('div');
  holder.innerHTML = String(html || '');
  var allowed = { i: true, em: true, b: true, strong: true, sup: true, sub: true, span: true, div: true, br: true, a: true };
  function serialize(node) {
    if (node.nodeType === 3) return escapeHtml(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    var name = node.tagName.toLowerCase();
    if (name === 'script' || name === 'style' || name === 'iframe' || name === 'object') return '';
    var inner = '';
    for (var child = node.firstChild; child; child = child.nextSibling) inner += serialize(child);
    if (!allowed[name]) return inner;
    if (name === 'br') return '<br/>';
    if (name === 'a') {
      var href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) return '<a href="' + escapeHtml(href) + '">' + inner + '</a>';
    }
    return '<' + name + '>' + inner + '</' + name + '>';
  }
  return serialize(holder);
}
function textFromHtml(html) {
  var holder = document.createElement('div');
  holder.innerHTML = String(html || '');
  return holder.textContent || holder.innerText || '';
}
function normalizedText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}
function bibliographyHtml(bibliography) {
  var params = bibliography.parameters || {};
  var indent = params.hangingindent || params['second-field-align'] === 'flush' ? 36 : 0;
  var spacing = Number(params.linespacing) === 2 ? 2 : 1;
  return bibliography.entries.map(function (entryHtml) {
    var holder = document.createElement('div');
    holder.innerHTML = String(entryHtml || '');
    var entry = holder.querySelector('.csl-entry') || holder.firstElementChild || holder;
    var left = entry.querySelector('.csl-left-margin');
    var right = entry.querySelector('.csl-right-inline');
    var inner;
    if (left && right) inner = safeFragment(left.innerHTML) + '&nbsp;&nbsp;' + safeFragment(right.innerHTML);
    else inner = safeFragment(entry.innerHTML);
    var style = 'line-height:' + spacing + ';';
    if (indent) style += 'margin-left:' + indent + 'pt;text-indent:-' + indent + 'pt;';
    return '<p style="' + style + '">' + inner + '</p>';
  }).join('');
}
function showMissingFields(item) {
  if (!item.missing_fields || !item.missing_fields.length) return '';
  if (Array.isArray(item.missing_fields)) return item.missing_fields.join('、');
  return String(item.missing_fields);
}
function renderResults(items, total) {
  var list = byId('results');
  while (list.firstChild) list.removeChild(list.firstChild);
  searchResults = Object.create(null);
  byId('resultCount').textContent = total === undefined ? String(items.length) : '共 ' + total + ' 条';
  items.forEach(function (item, index) {
    if (!item || item.id === undefined || !item.csl || typeof item.csl !== 'object') return;
    var id = String(item.id);
    var snapshot = JSON.parse(JSON.stringify(item.csl));
    snapshot.id = id;
    var row = document.createElement('label');
    row.className = 'record';
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('data-item-id', id);
    row.appendChild(checkbox);

    var details = document.createElement('span');
    details.className = 'record-details';
    var title = document.createElement('strong');
    title.textContent = item.title || '未提供题名';
    details.appendChild(title);
    var authors = (item.authors || []).map(function (author) {
      return [author.given, author.family].filter(Boolean).join(' ');
    }).filter(Boolean).join(', ');
    var meta = document.createElement('span');
    meta.textContent = [authors, item.year, item.container_title, item.doi].filter(Boolean).join(' · ');
    details.appendChild(meta);
    var missing = showMissingFields(item);
    if (missing) {
      var warning = document.createElement('span');
      warning.className = 'missing';
      warning.textContent = '缺少字段：' + missing + '。可在 Folio 文献管理中修正；当前引用只使用已有信息。';
      details.appendChild(warning);
    }
    row.appendChild(details);

    var locator = document.createElement('span');
    locator.className = 'locator';
    locator.appendChild(document.createTextNode('页码'));
    var locatorInput = document.createElement('input');
    locatorInput.type = 'text';
    locatorInput.setAttribute('data-locator-for', id);
    locatorInput.setAttribute('aria-label', '页码定位符 ' + (index + 1));
    locator.appendChild(locatorInput);
    row.appendChild(locator);
    list.appendChild(row);
    searchResults[id] = item;
  });
}
function saveToken() {
  var value = byId('token').value.trim();
  if (value) window.localStorage.setItem('folio.plugin.token', value);
  else window.localStorage.removeItem('folio.plugin.token');
  status(value ? 'Folio 插件 token 已保存在此 Word 加载项配置中。' : '已清除保存的 token。', false);
}
function searchLiterature() {
  var query = byId('query').value.trim();
  if (!query) { status('请输入题名、作者、DOI 或关键词。', true); return; }
  status('正在查询 Folio 文献…', false);
  requestJson('/bridge/v1/literature?q=' + encodeURIComponent(query), function (error, response) {
    if (error) { status(error.message, true); return; }
    var items = response && Array.isArray(response.items) ? response.items : [];
    renderResults(items, response.total);
    status(items.length ? '选择一篇或多篇，再插入引用。' : '没有找到文献。', false);
  });
}
function selectedItems() {
  var checked = byId('results').querySelectorAll('input[type="checkbox"]:checked');
  var selections = [];
  for (var i = 0; i < checked.length; i += 1) {
    var id = checked[i].getAttribute('data-item-id');
    var record = searchResults[id];
    if (!record) continue;
    var locatorInput = byId('results').querySelector('input[data-locator-for="' + id.replace(/"/g, '\\"') + '"]');
    var locator = locatorInput ? locatorInput.value.trim() : '';
    selections.push({ id: id, csl: record.csl, locator: locator });
  }
  return selections;
}
function saveThen(callback) {
  var settingsState = readState();
  saveState(settingsState, function (error) {
    if (error) { status(error.message + ' Save the Word document and try again.', true); return; }
    callback(settingsState);
  });
}
function refreshLiteratureSnapshots(state, callback) {
  requestJson('/bridge/v1/literature?q=', function (error, response) {
    if (error) { callback(error); return; }
    var replacements = Object.create(null);
    if (response && Array.isArray(response.items)) {
      response.items.forEach(function (record) {
        if (!record || record.id === undefined || !record.csl || typeof record.csl !== 'object') return;
        var id = String(record.id);
        if (!Object.prototype.hasOwnProperty.call(state.items, id)) return;
        var snapshot = JSON.parse(JSON.stringify(record.csl));
        snapshot.id = id;
        replacements[id] = snapshot;
      });
    }
    var missing = 0;
    Object.keys(state.items).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(replacements, id)) state.items[id] = replacements[id];
      else missing += 1;
    });
    callback(null, { updated: Object.keys(replacements).length, missing: missing });
  });
}
function refreshDocument(styleOverride, updateOnline) {
  var state = readState();
  if (styleOverride) state.style = styleOverride;
  var onlineReport = null;
  var onlineFallback = '';
  function refreshInWord() {
  Word.run(function (context) {
    var controls = context.document.contentControls;
    controls.load('items/id,tag');
    return context.sync().then(function () {
      controls.items.forEach(function (control) { control.getRange().load('text'); });
      return context.sync().then(function () {
        var snapshots = controls.items.map(function (control) {
          return { tag: control.tag, text: control.getRange().text };
        });
        var citationsById = Object.create(null);
        state.citations.forEach(function (citation) { citationsById[citation.id] = citation; });
        snapshots.forEach(function (snapshot) {
          if (snapshot.tag.indexOf(CITATION_PREFIX) !== 0) return;
          var citation = citationsById[snapshot.tag.slice(CITATION_PREFIX.length)];
          if (citation && citation.renderedText && normalizedText(snapshot.text) !== normalizedText(citation.renderedText)) snapshot.manualEdit = true;
        });
        var bibliographySnapshot = snapshots.filter(function (snapshot) { return snapshot.tag === BIBLIOGRAPHY_TAG; })[0];
        var manualBibliography = Boolean(bibliographySnapshot && state.bibliographyText && normalizedText(bibliographySnapshot.text) !== normalizedText(state.bibliographyText));
        state = stateModule.reconcileState(state, snapshots, makeId);
        snapshots.forEach(function (snapshot, index) {
          if (snapshot.tag !== controls.items[index].tag) controls.items[index].tag = snapshot.tag;
        });
        var rendered = renderState(state);
        var byTag = Object.create(null);
        var snapshotsByTag = Object.create(null);
        controls.items.forEach(function (control) { byTag[control.tag] = control; });
        snapshots.forEach(function (snapshot) { snapshotsByTag[snapshot.tag] = snapshot; });
        var manualCitationCount = 0;
        state.citations.forEach(function (citation) {
          var control = byTag[CITATION_PREFIX + citation.id];
          if (!control || !rendered.citations[citation.id]) return;
          if (snapshotsByTag[control.tag] && snapshotsByTag[control.tag].manualEdit) {
            manualCitationCount += 1;
            return;
          }
          control.insertHtml(safeFragment(rendered.citations[citation.id]), 'Replace');
          citation.renderedText = textFromHtml(rendered.citations[citation.id]);
        });

        var bibHtml = bibliographyHtml(rendered.bibliography);
        var bibliographyControl = byTag[BIBLIOGRAPHY_TAG];
        if (state.citations.length && bibHtml) {
          if (!bibliographyControl) {
            var paragraph = context.document.body.insertParagraph('', 'End');
            bibliographyControl = paragraph.getRange().insertContentControl();
            bibliographyControl.tag = BIBLIOGRAPHY_TAG;
            bibliographyControl.title = 'Folio bibliography';
          }
          if (manualBibliography) {
            manualCitationCount += 1;
          } else {
            bibliographyControl.insertHtml(bibHtml, 'Replace');
            state.bibliographyText = textFromHtml(bibHtml);
          }
        } else if (bibliographyControl) {
          if (manualBibliography) manualCitationCount += 1;
          else {
            bibliographyControl.delete(false);
            state.bibliographyText = '';
          }
        } else {
          state.bibliographyText = '';
        }
        return context.sync().then(function () { return { state: state, manualEditCount: manualCitationCount }; });
      });
    });
  }).then(function (refreshResult) {
    state = refreshResult.state;
    saveState(state, function (error) {
      if (error) { status(error.message + ' Save the Word document.', true); return; }
      var message = state.citations.length ? '引用和书目已按 ' + (state.style === 'apa' ? 'APA 7' : 'GB/T 7714-2015') + ' 刷新。请保存 Word 文档。' : '文档中没有 Folio 引用。';
      if (refreshResult.manualEditCount) message += ' 已保留 ' + refreshResult.manualEditCount + ' 处手动文字修改。';
      if (onlineFallback) message += ' Folio 当前不可用，已使用文档中保存的书目信息（' + onlineFallback + '）。';
      else if (onlineReport && onlineReport.updated) message += ' 已从 Folio 更新 ' + onlineReport.updated + ' 条书目快照。';
      if (onlineReport && onlineReport.missing) message += ' ' + onlineReport.missing + ' 条记录未能按稳定 ID 匹配，保留了原快照。';
      status(message, false);
    });
  }, function (error) { status(error.message || String(error), true); });
  }
  if (!updateOnline || !Object.keys(state.items).length) { refreshInWord(); return; }
  if (!token()) {
    onlineFallback = 'Folio 插件 token 未配置。';
    refreshInWord();
    return;
  }
  status('正在从 Folio 更新已引用文献…', false);
  refreshLiteratureSnapshots(state, function (error, report) {
    if (error) onlineFallback = error.message || 'Folio 连接失败。';
    else onlineReport = report;
    refreshInWord();
  });
}
function insertCitation() {
  var selections = selectedItems();
  if (!selections.length) { status('请至少选择一条已有 CSL 元数据的文献。', true); return; }
  var state;
  var citationId;
  var initialCitationHtml;
  try {
    state = stateModule.addCitation(readState(), selections, makeId);
    state.style = styleId();
    citationId = state.citations[state.citations.length - 1].id;
    initialCitationHtml = renderState(state).citations[citationId];
    if (!initialCitationHtml) throw new Error('无法生成所选文献的引用格式。');
  } catch (error) { status(error.message, true); return; }
  saveState(state, function (error) {
    if (error) { status(error.message, true); return; }
    Word.run(function (context) {
      var range = context.document.getSelection().getRange('End');
      var control = range.insertContentControl();
      control.tag = CITATION_PREFIX + state.citations[state.citations.length - 1].id;
      control.title = 'Folio citation';
      control.insertHtml(safeFragment(initialCitationHtml), 'Replace');
      return context.sync();
    }).then(function () {
      refreshDocument(null, false);
    }, function (wordError) { status(wordError.message || String(wordError), true); });
  });
}
function initialize() {
  if (!Office.context || Office.context.host !== Office.HostType.Word) {
    status('请在 Windows Word 中打开此加载项。', true);
    return;
  }
  if (!Office.context.requirements || !Office.context.requirements.isSetSupported('WordApi', '1.1')) {
    status('此 Word 主机未提供 WordApi 1.1；请在支持该 requirement set 的 Word 桌面版中打开。', true);
    return;
  }
  if (!Office.context.document || !Office.context.document.settings || typeof Word === 'undefined') {
    status('此 Word 主机缺少文档设置或 Word API，无法保存稳定引用。', true);
    return;
  }
  byId('token').value = token();
  byId('saveToken').addEventListener('click', saveToken);
  byId('search').addEventListener('click', searchLiterature);
  byId('query').addEventListener('keydown', function (event) { if (event.keyCode === 13) searchLiterature(); });
  byId('insert').addEventListener('click', insertCitation);
  byId('refresh').addEventListener('click', function () { refreshDocument(styleId(), true); });
  byId('style').addEventListener('change', function () { refreshDocument(styleId(), false); });
  var state = readState();
  byId('style').value = state.style === 'gb-t-7714-2015-numeric' ? 'gb' : 'apa';
  loadStyles(function (error) {
    if (error) { status(error.message, true); return; }
    byId('search').disabled = false;
    byId('insert').disabled = false;
    byId('refresh').disabled = false;
    refreshDocument(null, false);
  });
}

if (typeof Office !== 'undefined' && Office.onReady) Office.onReady(initialize);
else if (typeof Office !== 'undefined') Office.initialize = initialize;
