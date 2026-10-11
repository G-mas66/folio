'use strict';

var CSL = require('citeproc');

function renderDocument(state, styleId, styleXml, localeXml) {
  var snapshot = state.items || {};
  var citations = state.citations || [];
  var ids = [];
  var seen = Object.create(null);
  citations.forEach(function (citation) {
    citation.items.forEach(function (item) {
      var id = String(item.id);
      if (snapshot[id] && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    });
  });

  var sys = {
    retrieveLocale: function () { return localeXml; },
    retrieveItem: function (id) { return snapshot[String(id)] || null; }
  };
  var locale = styleId === 'gb-t-7714-2015-numeric' ? 'zh-CN' : 'en-US';
  var engine = new CSL.Engine(sys, styleXml, locale);
  engine.updateItems(ids);

  var previous = [];
  var rendered = Object.create(null);
  citations.forEach(function (entry, index) {
    var citation = {
      citationID: entry.id,
      citationItems: entry.items.map(function (item) {
        var result = { id: String(item.id) };
        if (item.locator) {
          result.locator = String(item.locator);
          result.label = item.label || 'page';
        }
        return result;
      }),
      properties: { noteIndex: index }
    };
    var output = engine.processCitationCluster(citation, previous, []);
    output[1].forEach(function (pair) {
      var target = citations[pair[0]];
      if (target) rendered[target.id] = pair[1];
    });
    previous.push([entry.id, index]);
  });

  var bibliography = engine.makeBibliography();
  return {
    citations: rendered,
    bibliography: bibliography ? { parameters: bibliography[0], entries: bibliography[1] } : { parameters: {}, entries: [] }
  };
}

module.exports = { renderDocument: renderDocument };
