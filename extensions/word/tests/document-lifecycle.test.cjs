'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');
var documentState = require('../src/document-state');
var citationEngine = require('../src/citation-engine');

var root = path.resolve(__dirname, '..');
var styles = {
  apa: fs.readFileSync(path.join(root, 'styles', 'apa.csl'), 'utf8'),
  gb: fs.readFileSync(path.join(root, 'styles', 'gb-t-7714-2015-numeric.csl'), 'utf8'),
  en: fs.readFileSync(path.join(root, 'styles', 'locales-en-US.xml'), 'utf8'),
  zh: fs.readFileSync(path.join(root, 'styles', 'locales-zh-CN.xml'), 'utf8')
};
var records = {
  alpha: { id: 'alpha', type: 'article-journal', title: 'Alpha Research', author: [{ given: 'Ada', family: 'Lovelace' }], 'container-title': 'Journal of Tests', volume: '1', issue: '2', page: '3-9', issued: { 'date-parts': [[2020]] }, DOI: '10.1234/a' },
  beta: { id: 'beta', type: 'article-journal', title: 'Beta Research', author: [{ given: 'Grace', family: 'Hopper' }], 'container-title': 'Journal of Tests', volume: '2', issue: '1', page: '10-20', issued: { 'date-parts': [[2021]] }, DOI: '10.1234/b' },
  gamma: { id: 'gamma', type: 'article-journal', title: 'Gamma Research', author: [{ given: 'Katherine', family: 'Johnson' }], 'container-title': 'Journal of Tests', volume: '3', issue: '1', page: '21-30', issued: { 'date-parts': [[2022]] }, DOI: '10.1234/c' }
};

function add(state, recordId, citationId) {
  return documentState.addCitation(state, [{ id: recordId, csl: records[recordId] }], function () { return citationId; });
}

function reconcileSavedDocument(savedSettings, controls, makeId) {
  return documentState.reconcileState(documentState.parseState(savedSettings), controls, makeId);
}

function render(state, style) {
  var isGb = style === 'gb-t-7714-2015-numeric';
  return citationEngine.renderDocument(state, style, isGb ? styles.gb : styles.apa, isGb ? styles.zh : styles.en);
}

test('reopened multi-citation document follows Word content-control order', function () {
  var state = add(add(documentState.emptyState(), 'alpha', 'first'), 'beta', 'second');
  var settingsAfterSave = JSON.stringify(state);
  var controlsAfterReopen = [
    { tag: 'folio-cite:second', text: 'old beta citation' },
    { tag: 'folio-cite:first', text: 'old alpha citation' }
  ];

  var reopenedState = reconcileSavedDocument(settingsAfterSave, controlsAfterReopen, function () { return 'unused'; });
  var output = render(reopenedState, 'gb-t-7714-2015-numeric');

  assert.deepEqual(reopenedState.citations.map(function (citation) { return citation.id; }), ['second', 'first']);
  assert.match(output.citations.second, /\[1\]/);
  assert.match(output.citations.first, /\[2\]/);
  assert.match(output.bibliography.entries[0], /Beta Research/);
  assert.match(output.bibliography.entries[1], /Alpha Research/);
});

test('one Word citation can contain multiple selected literature records', function () {
  var state = documentState.addCitation(documentState.emptyState(), [
    { id: 'alpha', csl: records.alpha },
    { id: 'beta', csl: records.beta }
  ], function () { return 'grouped'; });
  state = reconcileSavedDocument(JSON.stringify(state), [{ tag: 'folio-cite:grouped', text: 'selected works' }], function () { return 'unused'; });
  var output = render(state, 'gb-t-7714-2015-numeric');

  assert.equal(state.citations[0].items.length, 2);
  assert.equal(output.citations.grouped, '<sup>[1,2]</sup>');
  assert.equal(output.bibliography.entries.length, 2);
});

test('front insertion and moving citations renumber from the current Word order', function () {
  var state = add(add(documentState.emptyState(), 'alpha', 'first'), 'beta', 'second');
  state = add(state, 'gamma', 'third');
  var controls = [
    { tag: 'folio-cite:third', text: 'gamma' },
    { tag: 'folio-cite:second', text: 'beta' },
    { tag: 'folio-cite:first', text: 'alpha' }
  ];

  state = reconcileSavedDocument(JSON.stringify(state), controls, function () { return 'unused'; });
  var output = render(state, 'gb-t-7714-2015-numeric');

  assert.deepEqual(state.citations.map(function (citation) { return citation.id; }), ['third', 'second', 'first']);
  assert.deepEqual(state.citations.map(function (citation) { return output.citations[citation.id]; }), ['<sup>[1]</sup>', '<sup>[2]</sup>', '<sup>[3]</sup>']);
  assert.deepEqual(output.bibliography.entries.map(function (entry) { return /\[(\d+)\]/.exec(entry)[1]; }), ['1', '2', '3']);
});

test('deleting a Word control removes its citation and re-numbers later entries', function () {
  var state = add(add(documentState.emptyState(), 'alpha', 'first'), 'beta', 'second');
  var remainingControls = [{ tag: 'folio-cite:second', text: 'beta' }];

  state = reconcileSavedDocument(JSON.stringify(state), remainingControls, function () { return 'unused'; });
  var output = render(state, 'gb-t-7714-2015-numeric');

  assert.deepEqual(state.citations.map(function (citation) { return citation.id; }), ['second']);
  assert.deepEqual(Object.keys(state.items), ['beta']);
  assert.equal(output.citations.first, undefined);
  assert.equal(output.citations.second, '<sup>[1]</sup>');
  assert.equal(output.bibliography.entries.length, 1);
  assert.match(output.bibliography.entries[0], /\[1\].*Beta Research/);
});

test('saved document can switch between APA and GB/T styles offline', function () {
  var state = add(add(documentState.emptyState(), 'alpha', 'first'), 'beta', 'second');
  var controls = [
    { tag: 'folio-cite:second', text: 'beta' },
    { tag: 'folio-cite:first', text: 'alpha' }
  ];
  state = reconcileSavedDocument(JSON.stringify(state), controls, function () { return 'unused'; });

  var apa = render(state, 'apa');
  var gb = render(state, 'gb-t-7714-2015-numeric');

  assert.match(apa.citations.second, /Hopper, 2021/);
  assert.match(apa.citations.first, /Lovelace, 2020/);
  assert.equal(gb.citations.second, '<sup>[1]</sup>');
  assert.equal(gb.citations.first, '<sup>[2]</sup>');
});

test('copied Word controls with duplicate tags receive a fresh citation ID', function () {
  var state = add(documentState.emptyState(), 'alpha', 'original');
  var copiedControls = [
    { tag: 'folio-cite:original', text: 'original citation' },
    { tag: 'folio-cite:original', text: 'copied citation' }
  ];

  state = reconcileSavedDocument(JSON.stringify(state), copiedControls, function () { return 'copy'; });
  var output = render(state, 'gb-t-7714-2015-numeric');

  assert.deepEqual(state.citations.map(function (citation) { return citation.id; }), ['original', 'copy']);
  assert.equal(copiedControls[1].tag, 'folio-cite:copy');
  assert.deepEqual(state.citations.map(function (citation) { return citation.items[0].id; }), ['alpha', 'alpha']);
  assert.equal(output.citations.original, '<sup>[1]</sup>');
  assert.equal(output.citations.copy, '<sup>[1]</sup>');
  assert.equal(output.bibliography.entries.length, 1);
});
