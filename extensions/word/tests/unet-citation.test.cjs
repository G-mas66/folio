'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderDocument } = require('../src/citation-engine');

const styles = path.join(__dirname, '../styles');
const style = fs.readFileSync(path.join(styles, 'gb-t-7714-2015-numeric.csl'), 'utf8');
const locale = fs.readFileSync(path.join(styles, 'locales-zh-CN.xml'), 'utf8');
function bibliography(item) {
  const result = renderDocument({ items: { unet: item }, citations: [{ id: 'citation', items: [{ id: 'unet' }] }] }, 'gb-t-7714-2015-numeric', style, locale);
  assert.match(result.citations.citation, /1/);
  return result.bibliography.entries.join('').replace(/<[^>]*>/g, '').replace(/&#38;|&amp;/g, '&');
}

test('UNet++ preprint stays distinct from the complete conference publication', () => {
  const title = 'UNet++: A Nested U-Net Architecture for Medical Image Segmentation';
  const incomplete = bibliography({ id: 'unet', type: 'article', title,
    author: [{ family: 'Zhou', given: 'Zongwei' }, { family: 'Siddiquee', given: 'Md Mahfuzur Rahman' }, { family: 'Tajbakhsh', given: 'Nima' }, { family: 'Liang', given: 'Jianming' }],
    issued: { 'date-parts': [[2018]] }, DOI: '10.48550/arXiv.1807.10165', URL: 'https://arxiv.org/abs/1807.10165' });
  assert.match(incomplete, /\[A\/OL\]/);
  assert.match(incomplete, /SIDDIQUEE M M R/);
  assert.doesNotMatch(incomplete, /Springer/);

  const corrected = bibliography({ id: 'unet', type: 'paper-conference', title,
    author: [{ family: 'Zhou', given: 'Zongwei' }, { family: 'Rahman Siddiquee', given: 'Md Mahfuzur' }, { family: 'Tajbakhsh', given: 'Nima' }, { family: 'Liang', given: 'Jianming' }],
    issued: { 'date-parts': [[2018]] },
    'container-title': 'Deep Learning in Medical Image Analysis and Multimodal Learning for Clinical Decision Support',
    publisher: 'Springer International Publishing', 'publisher-place': 'Cham', page: '3-11' });
  assert.match(corrected, /\[C\]\/\//);
  assert.match(corrected, /RAHMAN SIDDIQUEE M M/);
  assert.match(corrected, /Cham: Springer International Publishing, 2018: 3-11/);
  assert.doesNotMatch(corrected, /\[A\/OL\]/);
});
