const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'annotationMapping.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mappingModule = { exports: {} };
new Function('exports', 'require', 'module', compiled)(mappingModule.exports, require, mappingModule);
const { annotationMappingCandidates, normalizePdfText } = mappingModule.exports;

function segment(sequence_no, original_text, translation) {
  return { sequence_no, start_page: sequence_no, end_page: sequence_no, original_text, translation, id: sequence_no, status: 'completed' };
}

test('normalization expands Unicode ligatures and collapses line breaks', () => {
  assert.equal(normalizePdfText('The ﬁndings\nare useful.'), 'the findings are useful.');
});

test('a mono annotation maps toward original and dual by exact quote then segment paragraph', () => {
  const item = segment(7,
    'We use masked marker modeling to learn contextual representations of cells.',
    '我们采用掩码标记建模，学习细胞的上下文表示。');
  const annotation = {
    id: 'mono-note', pdf_kind: 'mono', page_no: 2,
    selected_text: '我们采用掩码标记建模，学习细胞的上下文表示。',
  };

  const candidates = annotationMappingCandidates(annotation, [item]);
  assert.deepEqual(candidates.filter((candidate) => candidate.kind === 'paragraph').map(({ targetKind, quote, segmentSequenceNo }) => ({ targetKind, quote, segmentSequenceNo })), [
    { targetKind: 'original', quote: item.original_text, segmentSequenceNo: 7 },
  ]);
  assert.ok(candidates.some((candidate) => candidate.targetKind === 'original' && candidate.kind === 'exact'));
  assert.ok(candidates.some((candidate) => candidate.targetKind === 'dual' && candidate.kind === 'exact'));
});

test('an original annotation uses the translated segment as its mono fallback', () => {
  const item = segment(3,
    'We use masked marker modeling to learn contextual representations of cells.',
    '我们采用掩码标记建模，学习细胞的上下文表示。');
  const annotation = {
    id: 'english-note', pdf_kind: 'original', page_no: 1,
    selected_text: 'masked marker modeling',
  };

  const candidates = annotationMappingCandidates(annotation, [item]);
  assert.deepEqual(candidates.filter((candidate) => candidate.kind === 'paragraph').map(({ targetKind, quote }) => ({ targetKind, quote })), [
    { targetKind: 'mono', quote: item.translation },
    { targetKind: 'dual', quote: item.original_text },
  ]);
});

test('a quote shared by multiple source segments has no paragraph fallback', () => {
  const segments = [
    segment(1, 'A common method phrase appears here.', '常见方法短语在这里。'),
    segment(2, 'Later, a common method phrase appears again.', '稍后常见方法短语再次出现。'),
  ];
  const annotation = {
    id: 'ambiguous', pdf_kind: 'original', page_no: 1,
    selected_text: 'common method phrase',
  };

  const candidates = annotationMappingCandidates(annotation, segments);
  assert.ok(candidates.length > 0, 'direct exact text can still be checked in target PDFs');
  assert.ok(candidates.every((candidate) => candidate.kind === 'exact'), 'ambiguous source segments must not invent a paragraph association');
});

test('a stored segment association resolves the fallback without re-matching its quote', () => {
  const segments = [
    segment(1, 'Repeated phrase.', '重复短语。'),
    segment(2, 'Repeated phrase.', '重复短语。'),
  ];
  const annotation = {
    id: 'associated', pdf_kind: 'mono', page_no: 4,
    selected_text: '重复短语。',
    segment_anchor: { sequence_no: 2, quote: '重复短语。' },
  };

  const candidates = annotationMappingCandidates(annotation, segments);
  assert.ok(candidates.some((candidate) => candidate.kind === 'paragraph' && candidate.targetKind === 'original' && candidate.segmentSequenceNo === 2));
});
