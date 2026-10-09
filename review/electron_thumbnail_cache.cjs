'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.REVIEW_EXECUTABLE && path.resolve(process.env.REVIEW_EXECUTABLE);
assert.ok(executablePath && fs.existsSync(executablePath), 'REVIEW_EXECUTABLE must point to the isolated Windows candidate executable.');
const output = path.join(root, '.review', `thumbnail-cache-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
const profile = path.join(output, 'profile');
const appData = path.join(profile, 'appdata');
const localAppData = path.join(profile, 'localappdata');
const userProfile = path.join(profile, 'user');
for (const directory of [temp, appData, localAppData, userProfile]) fs.mkdirSync(directory, { recursive: true });

const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: userProfile,
  WORKBENCH_DATA_DIR: dataRoot,
  WORKBENCH_CREDENTIAL_ROOT: dataRoot,
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'),
  TEMP: temp,
  TMP: temp,
  PYTHONIOENCODING: 'utf-8',
};

const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', dataRoot], {
  cwd: root, env, encoding: 'utf8',
});
assert.equal(seed.status, 0, seed.stderr);
const paper = JSON.parse(seed.stdout.trim());

(async () => {
  let app;
  let page;
  const report = { paperId: paper.paper_id, output, checks: {} };
  const pageErrors = [];
  try {
    app = await _electron.launch({
      cwd: root,
      env,
      timeout: 90000,
      executablePath,
      args: [],
    });
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await page.getByTestId('library-tab').waitFor({ timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('.paper-card .paper-thumbnail.loaded canvas')?.width > 0, null, { timeout: 30000 });

    const originalCover = await page.locator('.paper-card .paper-thumbnail canvas').first().evaluate(canvas => canvas.toDataURL('image/png'));
    await app.evaluate((electron, paperId) => {
      const originalFetch = globalThis.fetch;
      globalThis.__reviewThumbnailPdfRequests = 0;
      globalThis.fetch = function (...args) {
        if (String(args[0]).includes(`/papers/${paperId}/pdf?kind=original`)) globalThis.__reviewThumbnailPdfRequests += 1;
        return originalFetch.apply(this, args);
      };
    }, paper.paper_id);
    const requestsBeforeSwitch = await app.evaluate(() => globalThis.__reviewThumbnailPdfRequests);

    const folder = await page.evaluate(() => window.workbench.request({
      path: '/folders', method: 'POST', body: { name: '封面缓存验收' },
    }));
    await page.evaluate(({ paperId, folderId }) => window.workbench.request({
      path: `/papers/${paperId}/folder`, method: 'PATCH', body: { folder_id: folderId },
    }), { paperId: paper.paper_id, folderId: folder.id });
    await page.getByRole('button', { name: /^未分类/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 0);
    await page.evaluate(() => {
      window.__reviewThumbnailLoadingPlaceholderSeen = false;
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const hosts = node.matches('.paper-thumbnail') ? [node] : Array.from(node.querySelectorAll('.paper-thumbnail'));
          if (hosts.some(host => host.querySelector('span')?.textContent === '载入首页')) window.__reviewThumbnailLoadingPlaceholderSeen = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.__reviewThumbnailObserver = observer;
    });
    await page.getByRole('button', { name: /^封面缓存验收/ }).waitFor();
    await page.getByRole('button', { name: /^封面缓存验收/ }).click();
    await page.waitForFunction(() => {
      const host = document.querySelector('.paper-card .paper-thumbnail');
      const image = host?.querySelector('img');
      return image?.complete && image.naturalWidth > 0 && !host.querySelector('span');
    }, null, { timeout: 10000 });

    const restoredCover = await page.locator('.paper-card .paper-thumbnail img').first().getAttribute('src');
    assert.equal(restoredCover, originalCover, 'Switching away and back must restore the same cover without a loading placeholder.');
    const loadingPlaceholderSeen = await page.evaluate(() => {
      window.__reviewThumbnailObserver.disconnect();
      return window.__reviewThumbnailLoadingPlaceholderSeen;
    });
    assert.equal(loadingPlaceholderSeen, false, 'A remounted thumbnail must not show the loading placeholder.');
    const requestsAfterSwitch = await app.evaluate(() => globalThis.__reviewThumbnailPdfRequests);
    assert.equal(requestsAfterSwitch, requestsBeforeSwitch, 'A cached cover must not fetch the original PDF again.');
    report.checks.folderSwitchRestoredSameCover = true;
    report.checks.noLoadingPlaceholder = true;
    report.checks.noPdfRefetch = true;
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = String(error.stack || error);
    report.pageErrors = pageErrors;
    if (page) report.pageState = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body?.innerText || '' })).catch(() => null);
    fs.writeFileSync(path.join(output, 'failure.txt'), report.error);
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
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
