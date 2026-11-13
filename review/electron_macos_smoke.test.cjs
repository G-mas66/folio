'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the production helpers without launching Electron or touching any library.
const source = fs.readFileSync(path.join(__dirname, 'electron_macos_smoke.cjs'), 'utf8');
const helpers = source.slice(source.indexOf('function translationFailureStatus('), source.indexOf('function createProvider('));

function harness(options = {}) {
  const bytes = Buffer.from('%PDF-synthetic-test-only');
  const calls = [];
  const report = {};
  let generation = 0;
  let title = '';
  let verificationCount = 0;
  const context = vm.createContext({
    assert, crypto, path, Buffer, report, backend: '/packaged/backend', engine: '/packaged/engine', runRoot: '/isolated',
    fs: { readFileSync: () => bytes, mkdirSync() {}, writeFileSync() {} },
    setTimeout: callback => { callback(); },
    run: async (python, args) => {
      verificationCount += 1;
      assert.equal(python, '/python');
      assert.match(args[1], /PdfReader/);
      assert.match(args[1], /translated PDFs contain no Chinese text/);
      assert.equal(JSON.parse(args[2]).length, 3);
      return { code: options.invalidPdf ? 1 : 0, stderr: 'invalid PDF', stdout: '{"status":"passed"}\n' };
    },
  });
  vm.runInContext(helpers, context);
  function paper() {
    return { id: 'synthetic', source_language: 'en', chinese_title: title, english_title: 'Synthetic Study',
      status: generation ? 'completed' : 'stopped', can_read: !!generation, page_count: 1, pdf_progress: generation ? 100 : 0,
      mono_pdf_file_name: generation ? 'mono-' + (options.stale ? 1 : generation) + '.pdf' : '',
      dual_pdf_file_name: generation ? 'dual-' + (options.stale ? 1 : generation) + '.pdf' : '' };
  }
  const page = { evaluate: async (fn, input) => {
    calls.push(input);
    if (input.path === '/papers/import') return { results: [{ duplicate: false, paper: paper() }] };
    if (input.method === 'PATCH') { generation += 1; title = input.body.chinese_title || '合成研究'; return paper(); }
    if (input.binary) return Array.from(bytes);
    if (options.failure) return { ...paper(), status: 'error', error: options.failure };
    return paper();
  } };
  return { context, report, calls, page, verifyCount: () => verificationCount };
}

test('translation uses backend API for empty and supplied Chinese titles and verifies downloaded PDFs', async () => {
  const h = harness();
  await h.context.checkBackendTranslation(h.page, '/synthetic.pdf', '/python', {});
  assert.equal(h.report.free_translation.status, 'success');
  assert.equal(h.verifyCount(), 2);
  assert.equal(h.calls[0].path, '/papers/import');
  assert.equal(h.calls[0].body.defer_translation, true);
  assert.deepEqual(h.calls.filter(c => c.method === 'PATCH').map(c => c.body.chinese_title), ['', '合成测量研究中文标题']);
  assert.equal(h.calls.filter(c => c.binary).length, 6);
  assert.ok(h.report.free_translation.cases.every(c => c.status === 'success' && c.artifacts.length === 3));
});

for (const [failure, category] of [
  ['SSL: CERTIFICATE_VERIFY_FAILED certificate verify failed', 'tls_failure'],
  ['HTTP 503 service unavailable', 'external_service_unavailable'],
  ['request timed out', 'translation_timeout'],
]) {
  test(category + ' always fails the release gate and retains backend error evidence', async () => {
    const h = harness({ failure });
    await assert.rejects(h.context.checkBackendTranslation(h.page, '/synthetic.pdf', '/python', {}), /release gate failed/);
    assert.equal(h.report.free_translation.status, category);
    assert.equal(h.report.free_translation.cases[0].final_paper.error, failure);
    assert.equal(h.verifyCount(), 0);
  });
}

test('polling records queued state and rejects expiry instead of accepting partial work', async () => {
  const h = harness();
  const evidence = { requests: [], states: [] };
  let polls = 0;
  const page = { evaluate: async () => (++polls === 1
    ? { status: 'queued', pdf_progress: 0, chinese_title: '', error: '' }
    : { status: 'completed', can_read: true, pdf_progress: 100, chinese_title: '中文', mono_pdf_file_name: 'mono.pdf', dual_pdf_file_name: 'dual.pdf' }) };
  await h.context.waitForTranslation(page, 'synthetic', evidence);
  assert.equal(evidence.states[0].status, 'queued');
  assert.equal(evidence.states[1].status, 'completed');
  await assert.rejects(h.context.waitForTranslation(page, 'synthetic', evidence, 0), /timed out/);
});

test('a second title run cannot pass by reusing old outputs', async () => {
  const h = harness({ stale: true });
  await assert.rejects(h.context.checkBackendTranslation(h.page, '/synthetic.pdf', '/python', {}), /fresh output names/);
  assert.notEqual(h.report.free_translation.status, 'success');
});

test('invalid downloaded PDF fails even if backend reports completed', async () => {
  const h = harness({ invalidPdf: true });
  await assert.rejects(h.context.checkBackendTranslation(h.page, '/synthetic.pdf', '/python', {}), /PDF validation failed/);
  assert.equal(h.report.free_translation.status, 'failed');
});

test('translation gate remains inside live app try before guaranteed cleanup', () => {
  const check = source.indexOf('await checkBackendTranslation(library,');
  assert.ok(check > source.indexOf('async function main('));
  assert.ok(check < source.indexOf('if (application) await application.close()'));
  assert.ok(source.includes("report.free_translation.status, 'success'"));
  assert.ok(!source.includes('free-translation-output'));
  assert.ok(!source.includes('external_failure_accepted'));
  assert.ok(source.includes("fs.mkdtempSync(path.join(runRoot, 'app-run-'))"));
});
