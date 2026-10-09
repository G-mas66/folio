const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `electron-resize-performance-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const credentialRoot = path.join(output, 'credentials');
const locationConfig = path.join(output, 'location.json');
const temp = path.join(output, 'temp');
const baseline = process.env.BASELINE === '1';
const expectedVersion = process.env.REVIEW_VERSION || require(path.join(root, 'package.json')).version;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

for (const directory of [output, dataRoot, credentialRoot, temp]) fs.mkdirSync(directory, { recursive: true });

const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const fixtureEnv = {
  ...process.env,
  WORKBENCH_DATA_DIR: dataRoot,
  WORKBENCH_CREDENTIAL_ROOT: credentialRoot,
  WORKBENCH_LOCATION_CONFIG: locationConfig,
  TEMP: temp,
  TMP: temp,
  PYTHONIOENCODING: 'utf-8',
};
const prepared = spawnSync(python, ['-B', '-m', 'review.seed_reader_fixture', dataRoot, '--mixed'], {
  cwd: root,
  env: fixtureEnv,
  encoding: 'utf8',
});
assert.equal(prepared.status, 0, prepared.stderr);
const seeded = JSON.parse(prepared.stdout.trim());

function metricsFor(raw, initialCanvases, finalCanvases) {
  const { startedAt, endedAt } = raw;
  const dragSamples = raw.samples.filter(sample => sample.time >= startedAt && sample.time <= endedAt);
  const frameIntervals = raw.frameIntervals
    .filter(frame => frame.start >= startedAt && frame.end <= endedAt)
    .map(frame => Math.round(frame.milliseconds * 100) / 100);
  const longTasks = raw.longTasks
    .filter(task => task.startTime >= startedAt && task.startTime < endedAt)
    .map(task => ({ startTime: Math.round(task.startTime * 100) / 100, duration: Math.round(task.duration * 100) / 100 }));
  const initialByPage = new Map(initialCanvases.map(canvas => [canvas.page, canvas]));
  const renderedPages = initialCanvases.filter(canvas => canvas.width > 0 && canvas.height > 0).map(canvas => canvas.page);
  const changedDuringDrag = [...new Set(dragSamples.flatMap(sample => sample.canvases
    .filter(canvas => {
      const initial = initialByPage.get(canvas.page);
      return initial && initial.width > 0 && initial.height > 0
        && (canvas.width !== initial.width || canvas.height !== initial.height);
    })
    .map(canvas => canvas.page)))];
  const finalByPage = new Map(finalCanvases.map(canvas => [canvas.page, canvas]));
  const changedAfterResize = renderedPages.filter(page => {
    const initial = initialByPage.get(page);
    const final = finalByPage.get(page);
    return final && (initial.width !== final.width || initial.height !== final.height);
  });
  return {
    sampleCount: dragSamples.length,
    renderedPages,
    changedDuringDrag,
    changedAfterResize,
    initialCanvases,
    finalCanvases,
    canvasSamples: dragSamples,
    frameIntervalsMs: frameIntervals,
    maxFrameIntervalMs: frameIntervals.length ? Math.max(...frameIntervals) : 0,
    longTasks,
  };
}

async function waitForStablePdfCanvases(reader, stableMilliseconds = 400, timeoutMilliseconds = 30000) {
  const started = Date.now();
  let previous = '';
  let stableSince = 0;
  while (Date.now() - started < timeoutMilliseconds) {
    const state = await reader.evaluate(() => {
      const scroll = document.querySelector('.pdf-scroll');
      const bounds = scroll.getBoundingClientRect();
      const margin = bounds.width * 1.8;
      const nearby = Array.from(document.querySelectorAll('.pdf-page-frame')).filter(frame => {
        const frameBounds = frame.getBoundingClientRect();
        return frameBounds.bottom > bounds.top - margin && frameBounds.top < bounds.bottom + margin;
      });
      return {
        canvases: nearby.map(frame => {
          const canvas = frame.querySelector('canvas[data-page-number]');
          return {
            page: Number(frame.dataset.pageNumber),
            width: canvas?.width || 0,
            height: canvas?.height || 0,
          };
        }),
      };
    });
    const ready = state.canvases.length > 0 && state.canvases.every(canvas => canvas.width > 0 && canvas.height > 0);
    const fingerprint = ready ? JSON.stringify(state.canvases) : '';
    if (ready && fingerprint === previous) {
      if (Date.now() - stableSince >= stableMilliseconds) return state.canvases;
    } else {
      previous = fingerprint;
      stableSince = Date.now();
    }
    await delay(80);
  }
  throw new Error('PDF canvases near the reading position did not reach stable backing sizes before the drag measurement');
}

(async () => {
  let application;
  let main;
  let reader;
  let mainBrowserWindowId;
  let focusEmulationDisabled = false;
  const errors = [];
  const started = Date.now();
  async function destroyBlurProbeAndFocusMain() {
    if (!application) return;
    await application.evaluate(({ BrowserWindow }, windowId) => {
      const probe = globalThis.__reviewBlurProbeWindow;
      if (probe && !probe.isDestroyed()) probe.destroy();
      delete globalThis.__reviewBlurProbeWindow;
      const mainWindow = BrowserWindow.getAllWindows().find(window => window.id === windowId);
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.focusOnWebView();
    }, mainBrowserWindowId).catch(() => undefined);
    if (main) await main.bringToFront().catch(() => undefined);
  }
  try {
    const env = { ...fixtureEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WORKBENCH_DEV;
    const options = {
      cwd: root,
      env,
      timeout: 90000,
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
    };
    application = await _electron.launch(options);
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), expectedVersion);
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(dataRoot, 'electron-userData'));
    main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.bringToFront();
    await main.getByRole('button', { name: '设置', exact: true }).waitFor();
    const appInfo = await main.evaluate(() => window.workbench.getAppInfo());
    assert.equal(appInfo.dataRoot, dataRoot);
    assert.equal(appInfo.credentialRoot, credentialRoot);
    assert.equal(appInfo.locationConfigPath, locationConfig);
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').first().waitFor();
    mainBrowserWindowId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null);
    assert.ok(Number.isInteger(mainBrowserWindowId), 'The main BrowserWindow must be available for focus testing');
    await main.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    reader = main;
    await reader.waitForFunction(() => document.querySelector('.pdf-page-frame[data-page-number="1"] canvas')?.width > 0, null, { timeout: 30000 });
    await reader.waitForFunction(() => document.querySelectorAll('.pdf-page-frame').length === 12);
    await reader.evaluate(() => document.addEventListener('pointerdown', event => {
      window.__reviewPointerId = event.pointerId;
    }, { capture: true }));

    const readCanvasSizes = () => reader.evaluate(() => Array.from(document.querySelectorAll('canvas[data-page-number]'), canvas => ({
      page: Number(canvas.dataset.pageNumber), width: canvas.width, height: canvas.height,
    })));
    const readLayout = () => reader.evaluate(() => {
      const width = selector => Math.round(document.querySelector(selector).getBoundingClientRect().width);
      return {
        outline: width('.reader-outline'),
        paper: width('.reading-column'),
        chat: width('.chat-column'),
        total: width('.reader-layout'),
        page: Number(document.querySelector('[aria-label="当前页码"]').value),
      };
    });
    const readAnchor = () => reader.evaluate(() => {
      const page = Number(document.querySelector('[aria-label="当前页码"]').value);
      const scroll = document.querySelector('.pdf-scroll');
      const frame = document.querySelector(`.pdf-page-frame[data-page-number="${page}"]`);
      return { page, offset: frame.getBoundingClientRect().top - scroll.getBoundingClientRect().top };
    });
    const readViewport = () => reader.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    const readSavedLayout = () => reader.evaluate(() => JSON.parse(localStorage.getItem('paper-workbench.reader-layout.v1')));
    async function setWindowWidth(width) {
      await application.evaluate(({ BrowserWindow }, target) => {
        const window = BrowserWindow.getAllWindows().find(candidate => candidate.id === target.id);
        window.setSize(target.width, window.getSize()[1]);
      }, { id: mainBrowserWindowId, width });
    }

    async function drag(testId, distance) {
      const box = await reader.getByTestId(testId).boundingBox();
      assert.ok(box, `Missing resizer ${testId}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await reader.mouse.move(x, y);
      await reader.mouse.down();
      for (let step = 1; step <= 12; step += 1) {
        await reader.mouse.move(x + distance * step / 12, y);
        await delay(16);
      }
      await reader.mouse.up();
      await delay(450);
    }

    async function beginDrag(testId, distance, steps = 6) {
      const box = await reader.getByTestId(testId).boundingBox();
      assert.ok(box, `Missing resizer ${testId}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await reader.mouse.move(x, y);
      await reader.mouse.down();
      await reader.mouse.move(x + distance, y, { steps });
    }

    await reader.locator('.page-index').nth(5).click();
    await reader.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '6', null, { timeout: 10000 });
    await reader.waitForFunction(() => {
      const scroll = document.querySelector('.pdf-scroll');
      const frame = document.querySelector('.pdf-page-frame[data-page-number="6"]');
      return scroll && frame && Math.abs(frame.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12) < 4;
    }, null, { timeout: 15000 });
    await reader.evaluate(() => {
      const scroll = document.querySelector('.pdf-scroll');
      scroll.scrollTop += 96;
    });
    await delay(250);
    await waitForStablePdfCanvases(reader);
    const anchorBefore = await readAnchor();
    assert.equal(anchorBefore.page, 6);
    const layoutBefore = await readLayout();
    const canvasesBefore = await readCanvasSizes();
    const pageCanvasBefore = canvasesBefore.find(canvas => canvas.page === anchorBefore.page);
    assert.ok(pageCanvasBefore?.width > 0 && pageCanvasBefore?.height > 0, 'The anchored PDF page must be rendered before measuring');

    await reader.evaluate(() => {
      const state = {
        running: false, startedAt: 0, endedAt: 0, lastFrame: null, raf: 0,
        samples: [], frameIntervals: [], longTasks: [], observer: null,
      };
      const canvasSizes = () => Array.from(document.querySelectorAll('canvas[data-page-number]'), canvas => ({
        page: Number(canvas.dataset.pageNumber), width: canvas.width, height: canvas.height,
      }));
      const sample = time => {
        if (!state.running) return;
        if (state.lastFrame !== null) state.frameIntervals.push({ start: state.lastFrame, end: time, milliseconds: time - state.lastFrame });
        state.lastFrame = time;
        state.samples.push({ time, canvases: canvasSizes() });
        state.raf = requestAnimationFrame(sample);
      };
      try {
        state.observer = new PerformanceObserver(entries => {
          for (const entry of entries.getEntries()) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        state.observer.observe({ type: 'longtask', buffered: true });
      } catch { /* Long-task timing is optional in older Chromium builds. */ }
      state.start = () => {
        state.startedAt = performance.now();
        state.running = true;
        state.raf = requestAnimationFrame(sample);
      };
      state.markEnd = () => { state.endedAt = performance.now(); };
      state.stop = () => {
        state.running = false;
        cancelAnimationFrame(state.raf);
        state.observer?.disconnect();
        return {
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          samples: state.samples,
          frameIntervals: state.frameIntervals,
          longTasks: state.longTasks,
        };
      };
      window.__reviewResizeProbe = state;
    });
    await reader.evaluate(() => {
      const probe = window.__reviewResizeProbe;
      let pointerId = null;
      const start = event => {
        if (event.button !== 0 || !(event.target instanceof Element)
          || !event.target.closest('[data-testid="chat-resizer"]')) return;
        pointerId = event.pointerId;
        probe.start();
        document.removeEventListener('pointerdown', start, true);
        document.addEventListener('pointerup', end, true);
        document.addEventListener('pointercancel', end, true);
      };
      const end = event => {
        if (event.pointerId !== pointerId) return;
        probe.markEnd();
        document.removeEventListener('pointerup', end, true);
        document.removeEventListener('pointercancel', end, true);
      };
      document.addEventListener('pointerdown', start, true);
    });

    const chatBox = await reader.getByTestId('chat-resizer').boundingBox();
    assert.ok(chatBox, 'Missing chat resizer');
    const chatX = chatBox.x + chatBox.width / 2;
    const chatY = chatBox.y + chatBox.height / 2;
    await reader.mouse.move(chatX, chatY);
    await reader.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await reader.mouse.move(chatX - 120 * step / 12, chatY);
      await delay(16);
    }
    await delay(100);
    await reader.mouse.up();
    await reader.waitForFunction(() => window.__reviewResizeProbe.endedAt > 0, null, { timeout: 5000 });
    await delay(600);
    const canvasesAfter = await readCanvasSizes();
    const rawProbe = await reader.evaluate(() => window.__reviewResizeProbe.stop());
    const resizeMetrics = metricsFor(rawProbe, canvasesBefore, canvasesAfter);
    const layoutAfterDrag = await readLayout();
    const anchorAfter = await readAnchor();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
      result: 'measured',
      version: expectedVersion,
      baseline,
      seconds: (Date.now() - started) / 1000,
      fixture: { paperId: seeded.paper_id, pages: seeded.pages },
      resize: resizeMetrics,
      layoutBefore,
      layoutAfterDrag,
      anchorBefore,
      anchorAfter,
    }, null, 2));
    assert.ok(resizeMetrics.sampleCount > 0, 'The drag performance probe must collect animation frames');
    if (!baseline) {
      assert.deepEqual(resizeMetrics.changedDuringDrag, [], `PDF canvas backing sizes changed while dragging: ${resizeMetrics.changedDuringDrag.join(', ')}`);
    }
    assert.ok(layoutAfterDrag.chat > layoutBefore.chat + 80, 'Dragging the chat separator must widen the assistant panel');
    assert.ok(layoutAfterDrag.paper < layoutBefore.paper - 80, 'Dragging the chat separator must resize the PDF viewport');
    assert.notEqual(canvasesAfter.find(canvas => canvas.page === anchorBefore.page)?.width, pageCanvasBefore.width, 'The PDF canvas must reflow after the drag is released');
    assert.equal(anchorAfter.page, anchorBefore.page, 'Resizing must keep the reading page');
    assert.ok(Math.abs(anchorAfter.offset - anchorBefore.offset) < 4, `Resizing must preserve the page offset (${anchorBefore.offset} -> ${anchorAfter.offset})`);

    const outlineBeforeKeyboard = await readLayout();
    await reader.getByTestId('outline-resizer').focus();
    await reader.keyboard.press('ArrowRight');
    await delay(450);
    const outlineAfterKeyboard = await readLayout();
    assert.ok(outlineAfterKeyboard.outline > outlineBeforeKeyboard.outline + 8, 'Arrow keys must resize the outline');
    assert.equal(outlineAfterKeyboard.page, anchorBefore.page, 'Keyboard resizing must keep the reading page');

    await drag('chat-resizer', -1200);
    const maximumLayout = await readLayout();
    assert.ok(maximumLayout.outline >= 140 && maximumLayout.paper >= 320 && maximumLayout.chat >= 280, 'Maximum-width dragging must preserve pane minimums');
    await drag('chat-resizer', 1200);
    const minimumLayout = await readLayout();
    assert.ok(minimumLayout.outline >= 140 && minimumLayout.paper >= 320 && minimumLayout.chat >= 280, 'Minimum-width dragging must preserve pane minimums');

    await beginDrag('chat-resizer', -48);
    const pointerId = await reader.evaluate(() => window.__reviewPointerId);
    assert.ok(Number.isInteger(pointerId), 'The active pointer id must be observable');
    await reader.getByTestId('chat-resizer').dispatchEvent('pointercancel', { pointerId });
    await reader.mouse.up();
    await delay(450);
    const cancelLayout = await readLayout();
    const cancelSaved = await readSavedLayout();
    assert.ok(cancelLayout.chat > minimumLayout.chat + 20, 'A cancelled drag must flush the last preview width');
    assert.ok(Math.abs(cancelSaved.chatWidth - cancelLayout.chat) <= 2, 'A cancelled drag must save the final layout');

    await application.evaluate(({ BrowserWindow }, windowId) => {
      BrowserWindow.getAllWindows().find(window => window.id === windowId).setMinimumSize(800, 700);
    }, mainBrowserWindowId);
    const rapidResizeStarted = Date.now();
    await setWindowWidth(1040);
    await delay(75);
    await setWindowWidth(920);
    const rapidResizeMilliseconds = Date.now() - rapidResizeStarted;
    assert.ok(rapidResizeMilliseconds < 320, `The two window resize requests must finish within 320ms (${rapidResizeMilliseconds}ms)`);
    await delay(600);
    const compactWindowLayout = await readLayout();
    const compactViewport = await readViewport();
    assert.ok(compactWindowLayout.outline >= 140 && compactWindowLayout.paper >= 320 && compactWindowLayout.chat >= 280, 'Rapid window resizing must preserve pane minimums');
    assert.ok(compactViewport.scroll <= compactViewport.width + 2, `The compact window must not overflow horizontally (${compactViewport.scroll} > ${compactViewport.width})`);

    await reader.evaluate(() => {
      window.__reviewResizeEventCount = 0;
      window.addEventListener('resize', () => { window.__reviewResizeEventCount += 1; }, { once: true });
    });
    const restoreAndDragStarted = Date.now();
    await setWindowWidth(1440);
    await reader.waitForFunction(() => window.__reviewResizeEventCount > 0, null, { timeout: 2000 });
    const compactChatWidth = compactWindowLayout.chat;
    await reader.evaluate(() => {
      const button = document.querySelectorAll('.page-index')[8];
      const scroll = document.querySelector('.pdf-scroll');
      if (!button || !scroll) throw new Error('The ninth PDF page must be available for the immediate resize test');
      button.click();
      const frame = document.querySelector('.pdf-page-frame[data-page-number="9"]');
      if (!frame) throw new Error('The ninth PDF page frame must be available for the immediate resize test');
      scroll.scrollTop += frame.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
    });
    await beginDrag('chat-resizer', -48, 1);
    await reader.mouse.up();
    const restoreAndDragMilliseconds = Date.now() - restoreAndDragStarted;
    assert.ok(restoreAndDragMilliseconds < 320, `Page navigation and the next drag must begin within 320ms of restoring the window (${restoreAndDragMilliseconds}ms)`);
    await delay(600);
    const postResizeDragLayout = await readLayout();
    const postResizeDragAnchor = await readAnchor();
    const postResizeDragViewport = await readViewport();
    assert.ok(postResizeDragLayout.chat > compactChatWidth + 20, 'A drag started immediately after navigation must resize the assistant panel');
    assert.ok(postResizeDragLayout.outline >= 140 && postResizeDragLayout.paper >= 320 && postResizeDragLayout.chat >= 280, 'Restoring the window and dragging must preserve pane minimums');
    assert.ok(postResizeDragViewport.scroll <= postResizeDragViewport.width + 2, 'Restoring the window must not create horizontal overflow');
    assert.equal(postResizeDragAnchor.page, 9, 'The drag after a window resize must keep the newly selected page');
    assert.ok(Math.abs(postResizeDragAnchor.offset - 12) < 4, `The drag after a window resize must preserve the new page offset (${postResizeDragAnchor.offset})`);

    let blurLayout = null;
    let blurResult;
    if (baseline) {
      blurResult = { skipped: true, reason: 'Baseline beta.1 predates window-blur drag cleanup' };
    } else {
      const readerImpl = reader._connection?.toImpl?.(reader);
      const focusClient = readerImpl?.delegate?._mainFrameSession?._client;
      assert.ok(focusClient?.send, 'The original Playwright CDP session must be available for focus setup');
      await focusClient.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      focusEmulationDisabled = true;
      await destroyBlurProbeAndFocusMain();
      await delay(100);
      const focusBeforeBlur = await application.evaluate(({ BrowserWindow }, windowId) => {
        const mainWindow = BrowserWindow.getAllWindows().find(window => window.id === windowId);
        return { window: mainWindow.isFocused(), webContents: mainWindow.webContents.isFocused() };
      }, mainBrowserWindowId);
      assert.equal(focusBeforeBlur.window, true, 'The main BrowserWindow must be focused before the webview blur check');
      assert.equal(focusBeforeBlur.webContents, true, 'The main webview must be focused before the blur check');
      await reader.evaluate(() => {
        window.__reviewBlurCount = 0;
        window.addEventListener('blur', () => { window.__reviewBlurCount += 1; }, { once: true });
      });
      const outlineBeforeBlur = await readLayout();
      await beginDrag('outline-resizer', 44);
      const focusAfterBlur = await application.evaluate(async ({ BrowserWindow }, windowId) => {
        const mainWindow = BrowserWindow.getAllWindows().find(window => window.id === windowId);
        const probe = new BrowserWindow({
          parent: mainWindow,
          show: false,
          width: 240,
          height: 120,
          title: 'Folio focus probe',
        });
        globalThis.__reviewBlurProbeWindow = probe;
        await probe.loadURL('about:blank');
        probe.show();
        probe.focus();
        probe.webContents.focus();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && mainWindow.isFocused()) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return {
          window: mainWindow.isFocused(),
          webContents: mainWindow.webContents.isFocused(),
          probeWindow: probe.isFocused(),
          probeWebContents: probe.webContents.isFocused(),
        };
      }, mainBrowserWindowId);
      assert.equal(focusAfterBlur.window, false, 'The probe BrowserWindow must take native window focus');
      assert.equal(focusAfterBlur.webContents, false, 'The main webview must lose focus when the probe window is focused');
      assert.equal(focusAfterBlur.probeWindow, true, 'The visible probe BrowserWindow must receive focus');
      assert.equal(focusAfterBlur.probeWebContents, true, 'The probe webview must receive focus');
      await reader.waitForFunction(() => window.__reviewBlurCount > 0 && !document.hasFocus(), null, { timeout: 5000 }).catch(async error => {
        const rendererFocus = await reader.evaluate(() => ({
          blurCount: window.__reviewBlurCount,
          documentHasFocus: document.hasFocus(),
          savedLayout: JSON.parse(localStorage.getItem('paper-workbench.reader-layout.v1') || 'null'),
        }));
        throw new Error(`${error.message}\nFocus diagnostics: ${JSON.stringify({ focusEmulationDisabled, focusAfterBlur, rendererFocus })}`);
      });
      await delay(450);
      blurLayout = await readLayout();
      const blurSaved = await readSavedLayout();
      focusAfterBlur.document = await reader.evaluate(() => document.hasFocus());
      assert.ok(blurLayout.outline > outlineBeforeBlur.outline + 24, 'Losing window focus must finish the active drag');
      assert.ok(Math.abs(blurSaved.outlineWidth - blurLayout.outline) <= 2, 'A drag ended by window blur must save the final layout');
      assert.equal(blurLayout.page, postResizeDragAnchor.page, 'Pointer cancellation and window blur must keep the current reading page');
      assert.equal(focusAfterBlur.document, false, 'The renderer document must report that it has lost focus');
      blurResult = {
        skipped: false,
        focusEmulationDisabled,
        rendererBlurEvents: await reader.evaluate(() => window.__reviewBlurCount),
        focusBeforeBlur,
        focusAfterBlur,
        outlineBefore: outlineBeforeBlur.outline,
        outlineAfter: blurLayout.outline,
        persistedOutlineWidth: blurSaved.outlineWidth,
      };
      await reader.mouse.up();
      await destroyBlurProbeAndFocusMain();
      await reader.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 });
      await delay(450);
    }

    await delay(500);
    const savedBeforeRestart = await readLayout();
    await application.close();
    application = await _electron.launch(options);
    main = await application.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.bringToFront();
    reader = main;
    await reader.getByTestId('toggle-chat').waitFor();
    await reader.waitForFunction(() => document.querySelector('[aria-label="当前页码"]')?.value === '9', null, { timeout: 15000 });
    const layoutAfterRestart = await readLayout();
    assert.ok(Math.abs(layoutAfterRestart.outline - savedBeforeRestart.outline) < 4, 'The outline width must persist after restart');
    assert.ok(Math.abs(layoutAfterRestart.chat - savedBeforeRestart.chat) < 4, 'The assistant width must persist after restart');
    assert.equal(layoutAfterRestart.page, postResizeDragAnchor.page, 'The last reading page must persist after restart');
    assert.equal(errors.length, 0, errors.join('\n'));

    const result = {
      result: 'passed',
      version: expectedVersion,
      baseline,
      seconds: (Date.now() - started) / 1000,
      fixture: { paperId: seeded.paper_id, pages: seeded.pages },
      resize: resizeMetrics,
      layoutBefore: layoutBefore,
      layoutAfterDrag,
      anchorBefore,
      anchorAfter,
      outlineAfterKeyboard,
      maximumLayout,
      minimumLayout,
      cancelLayout,
      rapidResizeMilliseconds,
      compactWindowLayout,
      compactViewport,
      restoreAndDragMilliseconds,
      postResizeDragLayout,
      postResizeDragAnchor,
      postResizeDragViewport,
      windowBlur: blurResult,
      blurLayout,
      savedBeforeRestart,
      layoutAfterRestart,
      errors,
    };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ result: 'passed', output, version: expectedVersion, baseline, resize: {
      sampleCount: resizeMetrics.sampleCount,
      changedDuringDrag: resizeMetrics.changedDuringDrag,
      changedAfterResize: resizeMetrics.changedAfterResize,
      maxFrameIntervalMs: resizeMetrics.maxFrameIntervalMs,
      longTasks: resizeMetrics.longTasks,
    } }, null, 2));
  } catch (error) {
    let focusDiagnostics = null;
    if (reader) {
      focusDiagnostics = {
        focusEmulationDisabled,
        renderer: await reader.evaluate(() => ({
          blurCount: window.__reviewBlurCount ?? null,
          documentHasFocus: document.hasFocus(),
          savedLayout: JSON.parse(localStorage.getItem('paper-workbench.reader-layout.v1') || 'null'),
        })).catch(diagnosticError => ({ error: diagnosticError.message })),
      };
    }
    if (application) {
      focusDiagnostics = { ...focusDiagnostics, native: await application.evaluate(({ BrowserWindow }, windowId) => {
        const mainWindow = BrowserWindow.getAllWindows().find(window => window.id === windowId);
        const probe = globalThis.__reviewBlurProbeWindow;
        return {
          mainWindowFocused: mainWindow?.isFocused() ?? null,
          mainWebContentsFocused: mainWindow?.webContents.isFocused() ?? null,
          probeWindowFocused: probe && !probe.isDestroyed() ? probe.isFocused() : null,
          probeWebContentsFocused: probe && !probe.isDestroyed() ? probe.webContents.isFocused() : null,
        };
      }, mainBrowserWindowId).catch(diagnosticError => ({ error: diagnosticError.message })) };
    }
    fs.writeFileSync(path.join(output, 'failure.txt'), `${String(error.stack || error)}\nFocus diagnostics: ${JSON.stringify(focusDiagnostics, null, 2)}`);
    if (application) {
      await destroyBlurProbeAndFocusMain();
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }).catch(() => undefined);
      if (!main) main = await application.firstWindow().catch(() => undefined);
      if (main) {
        await main.bringToFront().catch(() => undefined);
        await main.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (application) {
      await destroyBlurProbeAndFocusMain();
      await application.close().catch(() => undefined);
    }
  }
})();
