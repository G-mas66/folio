const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderCitation } = require('../electron/citation-service.cjs');
const directory = path.resolve(__dirname, '../extensions/word/styles');
const paper = { id: 'unet', type: 'paper-conference', title: 'UNet++: A Nested U-Net Architecture for Medical Image Segmentation',
  author: [{ family: 'Zhou', given: 'Zongwei' }, { family: 'Rahman Siddiquee', given: 'Md Mahfuzur' }, { family: 'Tajbakhsh', given: 'Nima' }, { family: 'Liang', given: 'Jianming' }],
  issued: { 'date-parts': [[2018]] }, 'container-title': 'Deep Learning in Medical Image Analysis and Multimodal Learning for Clinical Decision Support',
  publisher: 'Springer International Publishing', 'publisher-place': 'Cham', page: '3-11' };

test('shared actual CSL renderer preserves compound surname and conference fields', () => {
  const result = renderCitation({ csl: paper, style: 'gb-t-7714-2015-numeric' }, directory);
  assert.match(result.bibliography_text, /RAHMAN SIDDIQUEE M M/);
  assert.match(result.bibliography_text, /\[C\]\/\//);
  assert.match(result.bibliography_text, /Cham: Springer International Publishing, 2018: 3-11/);
  assert.doesNotMatch(result.bibliography_body_text, /^\[1\]/);
  const reordered = Object.fromEntries(Object.entries(paper).reverse());
  assert.equal(renderCitation({ csl: reordered, style: result.style }, directory).fingerprint, result.fingerprint);
  assert.notEqual(renderCitation({ csl: { ...paper, page: '3-12' }, style: result.style }, directory).fingerprint, result.fingerprint);
});

test('document rendering follows actual citation order and includes multiple records', () => {
  const result = renderCitation({ style: 'gb-t-7714-2015-numeric', state: { items: { unet: paper, second: { ...paper, id: 'second', title: 'Second paper' } },
    citations: [{ id: 'front', items: [{ id: 'second' }] }, { id: 'back', items: [{ id: 'unet' }] }] } }, directory);
  assert.match(result.citation_texts.front, /1/);
  assert.match(result.citation_texts.back, /2/);
  assert.ok(result.bibliography_text.indexOf('Second paper') < result.bibliography_text.indexOf('UNet++'));
});
