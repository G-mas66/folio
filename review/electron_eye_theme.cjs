'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `electron-eye-theme-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });

const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: dataRoot,
  WORKBENCH_CREDENTIAL_ROOT: dataRoot,
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'),
  TEMP: temp,
  TMP: temp,
  PYTHONIOENCODING: 'utf-8',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;

const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', dataRoot], {
  cwd: root,
  env,
  encoding: 'utf8',
});
assert.equal(seed.status, 0, seed.stderr);
const paper = JSON.parse(seed.stdout.trim());
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceDigest = digest(paper.source);
const options = {
  cwd: root,
  env,
  timeout: 90000,
  executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  let app;
  let page;
  const errors = [];
  const report = { version: require('../package.json').version, checks: {} };
  const theme = mode => page.waitForFunction(value => document.documentElement.dataset.theme === value, mode);
  const comfort = mode => page.waitForFunction(value => document.documentElement.dataset.eyeComfort === value, mode);
  const canvasPixel = () => page.locator('canvas[data-page-number="1"]').evaluate(canvas => {
    const context = canvas.getContext('2d');
    const sample = [...context.getImageData(1, 1, 1, 1).data];
    const filters = [];
    for (let element = canvas; element; element = element.parentElement) filters.push(getComputedStyle(element).filter);
    return { sample, filters };
  });
  const stagePixel = async () => {
    const stage = page.locator('.pdf-page-stage').first();
    const geometry = await stage.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const canvas = element.querySelector('canvas').getBoundingClientRect();
      return { width: bounds.width, x: canvas.left - bounds.left + 1, y: canvas.top - bounds.top + 1 };
    });
    const screenshot = await stage.screenshot();
    return page.evaluate(async ({ encoded, geometry: sample }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const scale = image.naturalWidth / sample.width;
      const x = Math.min(image.naturalWidth - 1, Math.round(sample.x * scale));
      const y = Math.min(image.naturalHeight - 1, Math.round(sample.y * scale));
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return [...context.getImageData(x, y, 1, 1).data];
    }, { encoded: screenshot.toString('base64'), geometry });
  };
  const launch = async () => {
    app = await _electron.launch(options);
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('library-tab').waitFor();
    assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getVersion()), report.version);
  };

  try {
    await launch();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByTestId('settings-tab').click();
    await page.getByTestId('theme-select').selectOption('light');
    await theme('light');
    await page.getByTestId('library-tab').click();
    await page.locator('.paper-card').first().waitFor();
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas[data-page-number="1"]');
      const text = document.querySelector('.textLayer');
      return canvas?.width > 0 && canvas.height > 0 && text?.textContent.trim().length > 30;
    }, null, { timeout: 30000 });
    await comfort('off');

    const comfortButton = page.getByTestId('eye-comfort-toggle');
    assert.equal(await comfortButton.getAttribute('aria-pressed'), 'false');
    const transitions = await page.locator('.pdf-page-stage').first().evaluate(stage => ({
      overlay: getComputedStyle(stage, '::after').transitionDuration,
      pageChrome: getComputedStyle(document.body).transitionDuration,
    }));
    assert.equal(transitions.overlay, '0.4s');
    assert.ok(transitions.pageChrome.split(',').includes('0.4s'));
    report.checks.transitions = { ...transitions };
    const canvasOff = await canvasPixel();
    assert.ok(canvasOff.sample.slice(0, 3).every(value => value > 235), 'The PDF canvas must keep its original light pixels');
    assert.ok(canvasOff.filters.every(filter => filter === 'none'), 'The PDF must not be inverted or filtered');
    const stageOff = await stagePixel();

    await comfortButton.click();
    await comfort('on');
    await delay(160);
    report.checks.transitions.midpointOpacity = Number(await page.locator('.pdf-page-stage').first().evaluate(stage => getComputedStyle(stage, '::after').opacity));
    assert.ok(report.checks.transitions.midpointOpacity > 0 && report.checks.transitions.midpointOpacity < 1, 'The PDF tint must transition instead of switching instantly');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.pdf-page-stage'), '::after').opacity === '1');
    await delay(450);
    const canvasOn = await canvasPixel();
    const stageOn = await stagePixel();
    assert.deepEqual(canvasOn, canvasOff, 'Eye comfort must not alter PDF canvas pixels or apply a filter');
    assert.ok(Math.abs(stageOff[0] - stageOff[1]) <= 4 && Math.abs(stageOff[1] - stageOff[2]) <= 4, `The normal PDF stage sample should be neutral: ${stageOff}`);
    assert.ok(stageOn[0] > stageOn[1] && stageOn[1] > stageOn[2], `The eye-comfort stage sample should be warmer: ${stageOn}`);
    report.checks.pdfPixels = { canvasOff, canvasOn, stageOff, stageOn };

    report.checks.layers = await page.locator('.pdf-page-stage').first().evaluate(stage => ({
      overlay: getComputedStyle(stage, '::after').zIndex,
      text: getComputedStyle(stage.querySelector('.textLayer')).zIndex,
      annotations: getComputedStyle(stage.querySelector('.pdf-annotation-layer')).zIndex,
    }));
    assert.deepEqual(report.checks.layers, { overlay: '2', text: '1', annotations: '3' });

    const selectedTextLength = await page.evaluate(() => {
      const span = [...document.querySelectorAll('.textLayer span')].find(element => element.textContent.trim());
      if (!span) return 0;
      const range = document.createRange();
      range.selectNodeContents(span);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString().trim().length;
    });
    report.checks.selection = { selectedCharacters: selectedTextLength };
    assert.ok(selectedTextLength > 0, 'PDF text must remain selectable with the comfort overlay enabled');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    await page.emulateMedia({ reducedMotion: 'reduce' });
    report.checks.reducedMotion = await page.locator('.pdf-page-stage').first().evaluate(stage => ({
      overlay: getComputedStyle(stage, '::after').transitionDuration,
      pageChrome: getComputedStyle(document.body).transitionDuration,
    }));
    assert.equal(report.checks.reducedMotion.overlay, '0s');
    assert.ok(report.checks.reducedMotion.pageChrome.split(',').every(duration => duration === '0s'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.getByTestId('theme-toggle').click();
    await theme('dark');
    assert.equal(await comfortButton.getAttribute('aria-pressed'), 'true', 'Changing the color theme must not turn off eye comfort');
    assert.equal(await page.locator('html').getAttribute('data-eye-comfort'), 'on');
    await comfortButton.click();
    await comfort('off');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Changing eye comfort must not change the dark theme');
    await page.getByTestId('theme-toggle').click();
    await theme('light');
    assert.equal(await comfortButton.getAttribute('aria-pressed'), 'false', 'Changing the color theme must not turn on eye comfort');
    await comfortButton.click();
    await comfort('on');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Changing eye comfort must not change the light theme');
    await page.getByTestId('theme-toggle').click();
    await theme('dark');
    assert.equal(await comfortButton.getAttribute('aria-pressed'), 'true');

    await page.locator('.page-index').nth(5).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '6');
    report.checks.pageNumber = await page.locator('[aria-label="当前页码"]').inputValue();
    assert.equal(report.checks.pageNumber, '6', 'The page number must remain visible while changing themes');

    await app.close();
    await launch();
    await theme('dark');
    await comfort('on');
    assert.equal(await page.getByTestId('eye-comfort-toggle').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '6', null, { timeout: 15000 });
    report.checks.persistence = { theme: 'dark', eyeComfort: 'on', page: '6' };
    assert.equal(digest(paper.source), sourceDigest, 'The fixture PDF must remain unchanged');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', ...report, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output, checks: Object.keys(report.checks) }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.close().catch(() => undefined);
  }
})();
