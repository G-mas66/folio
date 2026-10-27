const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `local-ocr-${Date.now()}`);
const env = { ...process.env, WORKBENCH_DATA_DIR: path.join(output, 'data'), WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'data'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), WORKBENCH_NATIVE_REGISTRATION: '0', WORKBENCH_PLUGIN_PORT: '0',
  WORKBENCH_NATIVE_PIPE_NAME: `\\\\.\\pipe\\folio-ocr-review-${process.pid}`, WORKBENCH_NATIVE_SECRET_PATH: path.join(output, 'native.secret'),
  APPDATA: path.join(output, 'profile'), LOCALAPPDATA: path.join(output, 'local'), TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8' };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-m', 'review.seed_ocr_library', env.WORKBENCH_DATA_DIR], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const fixture = JSON.parse(seed.stdout);
const sourceHash = () => crypto.createHash('sha256').update(fs.readFileSync(fixture.source)).digest('hex');
const beforeHash = sourceHash();

(async () => {
  const application = await _electron.launch({ executablePath: process.env.FOLIO_REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: process.env.FOLIO_REVIEW_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 90000 });
  const errors = [];
  const states = [];
  let page;
  const screenshot = async name => {
    const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
  };
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    const call = (route, method = 'GET', body) => page.evaluate(input => window.workbench.request(input), { path: route, method, body });
    const library = async () => { await page.getByTestId('library-tab').click(); await page.getByTestId('folder-nav-all').click(); };
    const row = page.getByTestId(`paper-row-${fixture.id}`);
    const reader = page.getByTestId(`reader-tab-panel-${fixture.id}`);
    await row.waitFor();
    const initial = await call(`/papers/${fixture.id}`);
    assert.equal(initial.status, 'needs_attention');
    assert.equal(initial.can_read_original, true);
    assert.equal(initial.can_read, false);
    assert.deepEqual(initial.ocr_pages, []);
    assert.deepEqual(initial.diagnostics.map(item => item.page), [2]);
    const status = await call('/settings/ocr');
    assert.equal(status.available, true, JSON.stringify(status));
    assert.ok(status.languages.some(language => language.tag === 'en-US'), JSON.stringify(status));
    assert.ok(status.languages.some(language => language.tag === 'zh-Hans-CN'), JSON.stringify(status));
    await page.getByTestId('settings-tab').click();
    const card = page.locator('section[aria-labelledby="ocr-heading"]');
    const enabled = card.getByRole('checkbox', { name: '自动进行本地 OCR' });
    const language = card.getByLabel('识别语言');
    await card.getByText('Windows 本地 OCR 可用。', { exact: true }).waitFor();
    assert.equal(await enabled.isChecked(), false);
    await enabled.check();
    await language.selectOption('en-US');
    await card.getByRole('button', { name: '保存 OCR 设置' }).click();
    await card.getByText('本地 OCR 设置已保存。', { exact: true }).waitFor();
    await card.getByRole('button', { name: '刷新状态' }).click();
    await card.getByText('OCR 状态已刷新。', { exact: true }).waitFor();
    assert.equal(await enabled.isChecked(), true);
    assert.equal(await language.inputValue(), 'en-US');
    assert.equal((await call('/settings/ocr')).enabled, true);
    await screenshot('ocr-settings.png');
    await library();
    await row.click();
    const inspector = page.getByTestId('paper-inspector');
    await inspector.getByRole('button', { name: 'OCR 后翻译', exact: true }).waitFor();
    assert.equal(await inspector.getByTestId('detail-read').isDisabled(), false);
    await inspector.getByTestId('detail-read').click();
    await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
    assert.equal(await reader.locator('.mode-button.active').innerText(), '原文');
    assert.equal(await reader.getByRole('button', { name: '中文 PDF', exact: true }).isDisabled(), true);
    assert.equal(await reader.getByRole('button', { name: '双语对照', exact: true }).isDisabled(), true);
    await screenshot('original-before-ocr.png');
    await library();
    await row.click();
    await inspector.getByRole('button', { name: 'OCR 后翻译', exact: true }).click();
    await page.getByTestId(`paper-tab-${fixture.id}`).click();
    const deadline = Date.now() + 60000;
    let recognized;
    while (Date.now() < deadline) {
      const paper = await call(`/papers/${fixture.id}`);
      if (states.at(-1)?.status !== paper.status || states.at(-1)?.error !== paper.error) {
        states.push({ status: paper.status, error: paper.error, progress: paper.pdf_progress });
        console.log(JSON.stringify(states.at(-1)));
      }
      if (paper.ocr_pages.includes(2)) { recognized = paper; break; }
      assert.notEqual(paper.status, 'error', paper.error);
      assert.notEqual(paper.status, 'needs_ocr', paper.error);
      await page.waitForTimeout(1500);
    }
    assert.ok(recognized, `Real Windows OCR timed out: ${JSON.stringify(states)}`);
    assert.deepEqual(recognized.ocr_pages, [2]);
    assert.equal(recognized.can_read_original, true);
    assert.equal(await reader.locator('.mode-button.active').innerText(), '原文');
    await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
    await screenshot('original-after-ocr.png');
    const serviceChecks = await Promise.all(['api1', 'api2'].map(async host => {
      const url = `https://${host}.pdf2zh-next.com/chatproxy/check`;
      try {
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000) });
        return { url, status: response.status, body: (await response.text()).slice(0, 200) };
      } catch (error) { return { url, error: String(error) }; }
    }));
    let finalPaper = await call(`/papers/${fixture.id}`);
    const translationVerified = finalPaper.status === 'completed';
    let cancellationAndResumeVerified = false;
    if (translationVerified) {
      assert.equal(finalPaper.can_read, true);
      assert.ok(finalPaper.mono_pdf_file_name);
      assert.ok(finalPaper.dual_pdf_file_name);
      await page.waitForFunction(id => {
        const panel = document.querySelector(`[data-testid="reader-tab-panel-${id}"]`);
        return panel && [...panel.querySelectorAll('.mode-button')].every(button => !button.disabled);
      }, fixture.id, { timeout: 15000 });
      assert.equal(await reader.locator('.mode-button.active').innerText(), '原文');
      await screenshot('reader-after-translation.png');
      await reader.getByRole('button', { name: '中文 PDF', exact: true }).click();
      await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
      await screenshot('translated-after-ocr.png');
    } else {
      assert.equal(finalPaper.can_read, false);
      assert.equal(await reader.getByRole('button', { name: '中文 PDF', exact: true }).isDisabled(), true);
      assert.equal(await reader.getByRole('button', { name: '双语对照', exact: true }).isDisabled(), true);
      await library();
      await row.click();
      if (finalPaper.status === 'error') {
        await inspector.getByRole('button', { name: '重试翻译', exact: true }).click();
      }
      await inspector.getByRole('button', { name: '暂停翻译', exact: true }).click();
      await inspector.getByRole('button', { name: '继续翻译', exact: true }).waitFor();
      let paused = await call(`/papers/${fixture.id}`);
      assert.equal(paused.status, 'stopped');
      assert.deepEqual(paused.ocr_pages, [2]);
      await screenshot('ocr-paused-detail.png');
      await inspector.getByRole('button', { name: '继续翻译', exact: true }).click();
      await inspector.getByRole('button', { name: '暂停翻译', exact: true }).waitFor();
      const resumed = await call(`/papers/${fixture.id}`);
      assert.ok(['queued', 'translating'].includes(resumed.status), JSON.stringify(resumed));
      assert.deepEqual(resumed.ocr_pages, [2]);
      await inspector.getByRole('button', { name: '暂停翻译', exact: true }).click();
      await inspector.getByRole('button', { name: '继续翻译', exact: true }).waitFor();
      finalPaper = await call(`/papers/${fixture.id}`);
      assert.equal(finalPaper.status, 'stopped');
      assert.deepEqual(finalPaper.ocr_pages, [2]);
      cancellationAndResumeVerified = true;
      await inspector.getByTestId('detail-read').click();
      await reader.locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"]').waitFor();
      assert.equal(await reader.locator('.mode-button.active').innerText(), '原文');
      await screenshot('original-after-pause.png');
    }
    await library();
    await row.click();
    await inspector.getByText('已识别 OCR：第 2 页', { exact: true }).waitFor();
    await screenshot('ocr-recognized-detail.png');
    assert.equal(sourceHash(), beforeHash);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, actualElectron: true, actualBackend: true, actualWindowsOcr: true, actualFreeTranslation: translationVerified,
      translationNotVerified: translationVerified ? null : 'External free translation did not complete; local OCR and cancellation/resume verified independently.',
      cancellationAndResumeVerified, serviceChecks, installedLanguages: status.languages, paper: finalPaper, states, originalSourceHash: beforeHash, errors }, null, 2));
    console.log(output);
  } catch (error) {
    await screenshot('failure.png').catch(() => undefined);
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, states, errors }, null, 2));
    throw error;
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
