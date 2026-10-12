'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { renderDocument } = require('../extensions/word/src/citation-engine.js');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function textFromHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function renderCitation(input, stylesDirectory) {
  if (!input || !['gb-t-7714-2015-numeric', 'apa'].includes(input.style)) throw new Error('不支持的引用格式。');
  const gb = input.style === 'gb-t-7714-2015-numeric';
  const style = fs.readFileSync(path.join(stylesDirectory, gb ? 'gb-t-7714-2015-numeric.csl' : 'apa.csl'), 'utf8');
  const locale = fs.readFileSync(path.join(stylesDirectory, gb ? 'locales-zh-CN.xml' : 'locales-en-US.xml'), 'utf8');
  if (input.state) {
    const state = input.state;
    if (!state.items || !Array.isArray(state.citations) || Object.keys(state.items).length > 500 || state.citations.length > 2000) throw new Error('文档引用数量或格式不正确。');
    const rendered = renderDocument(state, input.style, style, locale);
    return { ...rendered, style: input.style, citation_texts: Object.fromEntries(Object.entries(rendered.citations).map(([id, html]) => [id, textFromHtml(html)])),
      bibliography_text: rendered.bibliography.entries.map(textFromHtml).join('\n') };
  }
  if (!input.csl || typeof input.csl !== 'object' || Array.isArray(input.csl) || typeof input.csl.title !== 'string') throw new Error('缺少结构化书目信息。');
  const csl = JSON.parse(JSON.stringify(input.csl));
  csl.id = String(csl.id || 'preview');
  const rendered = renderDocument({ items: { [csl.id]: csl }, citations: [{ id: 'preview', items: [{ id: csl.id }] }] }, input.style, style, locale);
  const citationHtml = rendered.citations.preview || '';
  const bibliographyHtml = rendered.bibliography.entries.join('');
  const bodyHtml = bibliographyHtml.replace(/<div class="csl-left-margin">[\s\S]*?<\/div>/g, '');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical({ csl, style: input.style, styleXml: style, localeXml: locale }))).digest('hex');
  return { style: input.style, citation_html: citationHtml, citation_text: textFromHtml(citationHtml), bibliography_html: bibliographyHtml,
    bibliography_text: textFromHtml(bibliographyHtml), bibliography_body_html: bodyHtml, bibliography_body_text: textFromHtml(bodyHtml), fingerprint };
}

module.exports = { renderCitation };
