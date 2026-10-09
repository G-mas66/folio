'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `thumbnail-canvas-${Date.now()}`);
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
  cwd: root, env, encoding: 'utf8',
});
assert.equal(seed.status, 0, seed.stderr);
const paper = JSON.parse(seed.stdout.trim());
const options = {
  cwd: root,
  env,
  timeout: 90000,
  executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
};

(async () => {
  let app;
  let page;
  const report = { paperId: paper.paper_id, output, checks: {} };
  try {
    app = await _electron.launch(options);
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.getByTestId('library-tab').waitFor();
    await page.waitForFunction(() => document.querySelector('.paper-card .paper-thumbnail.loaded canvas')?.width > 0, null, { timeout: 30000 });

    const canvas = page.locator('.paper-card .paper-thumbnail.loaded canvas').first();
    report.checks.canvas = await canvas.evaluate(element => {
      const host = element.parentElement;
      const context = element.getContext('2d');
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let topInk = 0;
      let middleColor = 0;
      let minInkY = element.height;
      let maxInkY = -1;
      for (let y = 0; y < element.height; y += 1) {
        for (let x = 0; x < element.width; x += 1) {
          const offset = (y * element.width + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const alpha = pixels[offset + 3];
          if (alpha && (red < 180 || green < 180 || blue < 180)) {
            minInkY = Math.min(minInkY, y);
            maxInkY = Math.max(maxInkY, y);
            if (y < element.height * 0.22 && red < 150 && green < 150 && blue < 150) topInk += 1;
          }
          if (alpha && y >= element.height * 0.35 && y < element.height * 0.58
            && Math.max(red, green, blue) - Math.min(red, green, blue) > 40) middleColor += 1;
        }
      }
      const canvasRect = element.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        backing: { width: element.width, height: element.height },
        inlineSize: { width: element.style.width, height: element.style.height },
        cssSize: { width: style.width, height: style.height, objectFit: style.objectFit },
        canvasRect: { width: canvasRect.width, height: canvasRect.height },
        host: { clientWidth: host.clientWidth, clientHeight: host.clientHeight, rectWidth: hostRect.width, rectHeight: hostRect.height },
        devicePixelRatio: window.devicePixelRatio,
        topInk,
        middleColor,
        inkBoundsY: { min: minInkY, max: maxInkY },
      };
    });
    const sample = report.checks.canvas;
    assert.ok(sample.backing.width > 0 && sample.backing.height > 0);
    assert.equal(sample.inlineSize.width, '', 'Canvas CSS size must come from its thumbnail box, not the larger PDF viewport.');
    assert.equal(sample.inlineSize.height, '', 'Canvas CSS size must come from its thumbnail box, not the larger PDF viewport.');
    assert.ok(sample.canvasRect.width <= sample.host.clientWidth + 1, 'Displayed canvas must fit the thumbnail width.');
    assert.ok(sample.canvasRect.height <= sample.host.clientHeight + 1, 'Displayed canvas must fit the thumbnail height.');
    assert.ok(Math.abs(sample.backing.width / sample.backing.height - 595.2756 / 841.8898) < 0.01, 'Backing canvas must preserve the full A4 page aspect ratio.');
    assert.ok(sample.topInk > 10, 'The PDF heading and text must be painted near the top of the backing canvas.');
    assert.ok(sample.middleColor > 100, 'The synthetic figures must be painted in the middle of the backing canvas.');

    await canvas.screenshot({ path: path.join(output, 'thumbnail.png') });
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = String(error.stack || error);
    fs.writeFileSync(path.join(output, 'failure.txt'), report.error);
    if (page) await page.locator('.paper-thumbnail canvas').first().screenshot({ path: path.join(output, 'thumbnail-failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    if (app) await app.close();
  }
  console.log(JSON.stringify(report));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
