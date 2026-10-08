// Independent native QA of text selection, PDF marks and per-paper notes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStreamFixture } = require('./fixture_stream_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `notes-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = module => {
  const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', module, dataRoot], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};
const first = seed('review.seed_reader_fixture');
const second = seed('review.seed_tabs_fixture');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = [first, second].map(paper => ({ path: paper.source, hash: digest(paper.source) }));
const libraryPdfs = [first, second].flatMap(paper => {
  const folder = path.join(dataRoot, 'papers', paper.paper_id);
  return fs.readdirSync(folder).filter(name => name.endsWith('.pdf')).map(name => ({ path: path.join(folder, name), hash: digest(path.join(folder, name)) }));
});
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
  const panel = id => main.getByTestId(`reader-tab-panel-${id}`);
  const current = () => panel(first.paper_id);
  const api = (url, method, body) => main.evaluate(input => window.workbench.request(input), { path: url, method, body });
  const marks = id => api(`/papers/${id}/annotations`);
  const note = id => api(`/papers/${id}/notes`);
  const open = async id => {
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').first().waitFor();
    const title = id === first.paper_id ? '连续阅读验收文献' : '第二篇隔离验收文献';
    await main.locator('.paper-card').filter({ hasText: title }).getByRole('button', { name: '阅读', exact: true }).click();
    await panel(id).getByLabel('当前页码').waitFor();
  };
  const select = async (id, lines = 1) => {
    await panel(id).locator('.textLayer span').first().waitFor();
    const selected = await panel(id).evaluate((element, lineCount) => {
      const page = element.querySelector('.pdf-page-frame[data-rendered="true"]');
      const spans = [...page.querySelectorAll('.textLayer span')].filter(span => span.textContent.trim());
      const start = spans.findIndex(span => /137|249/.test(span.textContent));
      const firstSpan = spans[Math.max(0, start)];
      const lastSpan = spans[Math.min(spans.length - 1, Math.max(0, start) + lineCount - 1)];
      const range = document.createRange();
      range.setStart(firstSpan.firstChild, 0);
      range.setEnd(lastSpan.firstChild, lastSpan.firstChild.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      page.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    }, lines);
    await panel(id).getByTestId('reader-selection-toolbar').waitFor();
    return selected;
  };
  const rect = async id => current().getByTestId(`annotation-rect-${id}-0`).evaluate(element => {
    const mark = element.getBoundingClientRect();
    const page = element.closest('.pdf-page-stage').getBoundingClientRect();
    return { x: (mark.x - page.x) / page.width, y: (mark.y - page.y) / page.height, width: mark.width / page.width, height: mark.height / page.height };
  });
  const aligned = (actual, expected) => {
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < .003, `${key} mark alignment changed: ${actual[key]} vs ${expected[key]}`);
  };
  try {
    app = await _electron.launch(options);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    await open(first.paper_id);
    await current().getByRole('button', { name: '原文 PDF', exact: true }).click();
    await until(async () => current().locator('.pdf-page-stage > canvas').first().evaluate(canvas => canvas.width / canvas.height < 1), 'Original PDF must finish loading');
    await current().getByLabel('向当前文献提问').fill('我的 AI 草稿不应被选区覆盖');
    const selectedText = await select(first.paper_id, 2);
    await current().getByTestId('reader-selection-toolbar').getByRole('button', { name: '高亮', exact: true }).click();
    await current().getByTestId('reader-selection-toolbar').getByRole('button', { name: '绿色高亮', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 1, 'Highlight must reach the database');
    const highlight = (await marks(first.paper_id))[0];
    assert.equal(highlight.pdf_kind, 'original');
    assert.equal(highlight.color, 'green');
    assert.equal(highlight.page_no, 1);
    assert.equal(highlight.selected_text, selectedText);
    assert.ok(highlight.rects.length >= 2, 'Multi-line highlight must preserve all text rectangles');
    assert.equal(await current().getByLabel('向当前文献提问').inputValue(), '我的 AI 草稿不应被选区覆盖');
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    aligned(await rect(highlight.id), highlight.rects[0]);
    const highlightedBox = await current().getByTestId(`annotation-rect-${highlight.id}-0`).boundingBox();
    const reselectY = highlightedBox.y + highlightedBox.height / 2;
    await main.mouse.move(highlightedBox.x + 2, reselectY);
    await main.mouse.down();
    await main.mouse.move(highlightedBox.x + highlightedBox.width - 2, reselectY, { steps: 8 });
    await main.mouse.up();
    assert.ok((await main.evaluate(() => window.getSelection()?.toString() || '')).trim().length > 5, 'Highlighted text must remain selectable with the mouse');
    await current().getByTestId('reader-selection-toolbar').waitFor();
    for (let count = 0; count < 5; count++) await current().getByLabel('放大 PDF').click();
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 780));
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await delay(300);
    for (let count = 0; count < 5; count++) await current().getByLabel('缩小 PDF').click();

    await select(first.paper_id);
    await current().getByTestId('reader-selection-toolbar').getByRole('button', { name: '批注', exact: true }).click();
    await current().getByLabel('批注内容', { exact: true }).fill('这里的样本数是 137，需要复核患者独立性。');
    await current().getByRole('button', { name: '保存批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 2, 'Comment must persist');
    const comment = (await marks(first.paper_id)).find(mark => mark.kind === 'comment');
    assert.ok(comment.comment.includes('患者独立性'));
    assert.equal(comment.color, 'yellow');
    const row = () => current().getByTestId(`reader-annotation-${comment.id}`);
    await row().getByRole('button', { name: '编辑批注', exact: true }).click();
    await current().getByLabel('批注内容', { exact: true }).fill('已核对：样本数为 137。');
    await current().getByRole('button', { name: '保存批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).find(mark => mark.id === comment.id)?.comment === '已核对：样本数为 137。', 'Edited comment must persist');
    await current().getByLabel('阅读笔记', { exact: true }).fill('第一篇笔记：137 个样本；改善 23.7%。\n<script>window.__notesXss = true</script>');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text.includes('23.7%'), 'First note must persist');
    assert.equal(await main.evaluate(() => window.__notesXss), undefined);
    await current().getByLabel('阅读笔记', { exact: true }).fill('第一篇笔记：137 个样本；改善 23.7%。\n需关注：实验条件与实际场景的差异。');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text.includes('实际场景'), 'Clean preview note must save');
    await main.screenshot({ path: path.join(output, 'notes-and-highlights.png') });

    await current().getByRole('button', { name: '中文 PDF', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor({ state: 'detached' });
    await row().getByRole('button', { name: '跳到此处', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    assert.equal(await current().locator('.mode-button.active').textContent(), '原文 PDF');
    aligned(await rect(highlight.id), highlight.rects[0]);
    // Virtualization destroys distant text layers, but saved marks return correctly.
    await current().getByLabel('当前页码').fill('12');
    await current().getByLabel('当前页码').press('Tab');
    await delay(500);
    await row().getByRole('button', { name: '跳到此处', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);

    await open(second.paper_id);
    await panel(second.paper_id).getByTestId('reader-side-tab-notes').click();
    assert.equal(await panel(second.paper_id).getByLabel('阅读笔记', { exact: true }).inputValue(), '');
    assert.equal((await marks(second.paper_id)).length, 0);
    const duplicateIds = await main.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    });
    assert.deepEqual(duplicateIds, [], 'Document tabs must not share DOM IDs or accessibility targets');
    await panel(second.paper_id).getByLabel('阅读笔记', { exact: true }).fill('第二篇独立笔记：249 个样本。');
    await panel(second.paper_id).getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(second.paper_id)).text.includes('249'), 'Second note must persist');
    await main.getByTestId(`paper-tab-${first.paper_id}`).click();
    assert.ok((await current().getByLabel('阅读笔记', { exact: true }).inputValue()).includes('137'));

    // A delayed old save must never erase edits made while it is in flight.
    await app.evaluate(({ ipcMain }, id) => {
      const handler = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__notesOriginalHandler = handler;
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', async (event, input) => {
        if (input.path === `/papers/${id}/notes` && input.method === 'PUT') await new Promise(resolve => setTimeout(resolve, 450));
        return handler(event, input);
      });
    }, first.paper_id);
    await current().getByLabel('阅读笔记', { exact: true }).fill('延迟保存的旧内容');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await current().getByLabel('阅读笔记', { exact: true }).fill('保存期间继续输入的新内容，不可被旧保存覆盖');
    await delay(600);
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '保存期间继续输入的新内容，不可被旧保存覆盖');
    await until(async () => (await note(first.paper_id)).text === '保存期间继续输入的新内容，不可被旧保存覆盖', 'Latest revision must eventually persist');
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', globalThis.__notesOriginalHandler);
    });

    // Deliberately block only this isolated document's note PUT in Electron.
    await app.evaluate(({ ipcMain }, id) => {
      const handler = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__notesOriginalHandler = handler;
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', (event, input) => {
        if (input.path === `/papers/${id}/notes` && input.method === 'PUT') throw new Error('测试保存失败：保留草稿');
        return handler(event, input);
      });
    }, first.paper_id);
    await current().getByLabel('阅读笔记', { exact: true }).fill('网络失败期间仍须保留的笔记草稿');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => /失败/.test(await current().getByTestId('reader-note-save-status').innerText()), 'Failed save must not claim success');
    await main.getByTestId(`close-tab-${first.paper_id}`).click();
    await open(first.paper_id);
    await current().getByTestId('reader-side-tab-notes').click();
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '网络失败期间仍须保留的笔记草稿');
    await app.close();
    app = await _electron.launch(options);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await current().getByTestId('reader-side-tab-notes').waitFor();
    await current().getByTestId('reader-side-tab-notes').click();
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '网络失败期间仍须保留的笔记草稿');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text === '网络失败期间仍须保留的笔记草稿', 'Recovered draft must save to DB');
    assert.equal((await marks(first.paper_id)).length, 2);
    assert.ok((await note(second.paper_id)).text.includes('249'));
    await main.screenshot({ path: path.join(output, 'restored-notes.png') });
    await row().getByRole('button', { name: '删除批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 1, 'Deleting comment must not delete highlight');
    await current().getByTestId(`reader-annotation-${highlight.id}`).getByRole('button', { name: '删除高亮', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 0, 'Highlight must be deletable');
    assert.equal(fixture.requests.length, 0, 'Notes, marks and edits must never invoke AI');
    await api('/settings', 'PUT', { base_url: fixture.apiUrl, protocol: 'custom_chat_completions', model: 'stream-fixture', api_key: 'review-only-notes-key' });
    await current().getByTestId('reader-side-tab-chat').click();
    await until(async () => (await current().getByTestId('reader-model-select').inputValue()) === 'stream-fixture', 'Chat must receive settings');
    fixture.state.pause = true;
    await current().getByLabel('向当前文献提问').fill('停止思考测试');
    await current().getByRole('button', { name: /发送/ }).click();
    await current().getByTestId('streaming-reasoning').getByText(/思考第一段/).waitFor();
    await current().getByTestId('reader-side-tab-notes').click();
    await delay(400);
    assert.equal(fixture.sessions.at(-1).closedEarly, false, 'Switching to notes must not cancel AI');
    await current().getByTestId('reader-side-tab-chat').click();
    await current().getByRole('button', { name: '停止生成', exact: true }).click();
    await until(() => fixture.sessions.at(-1).closedEarly, 'Stop must still work after returning from notes');
    for (const source of sources) assert.equal(digest(source.path), source.hash, 'Original PDF must remain unchanged');
    for (const pdf of libraryPdfs) assert.equal(digest(pdf.path), pdf.hash, 'Library original/Chinese/bilingual PDFs must remain unchanged');
    await main.evaluate(([firstId, secondId]) => {
      localStorage.setItem(`paper-workbench.note-draft.${firstId}`, '删除时清理此篇草稿');
      localStorage.setItem(`paper-workbench.note-draft.${secondId}`, '其他篇草稿不得清理');
    }, [first.paper_id, second.paper_id]);
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: '连续阅读验收文献' }).locator('summary').click();
    const confirmation = main.waitForEvent('dialog');
    const deletion = main.locator('.paper-card').filter({ hasText: '连续阅读验收文献' }).getByRole('button', { name: '删除', exact: true }).click();
    await (await confirmation).accept();
    await deletion;
    await main.getByTestId(`paper-tab-${first.paper_id}`).waitFor({ state: 'detached' });
    assert.equal(await main.evaluate(id => localStorage.getItem(`paper-workbench.note-draft.${id}`), first.paper_id), null);
    assert.equal(await main.evaluate(id => localStorage.getItem(`paper-workbench.note-draft.${id}`), second.paper_id), '其他篇草稿不得清理');
    assert.ok((await note(second.paper_id)).text.includes('249'));
    for (const source of sources) assert.equal(digest(source.path), source.hash);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(app.windows().length, 1);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', version: require(path.join(root, 'package.json')).version, seconds: (Date.now() - started) / 1000, first, second, highlight, comment, sourceHashes: sources, aiRequests: fixture.requests.length, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    await main?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleaned = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env, encoding: 'utf8' });
    if (cleaned.status !== 0) throw new Error('Isolated credential cleanup failed');
  }
})();
