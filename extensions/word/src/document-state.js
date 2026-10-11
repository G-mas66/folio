'use strict';

var VERSION = 1;
var STYLE_IDS = ['apa', 'gb-t-7714-2015-numeric'];

function emptyState() {
  return { version: VERSION, style: 'apa', items: {}, citations: [], bibliographyText: '' };
}

function parseState(value) {
  if (!value) return emptyState();
  try {
    var parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.citations) || !parsed.items) return emptyState();
    return {
      version: VERSION,
      style: STYLE_IDS.indexOf(parsed.style) >= 0 ? parsed.style : 'apa',
      items: parsed.items,
      bibliographyText: typeof parsed.bibliographyText === 'string' ? parsed.bibliographyText : '',
      citations: parsed.citations.filter(function (citation) {
        return citation && typeof citation.id === 'string' && Array.isArray(citation.items);
      })
    };
  } catch (_error) {
    return emptyState();
  }
}

function reconcileState(state, controls, makeId) {
  var next = parseState(state);
  var citationsById = Object.create(null);
  var reservedIds = Object.create(null);
  next.citations.forEach(function (citation) {
    reservedIds[citation.id] = true;
    if (!citationsById[citation.id]) citationsById[citation.id] = citation;
  });

  var seen = Object.create(null);
  var ordered = [];
  controls.forEach(function (control) {
    if (!control || typeof control.tag !== 'string' || control.tag.indexOf('folio-cite:') !== 0 || !String(control.text || '').trim()) return;
    var id = control.tag.slice('folio-cite:'.length);
    var citation = citationsById[id];
    if (!citation) return;
    if (seen[id]) {
      if (typeof makeId !== 'function') throw new Error('A unique citation ID generator is required for duplicated Word controls.');
      var copyId = String(makeId());
      while (!copyId || reservedIds[copyId]) copyId = String(makeId());
      reservedIds[copyId] = true;
      control.tag = 'folio-cite:' + copyId;
      citation = JSON.parse(JSON.stringify(citation));
      citation.id = copyId;
    } else {
      seen[id] = true;
    }
    ordered.push(citation);
  });
  next.citations = ordered;

  var used = Object.create(null);
  next.citations.forEach(function (citation) {
    citation.items.forEach(function (item) { used[String(item.id)] = true; });
  });
  Object.keys(next.items).forEach(function (id) {
    if (!used[id]) delete next.items[id];
  });
  return next;
}

function addCitation(state, selectedItems, makeId) {
  var next = parseState(state);
  var items = [];
  var seen = Object.create(null);
  selectedItems.forEach(function (selection) {
    var id = String(selection.id);
    if (!id || seen[id] || !selection.csl || typeof selection.csl !== 'object') return;
    seen[id] = true;
    var snapshot = JSON.parse(JSON.stringify(selection.csl));
    snapshot.id = id;
    next.items[id] = snapshot;
    var citationItem = { id: id };
    if (selection.locator) {
      citationItem.locator = String(selection.locator);
      citationItem.label = 'page';
    }
    items.push(citationItem);
  });
  if (!items.length) throw new Error('Select at least one literature record with CSL data.');
  next.citations.push({ id: makeId(), items: items });
  return next;
}

module.exports = {
  VERSION: VERSION,
  emptyState: emptyState,
  parseState: parseState,
  reconcileState: reconcileState,
  addCitation: addCitation
};
