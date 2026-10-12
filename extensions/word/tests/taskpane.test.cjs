'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');
var test = require('node:test');
var documentState = require('../src/document-state');

var extensionRoot = path.resolve(__dirname, '..');
var styleSources = {
  apa: fs.readFileSync(path.join(extensionRoot, 'styles', 'apa.csl'), 'utf8'),
  gb: fs.readFileSync(path.join(extensionRoot, 'styles', 'gb-t-7714-2015-numeric.csl'), 'utf8'),
  en: fs.readFileSync(path.join(extensionRoot, 'styles', 'locales-en-US.xml'), 'utf8'),
  zh: fs.readFileSync(path.join(extensionRoot, 'styles', 'locales-zh-CN.xml'), 'utf8')
};
var alpha = { id: 'alpha', type: 'article-journal', title: 'Alpha Research', author: [{ given: 'Ada', family: 'Lovelace' }], 'container-title': 'Journal of Tests', issued: { 'date-parts': [[2020]] } };

function visibleText(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function fakeElement() {
  var element = { nodeType: 1, tagName: 'DIV', firstChild: null, firstElementChild: null, innerText: '', textContent: '' };
  Object.defineProperty(element, 'innerHTML', {
    get: function () { return element._html || ''; },
    set: function (value) {
      element._html = String(value || '');
      element.textContent = visibleText(element._html);
      element.innerText = element.textContent;
      element.firstChild = element.textContent ? { nodeType: 3, nodeValue: element.textContent } : null;
      element.firstElementChild = null;
    }
  });
  element.querySelector = function () { return null; };
  return element;
}

function makeControl(tag, text) {
  return {
    tag: tag,
    title: '',
    text: text || '',
    insertions: [],
    deleted: false,
    ranges: [],
    getRange: function () {
      var control = this;
      var range = { loaded: false, requested: false, load: function () { this.requested = true; } };
      Object.defineProperty(range, 'text', { get: function () {
        if (!range.loaded) throw new Error('Property text is not loaded on this Range.');
        return control.text;
      } });
      this.ranges.push(range);
      return range;
    },
    insertHtml: function (html) {
      this.insertions.push(html);
      this.text = visibleText(html);
    },
    delete: function () { this.deleted = true; }
  };
}

function makeTaskpane(initialState, controls, options) {
  options = options || {};
  var nodes = Object.create(null);
  ['status', 'token', 'saveToken', 'search', 'query', 'resultCount', 'insert', 'refresh'].forEach(function (id) {
    nodes[id] = { textContent: '', className: '', value: '', disabled: true, addEventListener: function () {} };
  });
  nodes.style = { value: 'apa', addEventListener: function () {} };
  nodes.results = {
    querySelectorAll: function () { return options.selected ? [{ getAttribute: function () { return 'alpha'; } }] : []; },
    querySelector: function () { return { value: '' }; },
    appendChild: function () {},
    removeChild: function () {},
    get firstChild() { return null; }
  };
  var settingsValue = JSON.stringify(initialState || documentState.emptyState());
  var settings = {
    get: function () { return settingsValue; },
    set: function (_key, value) { settingsValue = value; },
    saveAsync: function (callback) {
      callback(options.saveFailure ? { status: 'failed', error: { message: 'settings write failed' } } : { status: 'succeeded' });
    }
  };
  var runCount = 0;
  var syncCount = 0;
  var paragraphNumber = 0;
  var requests = [];
  function MockXMLHttpRequest() {
    this.headers = {};
    requests.push(this);
  }
  MockXMLHttpRequest.prototype.open = function (method, url) { this.method = method; this.url = url; };
  MockXMLHttpRequest.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
  MockXMLHttpRequest.prototype.send = function () {
    var request = this;
    var response = options.xhrResponses && options.xhrResponses.length ? options.xhrResponses.shift() : { body: {} };
    setTimeout(function () {
      if (response.error) { request.onerror(); return; }
      request.readyState = 4;
      request.status = response.status || 200;
      request.responseText = JSON.stringify(response.body || {});
      request.onreadystatechange();
    }, 0);
  };
  var api = {
    state: function () { return documentState.parseState(settingsValue); },
    controls: controls,
    nodes: nodes,
    setSearchResults: function (value) { api.searchResults = value; }
  };
  var Office = {
    HostType: { Word: 'Word' },
    AsyncResultStatus: { Succeeded: 'succeeded' },
    context: {
      host: 'Word',
      requirements: { isSetSupported: function () { return true; } },
      document: { settings: settings }
    },
    onReady: function () {}
  };
  var Word = {
    run: function (callback) {
      runCount += 1;
      var currentRun = runCount;
      var context = {
        document: {
          contentControls: { get items() { return controls; }, load: function () {} },
          getSelection: function () {
            return { getRange: function () {
              return { insertContentControl: function () {
                var control = makeControl('', '');
                controls.push(control);
                return control;
              } };
            } };
          },
          body: { insertParagraph: function () {
            paragraphNumber += 1;
            return { getRange: function () { return { insertContentControl: function () {
              var control = makeControl('', '');
              controls.push(control);
              return control;
            } }; } };
          } }
        },
        sync: function () {
          syncCount += 1;
          if (options.syncFailure && currentRun === options.syncFailure.run && syncCount === options.syncFailure.call) return Promise.reject(new Error('Word sync failed'));
          controls.forEach(function (control) {
            control.ranges.forEach(function (range) { if (range.requested) range.loaded = true; });
          });
          return Promise.resolve();
        }
      };
      return Promise.resolve().then(function () { return callback(context); });
    }
  };
  var context = {
    require: function (request) {
      return request.charAt(0) === '.' ? require(path.resolve(extensionRoot, 'src', request)) : require(request);
    },
    document: { getElementById: function (id) { return nodes[id]; }, createElement: fakeElement },
    window: { localStorage: { getItem: function () { return options.token || ''; }, setItem: function () {}, removeItem: function () {} } },
    Office: Office,
    Word: Word,
    XMLHttpRequest: MockXMLHttpRequest,
    console: console,
    Promise: Promise,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  context.globalThis = context;
  var source = fs.readFileSync(path.join(extensionRoot, 'src', 'taskpane.js'), 'utf8');
  var setup = '\nstyleText.apa = ' + JSON.stringify(styleSources.apa) + ';' +
    '\nstyleText.gb = ' + JSON.stringify(styleSources.gb) + ';' +
    '\nstyleText.en = ' + JSON.stringify(styleSources.en) + ';' +
    '\nstyleText.zh = ' + JSON.stringify(styleSources.zh) + ';' +
    '\nsearchResults = {alpha: {id: "alpha", csl: ' + JSON.stringify(alpha) + '}};' +
    '\nglobalThis.__taskpane = {refreshDocument: refreshDocument, refreshCommand: folioRefreshDocument, insertCitation: insertCitation, state: function () { return readState(); }};';
  vm.runInNewContext(source + setup, context, { filename: 'taskpane.js' });
  api.taskpane = context.__taskpane;
  api.settingsValue = function () { return settingsValue; };
  api.syncCount = function () { return syncCount; };
  api.requests = requests;
  return api;
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

test('inserting a citation writes initial text before refresh reconciles controls', async function () {
  var app = makeTaskpane(documentState.emptyState(), [], { selected: true });

  app.taskpane.insertCitation();
  await tick();
  await tick();

  var citationControl = app.controls.filter(function (control) { return control.tag.indexOf('folio-cite:') === 0; })[0];
  assert.ok(citationControl);
  assert.match(citationControl.text, /Lovelace, 2020/);
  assert.equal(app.state().citations.length, 1);
  assert.equal(app.state().citations[0].id, citationControl.tag.slice('folio-cite:'.length));
  assert.equal(app.controls.filter(function (control) { return control.tag.indexOf('folio-bibliography:') === 0; }).length, 1);
  assert.match(app.nodes.status.textContent, /刷新/);
});

test('Word sync and document-settings save failures never show a refresh success', async function (t) {
  await t.test('sync failure', async function () {
    var app = makeTaskpane(documentState.emptyState(), [], { syncFailure: { run: 1, call: 1 } });
    app.taskpane.refreshDocument(null);
    await tick();
    assert.match(app.nodes.status.textContent, /Word sync failed/);
    assert.doesNotMatch(app.nodes.status.textContent, /已刷新|刷新。/);
  });

  await t.test('saveAsync failure', async function () {
    var app = makeTaskpane(documentState.emptyState(), [], { saveFailure: true });
    app.taskpane.refreshDocument(null);
    await tick();
    await tick();
    assert.match(app.nodes.status.textContent, /settings write failed/);
    assert.doesNotMatch(app.nodes.status.textContent, /已刷新|刷新。/);
  });
});

test('refresh preserves manually edited citation and bibliography text', async function () {
  var state = documentState.addCitation(documentState.emptyState(), [{ id: 'alpha', csl: alpha }], function () { return 'citation-1'; });
  state.citations[0].renderedText = '(Lovelace, 2020)';
  state.bibliographyText = 'Previously generated bibliography';
  var citationControl = makeControl('folio-cite:citation-1', 'Manual citation wording');
  var bibliographyControl = makeControl('folio-bibliography:v1', 'Manual bibliography wording');
  var app = makeTaskpane(state, [citationControl, bibliographyControl]);

  app.taskpane.refreshDocument('gb-t-7714-2015-numeric');
  await tick();
  await tick();

  assert.equal(citationControl.text, 'Manual citation wording');
  assert.equal(bibliographyControl.text, 'Manual bibliography wording');
  assert.equal(citationControl.insertions.length, 0);
  assert.equal(bibliographyControl.insertions.length, 0);
  assert.equal(app.state().style, 'gb-t-7714-2015-numeric');
  assert.match(app.nodes.status.textContent, /保留 2 处手动文字修改/);
});

test('explicit refresh updates a CSL snapshot by stable ID after its title changes', async function () {
  var oldCsl = {
    id: 'record-1', type: 'article-journal', title: 'Old title',
    author: [{ given: 'Old', family: 'Author' }], issued: { 'date-parts': [[2012]] }
  };
  var correctedCsl = {
    id: 'source-csl-id', type: 'article-journal', title: 'Corrected title',
    author: [{ given: 'Ada', family: 'Lovelace' }], issued: { 'date-parts': [[2024]] }
  };
  var state = documentState.addCitation(documentState.emptyState(), [{ id: 'record-1', csl: oldCsl }], function () { return 'citation-1'; });
  var citationControl = makeControl('folio-cite:citation-1', 'Old citation');
  var app = makeTaskpane(state, [citationControl], {
    token: 'test-token',
    xhrResponses: [{ body: { items: [
      { id: 'other-record', csl: { id: 'other-record', title: 'Wrong record' } },
      { id: 'record-1', csl: correctedCsl }
    ] } }]
  });

  app.taskpane.refreshDocument(null, true);
  await tick();
  await tick();
  await tick();

  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, '/bridge/v1/literature?q=');
  assert.equal(app.requests[0].headers.Authorization, 'Bearer test-token');
  assert.equal(app.state().items['record-1'].id, 'record-1');
  assert.equal(app.state().items['record-1'].title, 'Corrected title');
  assert.equal(app.state().items['record-1'].author[0].family, 'Lovelace');
  assert.equal(app.state().items['record-1'].issued['date-parts'][0][0], 2024);
  assert.match(citationControl.text, /Lovelace/);
  assert.match(citationControl.text, /2024/);
  assert.match(app.nodes.status.textContent, /已从 Folio 更新 1 条书目快照/);
});

test('online refresh failure keeps the old CSL snapshot and reports offline fallback', async function () {
  var oldCsl = {
    id: 'record-1', type: 'article-journal', title: 'Stored title',
    author: [{ given: 'Old', family: 'Author' }], issued: { 'date-parts': [[2012]] }
  };
  var state = documentState.addCitation(documentState.emptyState(), [{ id: 'record-1', csl: oldCsl }], function () { return 'citation-1'; });
  var app = makeTaskpane(state, [makeControl('folio-cite:citation-1', 'Old citation')], {
    token: 'test-token', xhrResponses: [{ error: true }]
  });

  app.taskpane.refreshDocument(null, true);
  await tick();
  await tick();
  await tick();

  assert.equal(app.state().items['record-1'].title, 'Stored title');
  assert.equal(app.state().items['record-1'].author[0].family, 'Author');
  assert.match(app.nodes.status.textContent, /Folio 当前不可用，已使用文档中保存的书目信息/);
  assert.match(app.nodes.status.textContent, /Cannot reach Folio/);
});

test('ribbon refresh completes after citation and bibliography writes', async function () {
  var state = documentState.addCitation(documentState.emptyState(), [{ id: 'alpha', csl: alpha }], function () { return 'citation-1'; });
  var app = makeTaskpane(state, [makeControl('folio-cite:citation-1', 'Old citation')]);
  var completed = 0;
  app.taskpane.refreshCommand({ completed: function () { completed += 1; } });
  assert.equal(completed, 0);
  await tick();
  await tick();
  assert.equal(completed, 1);
  assert.equal(app.controls.filter(function (control) { return control.tag === 'folio-bibliography:v1'; }).length, 1);
  assert.match(app.nodes.status.textContent, /刷新/);
});

test('ribbon refresh ends its command when Word sync fails', async function () {
  var app = makeTaskpane(documentState.emptyState(), [], { syncFailure: { run: 1, call: 1 } });
  var completed = 0;
  app.taskpane.refreshCommand({ completed: function () { completed += 1; } });
  await tick();
  await tick();
  assert.equal(completed, 1);
  assert.match(app.nodes.status.textContent, /Word sync failed/);
  assert.equal(app.nodes.status.className, 'status error');
});
