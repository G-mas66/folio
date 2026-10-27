const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `web-sources-${Date.now()}`);
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(output, 'data'), WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'data'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), WORKBENCH_NATIVE_REGISTRATION: '0', WORKBENCH_PLUGIN_PORT: '0',
  WORKBENCH_NATIVE_PIPE_NAME: `\\\\.\\pipe\\folio-web-sources-review-${process.pid}`, WORKBENCH_NATIVE_SECRET_PATH: path.join(output, 'native.secret'),
  APPDATA: path.join(output, 'profile'), LOCALAPPDATA: path.join(output, 'local'), TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8' };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-m', 'review.seed_web_sources', env.WORKBENCH_DATA_DIR], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const fixture = JSON.parse(seed.stdout);

(async () => {
  const application = await _electron.launch({ executablePath: process.env.FOLIO_REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.FOLIO_REVIEW_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 90000 });
  const errors = [];
  const screenshot = async name => {
    const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
  };
  try {
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    const history = session => page.evaluate(({ paper, session }) => window.workbench.request({ path: `/papers/${paper}/chat?session_id=${session}` }), { paper: fixture.paper_id, session });
    await page.getByTestId(`paper-row-${fixture.paper_id}`).dblclick();
    const reader = page.getByTestId(`reader-tab-panel-${fixture.paper_id}`);
    await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
    await reader.getByTestId('reader-side-tab-chat').click();
    await reader.getByTestId(`chat-session-${fixture.main_session}`).click();
    const main = reader.locator(`.chat-session-content[data-session-id="${fixture.main_session}"]`);
    const historical = main.locator('.chat-message.assistant').filter({ hasText: '历史回答仅引用论文' });
    const cited = main.locator('.chat-message.assistant').filter({ hasText: '引用网页回答' });
    await historical.waitFor();
    await cited.waitFor();
    assert.equal(await historical.locator('.web-source-list').count(), 0);
    assert.equal(await historical.locator('.citation-button').count(), 1);
    assert.match(await historical.locator('.citation-button').innerText(), /第 1 页/);
    assert.deepEqual(await cited.locator('.web-source-list button').allTextContents(), ['Gene2vec cited research page']);
    assert.equal(await cited.locator('.citation-button').count(), 2);
    assert.equal(await main.getByText(/DeepSeek unrelated|Credit card unrelated|Unused finance|Other session cited/).count(), 0);
    const mainHistory = await history(fixture.main_session);
    const oldAnswer = mainHistory.find(message => message.content.startsWith('历史回答仅引用论文'));
    const citedAnswer = mainHistory.find(message => message.content.startsWith('引用网页回答'));
    assert.deepEqual(oldAnswer.sources.map(source => source.id), ['S1']);
    assert.deepEqual(citedAnswer.sources.filter(source => source.kind === 'web').map(source => source.title), ['Gene2vec cited research page']);
    await screenshot('historical-citations-filtered.png');
    await reader.getByTestId(`chat-session-${fixture.other_session}`).click();
    const other = reader.locator(`.chat-session-content[data-session-id="${fixture.other_session}"]`);
    await other.getByText('独立会话只引用自己的网页。', { exact: false }).waitFor();
    assert.deepEqual(await other.locator('.web-source-list button').allTextContents(), ['Other session cited page']);
    assert.equal(await other.getByText(/Gene2vec cited|DeepSeek unrelated|Credit card unrelated|Unused finance/).count(), 0);
    assert.equal(await main.isVisible(), false);
    await screenshot('other-session-isolated.png');
    await reader.getByTestId(`chat-session-${fixture.main_session}`).click();
    await cited.waitFor();
    assert.deepEqual(await cited.locator('.web-source-list button').allTextContents(), ['Gene2vec cited research page']);
    assert.equal(await historical.locator('.web-source-list').count(), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, actualElectron: true, actualBackend: true,
      workflows: ['historical-uncited-web-hidden', 'only-exact-cited-web-shown', 'paper-citations-preserved', 'chat-session-isolation'], mainHistory, errors }, null, 2));
    console.log(output);
  } catch (error) {
    await screenshot('failure.png').catch(() => undefined);
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, errors }, null, 2));
    throw error;
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
