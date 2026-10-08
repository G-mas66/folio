'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `theme-updates-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_CREDENTIAL_ROOT: dataRoot, WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', dataRoot], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const paper = JSON.parse(seed.stdout.trim());
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = digest(paper.source);
const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };

(async () => {
  let app, page;
  const errors = [];
  const report = { version: require('../package.json').version, checks: {} };
  const theme = mode => page.waitForFunction(value => document.documentElement.dataset.theme === value, mode);
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  const frame = async mode => {
    const window = await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
      return { handle: window.getNativeWindowHandle().readBigUInt64LE().toString(), title: window.getTitle(), menu: window.isMenuBarVisible(), source: nativeTheme.themeSource };
    });
    assert.equal(window.title, 'Folio');
    assert.equal(window.menu, false);
    assert.equal(window.source, mode);
    const capture = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'review/capture_window_frame.ps1'), '-WindowHandle', window.handle, '-OutputPath', path.join(output, `frame-${mode}.png`)], { cwd: root, encoding: 'utf8' });
    assert.equal(capture.status, 0, capture.stderr);
    const native = JSON.parse(capture.stdout.trim());
    assert.equal(native.hresult, 0);
    assert.equal(native.darkMode, mode === 'dark' ? 1 : 0);
    return { ...window, ...native };
  };
  const launch = async () => {
    app = await _electron.launch(options);
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('library-tab').waitFor();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), report.version);
  };
  try {
    await launch();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByTestId('theme-select').selectOption('light');
    await theme('light');
    report.checks.nativeLight = await frame('light');
    await screenshot('settings-light');
    await page.getByTestId('library-tab').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-card canvas')].some(canvas => canvas.width > 0));
    report.checks.brand = await page.locator('.brand-wordmark').evaluate(async element => {
      await document.fonts.ready;
      const style = getComputedStyle(element);
      return { text: element.textContent, font: style.fontFamily, weight: style.fontWeight, loaded: [...document.fonts].some(face => face.family.includes('Lora') && face.status === 'loaded') };
    });
    assert.equal(report.checks.brand.text.trim(), 'Folio');
    assert.ok(report.checks.brand.font.includes('Lora'));
    assert.equal(report.checks.brand.weight, '500');
    assert.equal(report.checks.brand.loaded, true);
    assert.equal(await page.locator('.brand-mark img').getAttribute('src'), './folio-mark.svg');
    report.checks.library = await page.locator('.paper-card').first().evaluate(element => ({ titleSize: parseFloat(getComputedStyle(element.querySelector('h2,h3')).fontSize), text: element.textContent }));
    assert.ok(report.checks.library.titleSize >= 16);
    assert.ok(report.checks.library.text.includes('12'));
    await screenshot('library-light');
    await page.getByTestId('theme-toggle').click();
    await theme('dark');
    report.checks.nativeDark = await frame('dark');
    await screenshot('library-dark');
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas[data-page-number="1"]')?.width > 0 && document.querySelector('.textLayer')?.textContent.length > 30);
    const pdf = () => page.locator('canvas[data-page-number="1"]').first().evaluate(canvas => {
      const context = canvas.getContext('2d');
      const sample = [...context.getImageData(1, 1, 1, 1).data];
      const filters = [];
      for (let element = canvas; element; element = element.parentElement) filters.push(getComputedStyle(element).filter);
      return { sample, filters };
    });
    report.checks.pdfDark = await pdf();
    assert.ok(report.checks.pdfDark.filters.every(filter => filter === 'none'));
    assert.ok(report.checks.pdfDark.sample.slice(0, 3).every(value => value > 235));
    await screenshot('reader-dark');
    await page.getByTestId('theme-toggle').click();
    await theme('light');
    assert.deepEqual(await pdf(), report.checks.pdfDark);
    await screenshot('reader-light');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByTestId('theme-select').selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await theme('dark');
    await screenshot('settings-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await theme('light');
    await page.getByTestId('theme-select').selectOption('dark');
    await theme('dark');
    await app.close();
    await launch();
    await theme('dark');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.getByTestId('theme-select').inputValue(), 'dark');
    report.checks.themeSwitchSystemPersistence = true;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 760));
    report.checks.viewport = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(report.checks.viewport.scroll <= report.checks.viewport.width + 2);
    assert.equal(digest(paper.source), original);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', ...report, errors }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    if (page) await screenshot('failure').catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.close();
  }
})();
