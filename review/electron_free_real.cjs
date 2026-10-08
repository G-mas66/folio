// Independent packaged-app check against the live free translation service.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `free-real-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temporary = path.join(output, 'temp');
const source = path.join(root, '.review', 'fixtures', 'quartz_alpha.pdf');
fs.mkdirSync(temporary, { recursive: true });
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

(async () => {
  let application;
  const started = Date.now();
  const errors = [];
  try {
    assert.ok(process.env.REVIEW_EXECUTABLE, 'Run this check against the packaged executable');
    const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, TEMP: temporary, TMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WORKBENCH_TRANSLATION_URL;
    delete env.WORKBENCH_FREE_TRANSLATION_URL;
    delete env.WORKBENCH_FREE_API_URL;
    application = await _electron.launch({ executablePath: env.REVIEW_EXECUTABLE, args: [], cwd: root, env, timeout: 60000 });
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), '0.2.0');
    const main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
    const settings = await main.evaluate(() => window.workbench.request({ path: '/settings' }));
    assert.equal(settings.base_url, '', 'The isolated app must have no AI endpoint');
    assert.equal(settings.key_configured, false, 'Free translation must work without an AI key');
    await application.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, source);
    await main.getByRole('button', { name: /导入 PDF/ }).click();
    let paper;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const papers = await main.evaluate(() => window.workbench.request({ path: '/papers' }));
      paper = papers.find(value => value.source_name === 'quartz_alpha.pdf');
      if (paper?.can_read) break;
      if (paper?.status === 'error') throw new Error(`Live translation failed: ${paper.error}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(paper?.can_read, 'All translated pages must be ready before reading');
    assert.equal(paper.segment_done, paper.segment_total);
    assert.match(paper.chinese_title, /[\u4e00-\u9fff]/);
    assert.equal(paper.api_tokens || 0, 0);
    const content = await main.evaluate(id => window.workbench.request({ path: `/papers/${id}/segments` }), paper.id);
    assert.equal(content.length, paper.segment_total);
    assert.ok(content.every(value => value.status === 'completed' && /[\u4e00-\u9fff]/.test(value.translation)));
    const translations = content.map(value => value.translation).join('\n');
    for (const fact of ['137', '23.7', '811']) assert.ok(translations.includes(fact), `Missing original fact: ${fact}`);
    for (let page = 1; page <= paper.page_count; page += 1) {
      assert.ok(content.some(value => value.start_page <= page && value.end_page >= page), `Missing page: ${page}`);
    }
    fs.writeFileSync(path.join(output, 'segments.json'), JSON.stringify(content, null, 2));
    await main.screenshot({ path: path.join(output, 'library.png') });
    const opened = application.waitForEvent('window');
    await main.locator('.paper-card').filter({ hasText: 'quartz_alpha.pdf' }).getByRole('button', { name: '阅读', exact: true }).click();
    const reader = await opened;
    reader.on('pageerror', error => errors.push(error.message));
    await reader.getByLabel('向当前文献提问').waitFor();
    await reader.getByRole('button', { name: '下一页', exact: true }).click();
    await reader.locator('.translation-page').getByText(/137/).waitFor({ timeout: 20000 });
    await reader.screenshot({ path: path.join(output, 'reader.png') });
    assert.equal(errors.length, 0);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash);
    await application.close();
    application = await _electron.launch({ executablePath: env.REVIEW_EXECUTABLE, args: [], cwd: root, env, timeout: 60000 });
    const restarted = await application.firstWindow();
    await restarted.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
    const persisted = await restarted.evaluate(id => window.workbench.request({ path: `/papers/${id}` }), paper.id);
    assert.equal(persisted.can_read, true);
    assert.equal(persisted.last_page, 2);
    assert.equal(persisted.file_name, paper.file_name);
    const persistedSegments = await restarted.evaluate(id => window.workbench.request({ path: `/papers/${id}/segments` }), paper.id);
    assert.deepEqual(persistedSegments, content);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', seconds: (Date.now() - started) / 1000, paper, persisted, errors, dataRoot }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output, seconds: (Date.now() - started) / 1000, title: paper.chinese_title, segmentTotal: paper.segment_total }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    throw error;
  } finally {
    if (application) await application.close();
  }
})();
