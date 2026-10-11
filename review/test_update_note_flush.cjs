const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '..', 'electron', 'main.cjs');
const source = fs.readFileSync(mainPath, 'utf8');
const start = source.indexOf('async function requestApi(input) {');
const end = source.indexOf('\nfunction secureWindowOptions()', start);
assert.notEqual(start, -1, 'requestApi should exist in electron/main.cjs');
assert.notEqual(end, -1, 'requestApi should end before secureWindowOptions');

const requests = [];
const context = {
  storageMigrationInProgress: false,
  updateInstallInProgress: true,
  backendBase: 'http://127.0.0.1:9000',
  backendToken: 'test-token',
  fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  },
};
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.requestApi = requestApi;`, context);

async function main() {
  const paperId = 'a'.repeat(32);
  const noteId = 'b'.repeat(32);
  for (const route of [`/papers/${paperId}/notes`, `/papers/${paperId}/notes/${noteId}`]) {
    const result = await context.requestApi({ path: route, method: 'PUT', body: { text: 'draft' } });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true }, `${route} should be permitted during install flush`);
  }
  assert.equal(requests.length, 2, 'both permitted note writes should reach the backend');

  for (const input of [
    { path: `/papers/${paperId}/notes`, method: 'GET' },
    { path: `/papers/${paperId}/notes/${noteId}`, method: 'PATCH', body: { title: 'renamed' } },
    { path: `/papers/${paperId}/notes/active`, method: 'PATCH', body: { note_id: noteId } },
    { path: `/papers/${paperId}/notes/${noteId}/extra`, method: 'PUT', body: { text: 'draft' } },
    { path: `/papers/${paperId}/annotations`, method: 'PUT', body: {} },
  ]) {
    await assert.rejects(context.requestApi(input), /应用正在准备安装更新/, `${input.method} ${input.path} should remain blocked`);
  }
  assert.equal(requests.length, 2, 'blocked requests must not reach the backend');
  console.log('Passed: update-install flush permits both legacy and per-note PUT routes while blocking unrelated requests.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
