const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `compact-library-${Date.now()}`);
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(output, 'data'), WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'data'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), WORKBENCH_NATIVE_REGISTRATION: '0', WORKBENCH_PLUGIN_PORT: '0',
  WORKBENCH_NATIVE_PIPE_NAME: `\\.\pipe\folio-compact-review-${process.pid}`, WORKBENCH_NATIVE_SECRET_PATH: path.join(output, 'native.secret'),
  APPDATA: path.join(output, 'profile'), LOCALAPPDATA: path.join(output, 'local'), TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8' };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-m', 'review.seed_compact_library', env.WORKBENCH_DATA_DIR], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const [alpha, beta, failed] = JSON.parse(seed.stdout);

(async () => {
  const application = await _electron.launch({ executablePath: process.env.FOLIO_REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.FOLIO_REVIEW_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 90000 });
  const errors = [];
  try {
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    const call = (route, method = 'GET', body) => page.evaluate(input => window.workbench.request(input), { path: route, method, body });
    const row = paper => page.getByTestId(`paper-row-${paper.id}`);
    const inspector = page.getByTestId('paper-inspector');
    const library = async () => { await page.getByTestId('library-tab').click(); await page.getByTestId('folder-nav-all').click(); };
    const screenshot = async name => {
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
    };
    await row(alpha).waitFor();
    await call('/literature/capture', 'POST', { paper_id: alpha.id, csl: { title: 'Compact library fixture Alpha', type: 'article-journal',
      author: [{ family: 'Fixture', given: 'Ada' }], issued: { 'date-parts': [[2024]] }, 'container-title': 'Synthetic interface review' } });
    await page.getByTestId('settings-tab').click();
    await library();
    await row(alpha).click();
    await inspector.getByText('Ada Fixture', { exact: true }).waitFor();
    assert.match(await inspector.locator('h2').innerText(), /紧凑界面验收文献 Alpha/);
    assert.match(await inspector.locator('.paper-detail-english').innerText(), /Compact library fixture Alpha/);
    await page.waitForFunction(() => document.querySelector('.paper-inspector .paper-thumbnail.loaded'));
    assert.equal(await row(alpha).locator('.paper-thumbnail').count(), 0);
    const density = await row(alpha).evaluate(element => ({ rowHeight: element.getBoundingClientRect().height,
      fontSize: getComputedStyle(element.querySelector('.paper-row-title')).fontSize,
      headerHeight: document.querySelector('.topbar').getBoundingClientRect().height }));
    assert.equal(density.rowHeight, 32);
    assert.equal(density.fontSize, '12px');
    assert.equal(density.headerHeight, 44);
    await screenshot('library-light.png');
    const order = await page.locator('.compact-paper-list .paper-card').evaluateAll(rows => rows.map(element => element.dataset.paperId));
    await page.getByTestId(`paper-row-${order[0]}`).focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(id => document.querySelector(`[data-paper-id="${id}"]`)?.getAttribute('aria-selected') === 'true', order[1]);
    await row(beta).dblclick();
    await page.getByTestId(`reader-tab-panel-${beta.id}`).locator('canvas[data-page-number="1"]').waitFor();
    await library();
    await row(alpha).click();
    await inspector.getByRole('button', { name: '中文 PDF', exact: false }).first().click();
    const reader = page.getByTestId(`reader-tab-panel-${alpha.id}`);
    await reader.getByRole('button', { name: '中文 PDF', exact: true }).waitFor();
    assert.equal(await reader.locator('.mode-button.active').innerText(), '中文');
    await reader.getByRole('button', { name: '原文 PDF', exact: true }).click();
    await library();
    await inspector.getByRole('button', { name: '中文 PDF', exact: false }).first().click();
    await page.waitForFunction(id => document.querySelector(`[data-testid="reader-tab-panel-${id}"] .mode-button.active`)?.textContent === '中文', alpha.id);
    await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
    assert.equal(await reader.locator('.chat-composer textarea').evaluate(element => getComputedStyle(element).fontSize), '13px');
    await screenshot('reader-compact.png');
    await library();
    await inspector.getByTestId('detail-favorite').click();
    await page.getByTestId('folder-nav-favorites').click();
    await page.waitForFunction(() => document.querySelectorAll('.compact-paper-list .paper-card').length === 1);
    assert.equal((await call(`/papers/${alpha.id}`)).is_favorite, true);
    await library();
    await page.getByRole('textbox', { name: '搜索文献', exact: true }).fill('nonexistent-compact-fixture');
    await page.getByRole('heading', { name: '没有找到匹配的文献' }).waitFor();
    await page.getByRole('textbox', { name: '搜索文献', exact: true }).fill('');
    await row(failed).click();
    await inspector.getByRole('button', { name: '重试翻译' }).waitFor();
    assert.equal(await inspector.getByTestId('detail-read').isDisabled(), true);
    await row(alpha).click();
    await page.getByRole('button', { name: '关闭文献详情', exact: true }).click();
    await inspector.waitFor({ state: 'detached' });
    await page.getByTestId('library-detail-toggle').click();
    await inspector.waitFor();
    await page.getByTestId('theme-toggle').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.waitForTimeout(500);
    await screenshot('library-dark.png');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 740));
    const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      list: document.querySelector('.compact-paper-list').getBoundingClientRect().width }));
    assert.ok(overflow.document <= overflow.width, JSON.stringify(overflow));
    assert.ok(overflow.list > 400, JSON.stringify(overflow));
    await screenshot('library-small.png');
    await page.getByTestId('settings-tab').click();
    await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
    await screenshot('settings-compact.png');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, actualElectron: true, actualBackend: true, density, overflow,
      workflows: ['metadata-and-cover', 'keyboard-selection', 'double-click-reader', 'explicit-pdf-kind-reopen', 'favorite', 'search-empty', 'error-paper', 'collapse-details', 'dark-theme', 'compact-settings'], errors }, null, 2));
    console.log(output);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
