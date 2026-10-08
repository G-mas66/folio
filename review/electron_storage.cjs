// Independent native migration with isolated config, virtual credentials and D data.
const assert = require('node:assert/strict');
const fs = process.getBuiltinModule('fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStreamFixture } = require('./fixture_stream_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `storage-native-${Date.now()}`);
const original = path.join(output, 'original-library');
const target = path.join(output, 'new-library');
const configPath = path.join(output, 'config', 'location.json');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });
fs.mkdirSync(target);
const env = { ...process.env, WORKBENCH_DATA_DIR: original, WORKBENCH_LOCATION_CONFIG: configPath, TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seeded = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', original], { cwd: root, env, encoding: 'utf8' });
assert.equal(seeded.status, 0, seeded.stderr);
const paper = JSON.parse(seeded.stdout.trim());
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash = hash(paper.source);
const pdfFolder = path.join(original, 'papers', paper.paper_id);
const pdfs = fs.readdirSync(pdfFolder).filter(name => name.endsWith('.pdf')).map(name => ({ relative: path.join('papers', paper.paper_id, name), hash: hash(path.join(pdfFolder, name)) }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error(message);
};

(async () => {
  const fixture = await createStreamFixture();
  const errors = [];
  const started = Date.now();
  let app, main;
  const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };
  const api = (url, method, body) => main.evaluate(input => window.workbench.request(input), { path: url, method, body });
  const picker = async chosen => app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: !directory, filePaths: directory ? [directory] : [] }); }, chosen);
  const choose = async directory => {
    await picker(directory);
    await main.getByRole('button', { name: '更改存储位置…', exact: true }).click();
  };
  const confirm = () => main.getByRole('button', { name: '确认迁移并重启', exact: true });
  try {
    app = await _electron.launch(options);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    const initialInfo = await main.evaluate(() => window.workbench.getAppInfo());
    assert.equal(initialInfo.dataRoot, original);
    assert.equal(initialInfo.uiDataRoot, path.join(original, 'electron-userData'));
    await api('/settings', 'PUT', { base_url: fixture.apiUrl, protocol: 'custom_chat_completions', model: 'stream-fixture', api_key: 'review-only-storage-key' });
    const folder = await api('/folders', 'POST', { name: '迁移验收分类' });
    await api(`/papers/${paper.paper_id}/folder`, 'PATCH', { folder_id: folder.id });
    await api(`/papers/${paper.paper_id}/notes`, 'PUT', { text: '迁移前的独立阅读笔记：137、23.7%、811。' });
    const mark = await api(`/papers/${paper.paper_id}/annotations`, 'POST', { pdf_kind: 'original', page_no: 1, kind: 'comment', color: 'blue', selected_text: '137 independent samples', comment: '迁移后必须保留这条批注', rects: [{ x: .1, y: .2, width: .2, height: .02 }] });
    await main.getByRole('button', { name: '设置', exact: true }).click();
    await main.getByRole('button', { name: '更改存储位置…', exact: true }).waitFor();
    await choose(null);
    assert.equal(await confirm().count(), 0, 'Canceling native picker must not prepare a migration');
    assert.equal(fs.existsSync(configPath), false);
    await choose(target);
    await confirm().waitFor();
    assert.equal(fs.readdirSync(target).length, 0, 'Choosing a folder does not move data before confirmation');
    assert.equal(fs.existsSync(configPath), false);
    await main.screenshot({ path: path.join(output, 'storage-setting.png') });
    await main.getByRole('button', { name: '取消迁移', exact: true }).click();
    assert.equal((await main.evaluate(() => window.workbench.getAppInfo())).dataRoot, original);
    const occupied = path.join(output, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'keep.txt'), 'Unrelated data');
    await choose(occupied);
    // Validation may happen in picker handling or only on explicit confirmation.
    if (await confirm().count()) await confirm().click();
    await until(async () => /为空|空文件夹/.test(await main.locator('.settings-panel').innerText()), 'Occupied location must show a clear error');
    assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'Unrelated data');
    assert.equal((await main.evaluate(() => window.workbench.getAppInfo())).dataRoot, original);
    assert.equal((await api('/papers')).length, 1, 'Failed migration must leave old backend usable');
    if (await main.getByRole('button', { name: '取消迁移', exact: true }).count()) await main.getByRole('button', { name: '取消迁移', exact: true }).click();

    // Fail after backend shutdown to prove the old service is restarted safely.
    await choose(target);
    await confirm().waitFor();
    await app.evaluate(() => {
      const files = process.getBuiltinModule('fs');
      globalThis.reviewOriginalCopyFile = files.promises.copyFile;
      files.promises.copyFile = async () => { throw new Error('review-only-copy-failure'); };
    });
    await confirm().click();
    await main.getByTestId('storage-migration-error').getByText(/review-only-copy-failure/).waitFor();
    await app.evaluate(() => {
      process.getBuiltinModule('fs').promises.copyFile = globalThis.reviewOriginalCopyFile;
      delete globalThis.reviewOriginalCopyFile;
    });
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.readdirSync(target).length, 0);
    assert.equal((await api('/papers')).length, 1, 'Copy failure after shutdown must restart the original backend');
    assert.equal((await api('/settings')).key_configured, true);
    await main.getByRole('button', { name: '取消迁移', exact: true }).click();

    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    let reader = main.getByTestId(`reader-tab-panel-${paper.paper_id}`);
    await reader.getByLabel('向当前文献提问').waitFor();
    await reader.getByLabel('当前页码').fill('2');
    await delay(700);
    fixture.state.pause = true;
    await reader.getByLabel('向当前文献提问').fill('停止思考测试');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.getByTestId('streaming-reasoning').getByText(/思考第一段/).waitFor();
    await main.getByRole('button', { name: '设置', exact: true }).click();
    await choose(target);
    await confirm().waitFor();
    await app.evaluate(({ app }, evidence) => {
      app.relaunch = () => process.getBuiltinModule('fs').writeFileSync(evidence, JSON.stringify({ requested: true }));
    }, path.join(output, 'relaunch-request.json'));
    const ended = app.waitForEvent('close', { timeout: 60000 });
    await confirm().click().catch(error => { if (!/closed|destroyed/i.test(error.message)) throw error; });
    await ended;
    app = null;
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'relaunch-request.json'), 'utf8')).requested, true);
    assert.equal(fixture.sessions.at(-1).closedEarly, true, 'Migration must stop the old stream');
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.dataRoot, target);
    assert.equal(savedConfig.credentialRoot, original);
    assert.equal(savedConfig.uiDataRoot, initialInfo.uiDataRoot);
    for (const pdf of pdfs) {
      assert.equal(hash(path.join(original, pdf.relative)), pdf.hash, 'Old library is retained as a backup');
      assert.equal(hash(path.join(target, pdf.relative)), pdf.hash);
    }
    assert.equal(fs.existsSync(path.join(target, 'electron-userData')), false, 'Live LevelDB must not be copied');
    assert.equal(fs.existsSync(path.join(target, '.backend-temp')), false);
    const nextEnv = { ...env };
    delete nextEnv.WORKBENCH_DATA_DIR;
    app = await _electron.launch({ ...options, env: nextEnv });
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    const newInfo = await main.evaluate(() => window.workbench.getAppInfo());
    assert.equal(newInfo.dataRoot, target);
    assert.equal(newInfo.uiDataRoot, initialInfo.uiDataRoot);
    await app.evaluate(({ shell }) => {
      globalThis.reviewLocations = [];
      shell.showItemInFolder = file => globalThis.reviewLocations.push(file);
      shell.openPath = async folder => { globalThis.reviewLocations.push(folder); return ''; };
    });
    await main.evaluate(id => window.workbench.revealPaperFile(id, 'original'), paper.paper_id);
    await main.evaluate(() => window.workbench.openLibraryFolder());
    const located = await app.evaluate(() => globalThis.reviewLocations);
    assert.ok(located[0].startsWith(path.join(target, 'papers', paper.paper_id) + path.sep));
    assert.ok(fs.existsSync(located[0]));
    assert.equal(located[1], path.join(target, 'papers'));
    assert.equal((await api('/settings')).key_configured, true, 'Moving must preserve Credential Manager identity');
    assert.equal((await api('/papers')).length, 1);
    assert.equal((await api(`/papers/${paper.paper_id}`)).folder_id, folder.id);
    assert.equal((await api('/folders'))[0].color, folder.color);
    assert.ok((await api(`/papers/${paper.paper_id}/notes`)).text.includes('137'));
    assert.equal((await api(`/papers/${paper.paper_id}/annotations`))[0].id, mark.id);
    const history = await api(`/papers/${paper.paper_id}/chat`);
    assert.equal(history.length, 2);
    assert.equal(history.at(-1).status, 'cancelled');
    reader = main.getByTestId(`reader-tab-panel-${paper.paper_id}`);
    await main.getByTestId(`paper-tab-${paper.paper_id}`).click();
    await reader.getByLabel('向当前文献提问').waitFor();
    assert.equal(await reader.getByLabel('当前页码').inputValue(), '2');
    await reader.getByTestId('reader-side-tab-notes').click();
    assert.ok((await reader.getByLabel('阅读笔记').inputValue()).includes('迁移前'));
    assert.ok((await reader.getByTestId(`reader-annotation-${mark.id}`).innerText()).includes('迁移后必须保留'));
    await reader.getByLabel('阅读笔记').fill('迁移后的新笔记应写入新位置。');
    await reader.getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await api(`/papers/${paper.paper_id}/notes`)).text === '迁移后的新笔记应写入新位置。', 'New saves must use target database');
    const sourceNote = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT text FROM paper_notes WHERE paper_id=?",(sys.argv[2],)).fetchone()[0])', path.join(original, 'workbench.sqlite'), paper.paper_id], { cwd: root, env: { ...env, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' });
    assert.equal(sourceNote.status, 0, sourceNote.stderr);
    assert.ok(sourceNote.stdout.includes('迁移前的独立阅读笔记'));
    assert.equal(hash(paper.source), sourceHash);
    assert.equal(errors.length, 0, errors.join('\n'));
    await main.screenshot({ path: path.join(output, 'migrated-notes.png') });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', version: require(path.join(root, 'package.json')).version, seconds: (Date.now() - started) / 1000, paper, initialInfo, newInfo, savedConfig, pdfs, mark, history: history.length, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    await main?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleaned = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; s=credential_service(); keyring.delete_password(s,"api-key") if keyring.get_password(s,"api-key") else None'], { cwd: root, env: { ...env, WORKBENCH_CREDENTIAL_ROOT: original }, encoding: 'utf8' });
    if (cleaned.status !== 0) throw new Error('Isolated credential cleanup failed');
  }
})();
