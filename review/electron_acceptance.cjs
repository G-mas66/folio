// Run against the real Electron UI with an isolated test-only API and data root.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createFixture } = require('./fixture_api.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `desktop-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temporary = path.join(output, 'temp');
const fixtures = path.join(root, '.review', 'fixtures');
const sourceNames = ['quartz_alpha.pdf', 'quartz_beta_same_title.pdf', 'mixed_text_and_unextractable.pdf'];
const sourcePaths = sourceNames.map(name => path.join(fixtures, name));
const sourceHashes = new Map(sourcePaths.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const dragPath = path.join(fixtures, 'two_columns.pdf');
sourceHashes.set(dragPath, crypto.createHash('sha256').update(fs.readFileSync(dragPath)).digest('hex'));
fs.mkdirSync(temporary, { recursive: true });

async function waitForPapers(page, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const papers = await page.evaluate(() => window.workbench.request({ path: '/papers' }));
    if (predicate(papers)) return papers;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Background document processing did not reach the expected state');
}

(async () => {
  const fixture = await createFixture();
  const errors = [];
  const consoleMessages = [];
  let application;
  try {
    const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_DEV: '0', WORKBENCH_FREE_API_URL: fixture.freeUrl, TEMP: temporary, TMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : [root], cwd: root, env,
      artifactsDir: path.join(output, 'playwright'), timeout: 60000,
    });
    const main = await application.firstWindow();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), '0.2.0');
    main.on('pageerror', error => errors.push(error.message));
    await main.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
    await main.getByRole('button', { name: 'AI 设置', exact: true }).click();
    await main.getByLabel('AI API URL', { exact: true }).fill(fixture.apiUrl);
    await main.getByLabel('模型名称', { exact: true }).fill('review-fixture');
    await main.getByLabel('AI API Key', { exact: true }).fill('review-only-not-a-real-key');
    await main.getByRole('button', { name: /测试连接/ }).click();
    await main.getByText(/连接成功/).waitFor({ timeout: 15000 });
    assert.equal(await main.getByLabel('AI API Key', { exact: true }).inputValue(), '');
    assert.equal(fixture.requests[0].model, 'review-fixture');
    assert.equal(fixture.requests[0].path, fixture.requestPath);
    assert.equal(await main.getByLabel('AI API URL', { exact: true }).inputValue(), fixture.apiUrl);
    const trailingSlashUrl = fixture.apiUrl.split('?')[0];
    await main.evaluate(address => window.workbench.request({ path: '/settings', method: 'PUT', body: { base_url: address, model: 'review-fixture', api_key: '' } }), trailingSlashUrl);
    assert.equal((await main.evaluate(() => window.workbench.request({ path: '/settings' }))).base_url, trailingSlashUrl, 'Saving settings must preserve the exact trailing slash');
    await main.evaluate(address => window.workbench.request({ path: '/settings', method: 'PUT', body: { base_url: address, model: 'review-fixture', api_key: '' } }), fixture.apiUrl);
    await main.getByRole('button', { name: '文献库', exact: true }).click();
    await application.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, sourcePaths);
    await main.getByRole('button', { name: /导入 PDF/ }).click();
    const papers = await waitForPapers(main, papers =>
      ['quartz_alpha.pdf', 'quartz_beta_same_title.pdf'].every(name =>
        papers.some(paper => paper.source_name === name && paper.can_read)));
    const alpha = papers.find(paper => paper.source_name === 'quartz_alpha.pdf');
    const beta = papers.find(paper => paper.source_name === 'quartz_beta_same_title.pdf');
    const blocked = papers.find(paper => paper.source_name === 'mixed_text_and_unextractable.pdf');
    assert.equal(alpha.segment_done, alpha.segment_total);
    assert.equal(beta.segment_done, beta.segment_total);
    assert.notEqual(alpha.file_name, beta.file_name);
    assert.equal(blocked.can_read, false);
    assert.equal(blocked.status, 'needs_attention');
    await main.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'review-drop-file'; document.body.appendChild(input);
    });
    await main.locator('#review-drop-file').setInputFiles(dragPath);
    await main.evaluate(() => {
      const input = document.getElementById('review-drop-file');
      const transfer = new DataTransfer();
      for (const file of input.files) transfer.items.add(file);
      document.querySelector('.library-page').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      input.remove();
    });
    await waitForPapers(main, papers =>
      papers.some(paper => paper.source_name === 'two_columns.pdf' && paper.can_read), 30000);
    const translationCalls = fixture.requests.length;
    const freeTranslationCalls = fixture.freeRequests.length;
    assert.ok(freeTranslationCalls > 3, 'Title and whole-paper translations must use the free service');
    await main.screenshot({ path: path.join(output, 'main-window.png') });

    const firstWindow = application.waitForEvent('window');
    await main.locator('.paper-card').filter({ hasText: 'quartz_alpha.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    const reader = await firstWindow;
    reader.on('pageerror', error => errors.push(error.message));
    reader.on('console', message => consoleMessages.push(message.text()));
    await reader.getByLabel('向当前文献提问').waitFor();
    assert.equal(await reader.getByLabel('当前页码').inputValue(), '1');
    await reader.getByRole('button', { name: '下一页', exact: true }).click();
    await reader.locator('.translation-page').getByText(/137/).waitFor();
    assert.equal(fixture.requests.length, translationCalls, 'Opening and paging must not trigger translation');
    assert.equal(fixture.freeRequests.length, freeTranslationCalls, 'Reading must use saved free translations');
    await reader.getByRole('button', { name: '原文 PDF', exact: true }).click();
    await reader.locator('.textLayer').getByText(/QUARTZ_METHOD_N=137/).waitFor({ timeout: 20000 });
    const marker = reader.locator('.textLayer').getByText('QUARTZ_METHOD_N=137', { exact: true });
    assert.ok(Math.abs(await marker.evaluate(element => parseFloat(getComputedStyle(element).fontSize)) - 11.5) < 0.1, 'PDF selectable text size must match canvas scale');
    assert.ok(await reader.locator('.pdf-page-stage > canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let offset = 0; offset < pixels.length; offset += 64) {
        if (pixels[offset + 3] > 0 && pixels[offset] < 200 && pixels[offset + 1] < 200 && pixels[offset + 2] < 200) return true;
      }
      return false;
    }), 'Rendered PDF canvas must contain actual page ink');
    await reader.getByRole('button', { name: '放大 PDF', exact: true }).click();
    await reader.waitForFunction(() => {
      const marker = [...document.querySelectorAll('.textLayer span')].find(element => element.textContent === 'QUARTZ_METHOD_N=137');
      return marker && Math.abs(parseFloat(getComputedStyle(marker).fontSize) - 13) < 0.1;
    });
    await marker.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await reader.waitForFunction(() => document.querySelector('textarea[aria-label="向当前文献提问"]').value.includes('QUARTZ_METHOD_N=137'));
    assert.ok((await reader.getByLabel('向当前文献提问').inputValue()).includes('QUARTZ_METHOD_N=137'));
    await reader.getByRole('button', { name: '下一页', exact: true }).click();
    await reader.getByRole('button', { name: '上一页', exact: true }).click();
    await reader.locator('.textLayer').getByText(/QUARTZ_METHOD_N=137/).waitFor({ timeout: 20000 });
    assert.equal(await reader.locator('.pdf-error').count(), 0);
    await reader.getByLabel('搜索英文原文').fill('QUARTZ_APPENDIX_SEED=811');
    await reader.getByRole('button', { name: '查找', exact: true }).click();
    await reader.locator('.textLayer').getByText(/QUARTZ_APPENDIX_SEED=811/).waitFor();
    assert.equal(await reader.getByLabel('当前页码').inputValue(), '4');
    assert.equal(fixture.requests.length, translationCalls, 'Local PDF search must not trigger API requests');
    await reader.getByLabel('当前页码').fill('2');
    await reader.locator('.textLayer').getByText(/QUARTZ_METHOD_N=137/).waitFor();
    await reader.getByLabel('向当前文献提问').fill('详细总结一下这篇文献，重点解释实验设计');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.locator('.chat-message.assistant').waitFor({ timeout: 30000 });
    const fullText = await reader.locator('.chat-message.assistant').innerText();
    assert.ok(fullText.includes('137') && fullText.includes('23.7') && fullText.includes('811'));
    await reader.locator('.chat-message.assistant').getByRole('button', { name: '第 2 页 ↗', exact: true }).first().click();
    assert.equal(await reader.getByLabel('当前页码').inputValue(), '2');
    await reader.locator('.textLayer').getByText(/QUARTZ_METHOD_N=137/).waitFor();
    await reader.screenshot({ path: path.join(output, 'reading-window.png') });

    const secondWindow = application.waitForEvent('window');
    await main.locator('.paper-card').filter({ hasText: 'quartz_beta_same_title.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    const second = await secondWindow;
    second.on('pageerror', error => errors.push(error.message));
    await second.getByLabel('向当前文献提问').waitFor();
    assert.equal(await second.locator('.chat-message').count(), 0);
    await second.getByLabel('向当前文献提问').fill('QUARTZ_METHOD_N');
    await second.getByRole('button', { name: /发送/ }).click();
    await second.locator('.chat-message.assistant').waitFor({ timeout: 30000 });
    const betaAnswer = await second.locator('.chat-message.assistant').innerText();
    assert.ok(betaAnswer.includes('249') && !betaAnswer.includes('137'));
    await second.close();
    assert.ok(!main.isClosed() && !reader.isClosed());
    await reader.close();
    const reopenedWindow = application.waitForEvent('window');
    await main.locator('.paper-card').filter({ hasText: 'quartz_alpha.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    const reopened = await reopenedWindow;
    await reopened.getByLabel('向当前文献提问').waitFor();
    assert.equal(await reopened.getByLabel('当前页码').inputValue(), '2');
    assert.equal(await reopened.locator('.chat-message.assistant').count(), 1);
    for (const [file, expectedHash] of sourceHashes) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expectedHash);
    }
    const persistedCalls = fixture.requests.length;
    await application.close();
    application = await _electron.launch({
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : [root], cwd: root, env,
      artifactsDir: path.join(output, 'restart'), timeout: 60000,
    });
    const restartedMain = await application.firstWindow();
    await restartedMain.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
    await waitForPapers(restartedMain, papers => papers.some(paper => paper.id === alpha.id && paper.can_read));
    const persistedWindow = application.waitForEvent('window');
    await restartedMain.locator('.paper-card').filter({ hasText: 'quartz_alpha.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    const persistedReader = await persistedWindow;
    await persistedReader.getByLabel('向当前文献提问').waitFor();
    assert.equal(await persistedReader.getByLabel('当前页码').inputValue(), '2');
    assert.equal(await persistedReader.locator('.chat-message.assistant').count(), 1);
    assert.equal(fixture.requests.length, persistedCalls, 'Saved reading and chat must survive a full application restart without AI requests');
    assert.equal(fixture.freeRequests.length, freeTranslationCalls, 'Completed free translations must survive restart without requests');
    assert.ok(!fs.readFileSync(path.join(dataRoot, 'workbench.sqlite')).includes(Buffer.from('review-only-not-a-real-key')));
    assert.deepEqual(errors, []);
    assert.ok(fixture.requests.every(request => request.model === 'review-fixture' && request.stream === false && request.path === fixture.requestPath));
    assert.ok(fixture.requests.every(request => !request.messages.some(message => message.content.includes('英译中译者'))), 'Paid AI must not be called for translation');
    assert.ok(fixture.freeRequests.every(request => request.path === fixture.freePath && request.authorization === null));
    fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(fixture.requests, null, 2));
    fs.writeFileSync(path.join(output, 'free-requests.json'), JSON.stringify(fixture.freeRequests, null, 2));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, papers: papers.length + 1, apiRequests: fixture.requests.length, freeRequests: freeTranslationCalls, configuredUrl: fixture.apiUrl, actualRequestPaths: [...new Set(fixture.requests.map(request => request.path))], errors }, null, 2));
    console.log(`ELECTRON_ACCEPTANCE_PASS ${output}`);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    fs.writeFileSync(path.join(output, 'console.json'), JSON.stringify({ errors, consoleMessages }, null, 2));
    if (application) for (const [index, page] of application.windows().entries()) {
      if (!page.isClosed()) {
        await page.screenshot({ path: path.join(output, `failure-window-${index}.png`) }).catch(() => {});
        fs.writeFileSync(path.join(output, `failure-window-${index}.txt`), await page.locator('body').innerText().catch(() => 'closed'));
      }
    }
    console.error(`ELECTRON_ACCEPTANCE_FAIL ${error.message}`);
    console.error(`ARTIFACTS ${output}`);
    process.exitCode = 1;
  } finally {
    if (application) await application.close();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleaned = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-c',
      'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'
    ], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot }, encoding: 'utf8' });
    if (cleaned.status !== 0) console.error('TEST_CREDENTIAL_CLEANUP_FAILED');
  }
})();
