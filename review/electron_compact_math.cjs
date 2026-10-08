// Independent native acceptance for compact composer controls and real math DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStreamFixture } = require('./fixture_stream_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `compact-math-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });
const prepared = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', dataRoot, '--mixed'], {
  cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot, TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8',
});
assert.equal(prepared.status, 0, prepared.stderr);
const delay = time => new Promise(resolve => setTimeout(resolve, time));
const longModel = 'provider-model-with-a-long-name-for-testing-compact-layout-v2.6-pro';

function checkMathInstructions(messages) {
  const prompt = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  for (const marker of ['LaTeX', '$$', '\\sum', '\\frac', '下标', '上标']) assert.ok(prompt.includes(marker), `Missing math instruction ${marker}`);
  assert.ok(!prompt.includes('\f'));
}

(async () => {
  let application;
  const fixture = await createStreamFixture();
  const errors = [];
  const started = Date.now();
  try {
    const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WORKBENCH_DEV;
    const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };
    application = await _electron.launch(options);
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
    let main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByRole('button', { name: '设置', exact: true }).waitFor();
    await main.evaluate(address => window.workbench.request({ path: '/settings', method: 'PUT', body: { base_url: address, protocol: 'custom_chat_completions', model: 'stream-fixture', api_key: 'review-only-compact-math-key' } }), fixture.apiUrl);
    await main.evaluate(models => window.workbench.request({ path: '/settings/models', method: 'PUT', body: { models } }), ['stream-fixture', 'fixture-B', longModel]);
    await main.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    let reader = main;
    assert.equal(application.windows().length, 1, 'Reading must stay in the workbench');
    const model = () => reader.getByTestId('reader-model-select');
    const input = () => reader.getByLabel('向当前文献提问');
    const stop = () => reader.getByRole('button', { name: '停止生成', exact: true });
    await model().waitFor();
    await reader.waitForFunction(() => document.querySelector('[data-testid=reader-model-select]')?.value === 'stream-fixture');
    assert.equal(await reader.getByTestId('reader-model-input').count(), 0);
    assert.equal(await reader.getByTestId('reader-model-save').count(), 0);
    assert.ok(await model().evaluate(element => Boolean(element.closest('.chat-composer'))), 'Model control belongs beside Send inside the composer');
    const nameBox = await reader.getByTestId('reader-model-name').boundingBox();
    const arrowBox = await reader.getByTestId('reader-model-chevron').boundingBox();
    assert.ok(nameBox && arrowBox && arrowBox.x - (nameBox.x + nameBox.width) <= 12, 'The dropdown arrow must sit beside the visible model name');
    await reader.mouse.click(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
    await reader.keyboard.press('ArrowDown');
    await reader.keyboard.press('Enter');
    await reader.waitForFunction(() => document.querySelector('[data-testid=reader-model-select]')?.value === 'fixture-B');
    assert.equal(await reader.getByTestId('reader-model-name').textContent(), 'fixture-B');
    await input().fill('RBM排版验收：展示能量、概率与条件概率公式');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.getByTestId('streaming-answer').getByText(/合成公式/).waitFor();
    assert.ok(!fixture.sessions[0].completed, 'Math must arrive incrementally before the stream completes');
    await stop().waitFor({ state: 'hidden' });
    await reader.locator('.chat-message.assistant .katex').first().waitFor();
    const math = await reader.locator('.chat-message.assistant').first().evaluate(element => ({
      formulas: element.querySelectorAll('.katex').length,
      errors: element.querySelectorAll('.katex-error').length,
      subscripts: element.querySelectorAll('math msub, math msubsup').length,
      fractions: element.querySelectorAll('math mfrac').length,
      displays: element.querySelectorAll('.katex-display').length,
      code: element.querySelector('pre code')?.textContent,
    }));
    assert.equal(math.formulas, 5);
    assert.equal(math.errors, 0);
    assert.ok(math.subscripts >= 7 && math.fractions >= 1 && math.displays === 3, 'Subscripts, double sums, fractions and conditional probabilities need math layout');
    assert.ok(math.code.includes('W_{ij} 与 Σ_i'), 'Code must remain literal');
    assert.equal(fixture.requests[0].model, 'fixture-B');
    assert.equal(fixture.requests[0].path, fixture.requestPath);
    checkMathInstructions(fixture.requests[0].messages);
    const wideBox = await reader.getByTestId('chat-resizer').boundingBox();
    await reader.mouse.move(wideBox.x + 5, wideBox.y + wideBox.height / 2);
    await reader.mouse.down();
    await reader.mouse.move(wideBox.x - 280, wideBox.y + wideBox.height / 2, { steps: 8 });
    await reader.mouse.up();
    await delay(650);
    await reader.screenshot({ path: path.join(output, 'compact-math.png') });
    await reader.locator('.chat-panel').screenshot({ path: path.join(output, 'assistant.png') });
    const larger = await reader.getByTestId('chat-resizer').boundingBox();
    await reader.mouse.move(larger.x + 5, larger.y + larger.height / 2);
    await reader.mouse.down();
    await reader.mouse.move(larger.x + 1000, larger.y + larger.height / 2, { steps: 8 });
    await reader.mouse.up();
    await delay(650);
    await model().selectOption(longModel);
    await reader.waitForFunction(expected => document.querySelector('[data-testid=reader-model-select]')?.value === expected, longModel);
    const checkControls = async button => {
      const geometry = await reader.evaluate(() => {
        const panel = document.querySelector('.chat-panel').getBoundingClientRect();
        const messages = document.querySelector('.chat-messages').getBoundingClientRect();
        const select = document.querySelector('[data-testid=reader-model-select]').getBoundingClientRect();
        return { panel: { x: panel.x, right: panel.right, width: panel.width }, topHeight: messages.top - panel.top, model: { x: select.x, right: select.right, middle: select.y + select.height / 2 }, viewport: window.innerWidth, scroll: document.documentElement.scrollWidth };
      });
      const box = await button.boundingBox();
      assert.ok(geometry.topHeight <= 70, 'The old large header/model block must release space for the answer');
      assert.ok(box && geometry.model.x >= geometry.panel.x && box.x + box.width <= geometry.panel.right + 1);
      assert.ok(geometry.model.right <= box.x + 2 && Math.abs(geometry.model.middle - (box.y + box.height / 2)) <= 4, 'Model and Send/Stop must share one compact row');
      assert.ok(geometry.scroll <= geometry.viewport + 2);
      return geometry;
    };
    const narrow = await checkControls(reader.getByRole('button', { name: /发送/ }));
    assert.ok(narrow.panel.width <= 282);
    const overflowingMath = reader.locator('.chat-message.assistant .katex-display').first();
    const formulaScroll = await overflowingMath.evaluate(element => {
      const available = element.scrollWidth - element.clientWidth;
      element.scrollLeft = available;
      return { available, left: element.scrollLeft };
    });
    assert.ok(formulaScroll.available > 0 && formulaScroll.left > 0, 'Long display math needs its own horizontal scrolling in a narrow chat');
    await reader.screenshot({ path: path.join(output, 'narrow-composer.png') });
    await input().fill('详细总结一下这篇文献');
    await reader.getByRole('button', { name: /发送/ }).click();
    await stop().waitFor({ state: 'visible' });
    await stop().waitFor({ state: 'hidden' });
    assert.equal(fixture.requests.length, 3);
    for (const request of fixture.requests.slice(1)) {
      checkMathInstructions(request.messages);
      assert.equal(request.model, longModel);
    }
    assert.ok(fixture.requests[2].messages.some(message => message.content.includes('137 independent samples')));
    fixture.state.pause = true;
    await input().fill('停止按钮布局验收');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.getByTestId('streaming-reasoning').waitFor();
    await checkControls(stop());
    await stop().click();
    await stop().waitFor({ state: 'hidden' });
    await delay(250);
    assert.equal(fixture.sessions.at(-1).closedEarly, true);
    fixture.state.pause = false;
    const requestCount = fixture.requests.length;
    await application.close();
    application = await _electron.launch(options);
    main = await application.firstWindow();
    reader = main;
    reader.on('pageerror', error => errors.push(error.message));
    await reader.waitForFunction(expected => document.querySelector('[data-testid=reader-model-select]')?.value === expected, longModel);
    await reader.locator('.chat-message.assistant .katex').first().waitFor();
    assert.equal(await reader.locator('.chat-message.assistant .katex').count(), 5);
    assert.equal(fixture.requests.length, requestCount, 'Saved formulas and model must restore without another AI request');
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', version: require(path.join(root, 'package.json')).version, seconds: (Date.now() - started) / 1000, math, narrow, formulaScroll, requests: requestCount, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    if (application) {
      const windows = application.windows();
      await windows.at(-1)?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (application) await application.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleanup = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot }, encoding: 'utf8' });
    if (cleanup.status !== 0) throw new Error('Isolated credential cleanup failed');
  }
})();
