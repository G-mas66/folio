'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `bibliography-electron-${Date.now()}`);
const secretPath = path.join(output, 'native.secret');
const pipeName = `\\\\.\\pipe\\folio-review-${process.pid}`;
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(output, 'data'), WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'data'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), WORKBENCH_NATIVE_REGISTRATION: '0', WORKBENCH_PLUGIN_PORT: '0',
  WORKBENCH_NATIVE_PIPE_NAME: pipeName, WORKBENCH_NATIVE_SECRET_PATH: secretPath,
  APPDATA: path.join(output, 'profile'), LOCALAPPDATA: path.join(output, 'local'), TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;

function nativeSearch(secret) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Native integration timed out')); }, 20000);
    let buffer = Buffer.alloc(0);
    const send = value => { const bytes = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes])); };
    socket.on('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on('connect', () => send({ id: 'auth', type: 'FOLIO_NATIVE_AUTH', secret }));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0); const result = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        if (result.id === 'auth' && result.ok) send({ id: 'search', type: 'FOLIO_SEARCH', query: 'UNet++' });
        else { clearTimeout(timer); socket.end(); resolve(result); }
      }
    });
  });
}

(async () => {
  const application = await _electron.launch({ executablePath: process.env.FOLIO_REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.FOLIO_REVIEW_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 60000 });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => !!window.workbench, { timeout: 60000 });
    const call = (route, method = 'GET', body) => page.evaluate(input => window.workbench.request(input), { path: route, method, body });
    await call('/literature');
    const folder = await call('/folders', 'POST', { name: '引用验收' });
    const captured = await call('/literature/capture', 'POST', { folder_id: folder.id, csl: {
      title: 'UNet++ acceptance fixture', type: 'paper-conference', author: [{ family: 'Rahman Siddiquee', given: 'Md Mahfuzur' }],
      issued: { 'date-parts': [[2018]] }, 'container-title': 'Medical Image Analysis', publisher: 'Springer International Publishing', 'publisher-place': 'Cham', page: '3-11' } });
    const item = captured.item;
    assert.equal(item.folder_id, folder.id);
    const preview = await call('/literature/preview', 'POST', { record: item.csl, style: 'gb-t-7714-2015-numeric' });
    assert.match(preview.bibliography_text, /RAHMAN SIDDIQUEE M M/);
    assert.match(preview.bibliography_text, /\[C\]\/\//);
    await call(`/literature/${item.id}/citations`, 'POST', { style: preview.style, fingerprint: preview.fingerprint });
    let list = await call(`/literature?folder_id=${folder.id}`);
    assert.equal(list.items[0].citations[preview.style].stale, false);
    await call(`/literature/${item.id}`, 'PATCH', { pages: '3-12' });
    list = await call('/literature');
    assert.equal(list.items[0].citations[preview.style].stale, true);
    const rendered = await call('/literature/render-document', 'POST', { style: preview.style, state: { version: 1, items: { [item.id]: item.csl }, citations: [{ id: 'control-a', items: [{ id: item.id }] }] } });
    assert.match(rendered.bibliography_text, /3-11/);
    for (let retry = 0; retry < 100 && !fs.existsSync(secretPath); retry++) await new Promise(resolve => setTimeout(resolve, 100));
    const connection = await page.evaluate(() => window.workbench.pluginConnection('start'));
    assert.equal(connection.error, '', JSON.stringify(connection));
    assert.equal((await nativeSearch('0'.repeat(64))).status, 403);
    const search = await nativeSearch(fs.readFileSync(secretPath, 'utf8').trim());
    assert.equal(search.ok, true); assert.equal(search.result.items[0].id, item.id);
    const word = await page.evaluate(() => window.workbench.wordPlugin('status'));
    assert.equal(word.state, 'not_installed');
    await page.getByRole('tab', { name: '书目', exact: true }).click();
    await page.getByRole('heading', { name: 'UNet++ acceptance fixture', exact: true }).waitFor();
    await page.getByRole('button', { name: '引用', exact: true }).click();
    await page.getByText('正文引用', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'citation.png') });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, actualElectron: true, actualBackend: true, actualRenderer: true, workflows: ['folder', 'preview-confirm', 'stale', 'offline-snapshot', 'native-auth-search', 'word-status', 'citation-ui'] }, null, 2));
    console.log(output);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
