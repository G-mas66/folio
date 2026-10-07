'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temporaryParent = process.platform === 'win32'
  ? path.join(root, '.review', 'tmp')
  : (process.env.RUNNER_TEMP || os.tmpdir());
fs.mkdirSync(temporaryParent, { recursive: true });
const canonicalTemporaryParent = fs.realpathSync(temporaryParent);
const temporaryRoot = fs.mkdtempSync(path.join(canonicalTemporaryParent, 'folio-backend-review-'));
const reviewRoot = path.join(temporaryRoot, 'review');
const fixtureRoot = path.join(reviewRoot, 'fixtures');
const python = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv-macos', 'bin', 'python');
const modules = [
  'review.test_pdf_contract', 'review.test_api_contract', 'review.test_translation_flow',
  'review.test_chat_context', 'review.test_free_provider_contract', 'review.test_delete_contract',
  'review.test_pdf_upgrade_contract', 'review.test_tool_chat_contract', 'review.test_folder_contract',
  'review.test_model_discovery_contract', 'review.test_model_auto_discovery', 'review.test_stream_parser',
  'review.test_stream_contract', 'review.test_stream_upgrade', 'review.test_web_search_contract',
  'review.test_notes_contract', 'review.test_storage_identity', 'review.test_protocol_contract',
  'review.test_chat_sessions', 'review.test_chinese_import', 'review.test_pdf_process_cleanup',
  'backend_tests.test_glossary_contract',
];
const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: path.join(temporaryRoot, 'data'),
  WORKBENCH_CREDENTIAL_ROOT: path.join(temporaryRoot, 'credentials'),
  WORKBENCH_REVIEW_ROOT: reviewRoot,
  WORKBENCH_REVIEW_FIXTURES_DIR: fixtureRoot,
  WORKBENCH_FREE_API_URL: '',
  TMPDIR: temporaryRoot,
  TEMP: temporaryRoot,
  TMP: temporaryRoot,
};

function run(args) {
  const result = spawnSync(python, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

try {
  fs.mkdirSync(reviewRoot, { recursive: true });
  run(['-m', 'review.make_review_pdfs']);
  if (!process.exitCode) run(['-m', 'unittest', ...modules, '-v']);
} finally {
  const expectedParent = canonicalTemporaryParent;
  if (path.dirname(path.resolve(temporaryRoot)) === expectedParent && path.basename(temporaryRoot).startsWith('folio-backend-review-')) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
