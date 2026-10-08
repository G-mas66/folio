// Independent native check of colored folder navigation and isolated reader tabs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStreamFixture } = require('./fixture_stream_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `tabs-sidebar-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });
const seedEnv = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' };
const seed = (module, args = []) => {
  const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', module, dataRoot, ...args], { cwd: root, env: seedEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};
const first = seed('review.seed_reader_fixture', ['--mixed']);
const second = seed('review.seed_tabs_fixture');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = [first, second].map(paper => ({ path: paper.source, hash: hash(paper.source) }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error(message);
};

(async () => {
  const fixture = await createStreamFixture();
  const errors = [];
  const started = Date.now();
  let application;
  let main;
  const panel = id => main.getByTestId(`reader-tab-panel-${id}`);
  const tab = id => main.getByTestId(`paper-tab-${id}`);
  const request = (path, method, body) => main.evaluate(input => window.workbench.request(input), { path, method, body });
  const switchTo = async id => {
    await tab(id).click();
    await panel(id).getByLabel('当前页码').waitFor();
    assert.equal(await tab(id).getAttribute('aria-selected'), 'true');
  };
  const snapshot = id => panel(id).evaluate(element => ({
    page: element.querySelector('[aria-label="当前页码"]').value,
    zoom: element.querySelector('.zoom-controls span').textContent,
    mode: element.querySelector('.mode-button.active').textContent,
    model: element.querySelector('[data-testid="reader-model-select"]').value,
    draft: element.querySelector('[aria-label="向当前文献提问"]').value,
    scrollLeft: element.querySelector('[data-testid="pdf-scroll"]').scrollLeft,
    scrollTop: element.querySelector('[data-testid="pdf-scroll"]').scrollTop,
  }));
  try {
    const env = { ...seedEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WORKBENCH_DEV;
    const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };
    application = await _electron.launch(options);
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
    main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    await request('/settings', 'PUT', { base_url: fixture.apiUrl, protocol: 'custom_chat_completions', model: 'stream-fixture', api_key: 'review-only-tabs-key' });
    await request('/settings/models', 'PUT', { models: ['stream-fixture', 'fixture-B'] });
    const folders = [];
    for (const name of ['深度学习', '医学影像', '研究方法', '待精读', '综述', '参考资料']) {
      await main.getByRole('button', { name: '新建文件夹', exact: true }).click();
      await main.getByLabel('文件夹名称', { exact: true }).fill(name);
      await main.getByTestId('folder-save').click();
      await main.getByRole('button', { name, exact: true }).waitFor();
    }
    folders.push(...await request('/folders'));
    assert.equal(folders.length, 6);
    assert.equal(new Set(folders.map(folder => folder.color)).size, 6);
    await request(`/papers/${first.paper_id}/folder`, 'PATCH', { folder_id: folders[0].id });
    await request(`/papers/${second.paper_id}/folder`, 'PATCH', { folder_id: folders[1].id });
    await main.getByTestId('folder-nav-all').click();
    await until(async () => await main.locator('.paper-card').count() === 2, 'Both papers must appear in All');
    const sidebar = await main.getByTestId('library-sidebar').boundingBox();
    const list = await main.locator('.paper-list').boundingBox();
    assert.ok(sidebar && list && sidebar.x + sidebar.width <= list.x + 2, 'Folder classification belongs left of the document list');
    for (const folder of folders) {
      const marker = main.getByTestId(`folder-color-${folder.id}`);
      const actual = await marker.evaluate(element => getComputedStyle(element).backgroundColor);
      const hex = folder.color.slice(1);
      assert.equal(actual, `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`);
    }
    await main.screenshot({ path: path.join(output, 'colored-library.png') });
    await main.getByTestId(`folder-nav-${folders[0].id}`).click();
    await until(async () => await main.locator('.paper-card').count() === 1, 'Folder filter must work');
    await main.getByRole('button', { name: '重命名文件夹', exact: true }).click();
    await main.getByLabel('文件夹名称', { exact: true }).fill('深度学习与基础模型');
    await main.getByTestId('folder-save').click();
    await main.getByRole('button', { name: '深度学习与基础模型', exact: true }).waitFor();
    assert.equal((await request('/folders')).find(folder => folder.id === folders[0].id).color, folders[0].color);
    await application.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__tabPdfLoads = [];
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', (event, input) => {
        if (input.binary && input.path.includes('/pdf')) globalThis.__tabPdfLoads.push(input.path);
        return original(event, input);
      });
    });
    await main.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    await panel(first.paper_id).locator('canvas[data-page-number="1"]').waitFor();
    await panel(first.paper_id).getByTestId('reader-model-select').selectOption('fixture-B');
    await panel(first.paper_id).getByLabel('放大 PDF', { exact: true }).click();
    await panel(first.paper_id).getByLabel('放大 PDF', { exact: true }).click();
    await panel(first.paper_id).locator('.page-index').last().click();
    await main.waitForFunction(id => {
      const scope = document.querySelector(`[data-testid="reader-tab-panel-${id}"]`);
      const root = scope?.querySelector('[data-testid="pdf-scroll"]');
      const frame = scope?.querySelector('.pdf-page-frame[data-page-number="12"]');
      const canvas = scope?.querySelector('canvas[data-page-number="12"]');
      if (!root || !frame || !canvas?.width) return false;
      const page = frame.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      return page.top < viewport.bottom - 80 && page.bottom > viewport.top + 80;
    }, first.paper_id);
    await delay(700);
    await panel(first.paper_id).getByLabel('向当前文献提问').fill('第一篇独立草稿');
    const firstState = await snapshot(first.paper_id);
    assert.equal(firstState.page, '12');
    await main.getByTestId('library-tab').click();
    await main.getByTestId('folder-nav-all').click();
    await main.locator('.paper-card').filter({ hasText: 'quartz_beta_same_title.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    await panel(second.paper_id).locator('canvas[data-page-number="1"]').waitFor();
    await panel(second.paper_id).getByRole('button', { name: '原文 PDF', exact: true }).click();
    await main.waitForFunction(id => {
      const canvas = document.querySelector(`[data-testid="reader-tab-panel-${id}"] canvas[data-page-number="1"]`);
      return canvas?.width > 0 && canvas.width / canvas.height < 1;
    }, second.paper_id);
    await panel(second.paper_id).getByLabel('当前页码').fill('3');
    await panel(second.paper_id).getByLabel('向当前文献提问').fill('第二篇独立草稿');
    await delay(700);
    const secondState = await snapshot(second.paper_id);
    fs.writeFileSync(path.join(output, 'reading-states.json'), JSON.stringify({ firstState, secondState }, null, 2));
    assert.equal(secondState.page, '3');
    assert.equal(application.windows().length, 1);
    assert.equal(await main.locator('.app-tab-strip').getByRole('tab').count(), 3);
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: 'quartz_beta_same_title.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    assert.equal(await main.getByTestId(`paper-tab-${second.paper_id}`).count(), 1);
    assert.equal(application.windows().length, 1);
    const loadsBeforeSwitch = await application.evaluate(() => globalThis.__tabPdfLoads);
    for (let i = 0; i < 3; i++) {
      await switchTo(first.paper_id);
      await delay(500);
      const firstAfter = await snapshot(first.paper_id);
      for (const property of ['page', 'zoom', 'mode', 'model', 'draft']) assert.equal(firstAfter[property], firstState[property], `First paper lost ${property}`);
      assert.ok(Math.abs(firstAfter.scrollTop - firstState.scrollTop) < 4, 'Switch must retain the reading offset');
      await switchTo(second.paper_id);
      await delay(500);
      const secondAfter = await snapshot(second.paper_id);
      for (const property of ['page', 'zoom', 'mode', 'model', 'draft']) assert.equal(secondAfter[property], secondState[property], `Second paper lost ${property}`);
    }
    assert.deepEqual(await application.evaluate(() => globalThis.__tabPdfLoads), loadsBeforeSwitch, 'Tab switches must reuse loaded PDFs');
    await main.screenshot({ path: path.join(output, 'two-reading-tabs.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 760));
    await delay(900);
    const narrow = await main.evaluate(() => ({ viewport: window.innerWidth, outerWidth: document.documentElement.scrollWidth }));
    assert.ok(narrow.outerWidth <= narrow.viewport + 2, 'Tab strip and readers must not expand the window');
    assert.ok(await main.getByTestId('library-tab').isVisible());
    assert.ok(await main.getByRole('button', { name: '设置', exact: true }).isVisible());
    assert.equal(await panel(second.paper_id).getByLabel('当前页码').inputValue(), '3');
    await main.screenshot({ path: path.join(output, 'narrow-tabs.png') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await delay(600);
    fixture.state.pause = true;
    await switchTo(first.paper_id);
    await panel(first.paper_id).getByLabel('向当前文献提问').fill('标签甲独立生成');
    await panel(first.paper_id).getByRole('button', { name: /发送/ }).click();
    await panel(first.paper_id).getByTestId('streaming-reasoning').waitFor();
    const firstSession = fixture.sessions.length - 1;
    await switchTo(second.paper_id);
    await panel(second.paper_id).getByLabel('向当前文献提问').fill('标签乙关闭取消');
    await panel(second.paper_id).getByRole('button', { name: /发送/ }).click();
    await panel(second.paper_id).getByTestId('streaming-reasoning').waitFor();
    const secondSession = fixture.sessions.length - 1;
    assert.notEqual(firstSession, secondSession);
    assert.equal(fixture.sessions[firstSession].closedEarly, false, 'Switching tabs must keep the other stream alive');
    await main.getByTestId(`close-tab-${second.paper_id}`).click();
    await tab(second.paper_id).waitFor({ state: 'detached' });
    await until(() => fixture.sessions[secondSession].closedEarly, 'Closing a tab must cancel its upstream stream');
    assert.equal(fixture.sessions[firstSession].closedEarly, false, 'Closing paper B must not cancel paper A');
    assert.equal((await request(`/papers/${second.paper_id}`)).can_read, true, 'Closing is not deletion');
    await switchTo(first.paper_id);
    await panel(first.paper_id).getByRole('button', { name: '停止生成', exact: true }).click();
    await until(() => fixture.sessions[firstSession].closedEarly, 'Stop must cancel the first stream');
    fixture.state.pause = false;
    await main.getByTestId('library-tab').click();
    await main.getByTestId('folder-nav-all').click();
    await main.locator('.paper-card').filter({ hasText: 'quartz_beta_same_title.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    await panel(second.paper_id).getByLabel('向当前文献提问').waitFor();
    assert.equal(await panel(second.paper_id).getByLabel('当前页码').inputValue(), '3');
    const firstHistory = await request(`/papers/${first.paper_id}/chat`);
    const secondHistory = await request(`/papers/${second.paper_id}/chat`);
    assert.ok(firstHistory.some(message => message.content.includes('标签甲')) && !firstHistory.some(message => message.content.includes('标签乙')));
    assert.ok(secondHistory.some(message => message.content.includes('标签乙')) && !secondHistory.some(message => message.content.includes('标签甲')));
    assert.ok([...firstHistory, ...secondHistory].filter(message => message.role === 'assistant').every(message => message.status === 'cancelled'), 'Explicit stop/close must persist as cancelled, not a network error');
    const countBeforeRestart = fixture.requests.length;
    await application.close();
    application = await _electron.launch(options);
    main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await panel(second.paper_id).getByLabel('当前页码').waitFor();
    assert.equal(await tab(second.paper_id).getAttribute('aria-selected'), 'true');
    assert.equal(await main.locator('.app-tab-strip').getByRole('tab').count(), 3);
    assert.equal(await panel(second.paper_id).getByLabel('当前页码').inputValue(), '3');
    await switchTo(first.paper_id);
    await delay(600);
    assert.equal(await panel(first.paper_id).getByLabel('当前页码').inputValue(), '12');
    assert.equal(await panel(first.paper_id).getByTestId('reader-model-select').inputValue(), 'fixture-B');
    assert.deepEqual(await request(`/papers/${first.paper_id}/chat`), firstHistory);
    assert.deepEqual(await request(`/papers/${second.paper_id}/chat`), secondHistory);
    assert.equal(fixture.requests.length, countBeforeRestart);
    assert.deepEqual((await request('/folders')).map(folder => [folder.id, folder.color]), folders.map(folder => [folder.id, folder.color]));
    await main.evaluate(ids => {
      for (const id of ids) document.querySelector(`[data-testid="close-tab-${id}"]`).click();
    }, [first.paper_id, second.paper_id]);
    await until(async () => await main.locator('.app-tab-strip').getByRole('tab').count() === 1, 'Rapidly closing two tabs must not resurrect either tab');
    assert.ok((await request(`/papers/${first.paper_id}`)).can_read && (await request(`/papers/${second.paper_id}`)).can_read);
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: 'reader-source.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: 'quartz_beta_same_title.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    await tab(second.paper_id).waitFor();
    await switchTo(first.paper_id);
    // Simulate an externally deleted paper, then verify stale saved tabs are pruned at restart.
    await request(`/papers/${second.paper_id}`, 'DELETE');
    await application.close();
    application = await _electron.launch(options);
    main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await tab(first.paper_id).waitFor();
    assert.equal(await tab(second.paper_id).count(), 0);
    await main.getByTestId('library-tab').click();
    await main.getByTestId('folder-nav-all').click();
    await main.locator('.paper-card summary').click();
    const dialogPromise = main.waitForEvent('dialog');
    const deleting = main.locator('.paper-card').getByRole('button', { name: '删除', exact: true }).click();
    await (await dialogPromise).accept();
    await deleting;
    await tab(first.paper_id).waitFor({ state: 'detached' });
    assert.equal(await main.locator('.app-tab-strip').getByRole('tab').count(), 1);
    assert.equal(application.windows().length, 1);
    for (const source of sources) assert.equal(hash(source.path), source.hash);
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', version: require(path.join(root, 'package.json')).version, seconds: (Date.now() - started) / 1000, first, second, colors: folders.map(folder => folder.color), sidebar, list, firstState, secondState, pdfLoads: loadsBeforeSwitch, requests: fixture.requests.length, sessions: fixture.sessions, windows: 1, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(fixture.requests, null, 2));
    if (main && !main.isClosed()) {
      const states = await main.locator('.reader-tab-panel').evaluateAll(elements => elements.map(element => ({ id: element.dataset.paperId, hidden: element.hidden, page: element.querySelector('[aria-label="当前页码"]')?.value, scrollTop: element.querySelector('[data-testid="pdf-scroll"]')?.scrollTop, height: element.querySelector('[data-testid="pdf-scroll"]')?.scrollHeight, clientHeight: element.querySelector('[data-testid="pdf-scroll"]')?.clientHeight })));
      fs.writeFileSync(path.join(output, 'failure-states.json'), JSON.stringify(states, null, 2));
    }
    await main?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (application) await application.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleaned = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env: seedEnv, encoding: 'utf8' });
    if (cleaned.status !== 0) throw new Error('Isolated test credential cleanup failed');
  }
})();
