// Real Electron checks for PDF text-layer order and mark geometry against canvas ink.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `reader-geometry-${Date.now()}`);
const temp = path.join(output, 'temp');
const profile = path.join(output, 'profile');
const data = path.join(output, 'data');
for (const directory of [temp, profile, data]) fs.mkdirSync(directory, { recursive: true });
const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: data,
  WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'credentials'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'config', 'location.json'),
  APPDATA: path.join(profile, 'appdata'),
  LOCALAPPDATA: path.join(profile, 'localappdata'),
  USERPROFILE: path.join(profile, 'user'),
  TEMP: temp,
  TMP: temp,
  PYTHONIOENCODING: 'utf-8',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error(message);
};

(async () => {
  let app;
  let main;
  const evidence = { output, modes: {}, marks: {}, errors: [] };
  try {
    const seeded = spawnSync(path.join(root, '.venv', 'Scripts', 'python.exe'), [
      '-B', path.join(__dirname, 'create_reader_geometry_fixture.py'), output,
    ], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const fixture = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1));
    evidence.fixture = { ...fixture, data };

    app = await _electron.launch({
      cwd: root,
      env,
      timeout: 90000,
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
    });
    main = await app.firstWindow();
    main.on('pageerror', error => evidence.errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    await main.getByTestId(`paper-read-${fixture.paper_id}`).click();
    const reader = main.locator(`[data-testid="reader-tab-panel-${fixture.paper_id}"]`);
    await reader.getByLabel('当前页码').waitFor();

    const modeLabels = { original: '原文 PDF', mono: '中文 PDF', dual: '双语对照' };
    const waitMode = async kind => until(async () => main.evaluate(expected => {
      const scroll = document.querySelector('.pdf-scroll');
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"]');
      return scroll?.dataset.pdfKind === expected
        && frame?.dataset.rendered === 'true'
        && Boolean(frame.querySelector('.textLayer span'));
    }, kind), `${kind} PDF text layer must render`);
    const pageMetrics = async pageNumber => reader.locator(`.pdf-page-frame[data-page-number="${pageNumber}"]`).evaluate(frame => {
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const stage = frame.querySelector('.pdf-page-stage');
      const canvas = stage.querySelector('canvas');
      const layer = stage.querySelector('.textLayer');
      const spans = [...layer.querySelectorAll('span[role="presentation"]')];
      return {
        page: Number(frame.dataset.pageNumber),
        rendered: frame.dataset.rendered,
        stage: bounds(stage), canvas: bounds(canvas), textLayer: bounds(layer),
        canvasPixels: { width: canvas.width, height: canvas.height },
        mainRotation: layer.dataset.mainRotation || '0',
        spanCount: spans.length,
        directNodes: [...layer.childNodes].slice(0, 8).map(node => ({ name: node.nodeName, role: node.nodeType === Node.ELEMENT_NODE ? node.getAttribute('role') : '', text: node.textContent.slice(0, 40) })),
        text: spans.map(span => span.textContent).join(''),
        order: spans.map(span => span.textContent).filter(text => /中文双栏定位|左栏第7行|左栏第8行|右栏第7行|页脚跨越/.test(text)),
        stageCanvasDelta: { x: canvas.getBoundingClientRect().left - stage.getBoundingClientRect().left, y: canvas.getBoundingClientRect().top - stage.getBoundingClientRect().top },
      };
    });
    const checkStageAlignment = async pageNumber => {
      const metrics = await pageMetrics(pageNumber);
      for (const axis of ['left', 'top', 'width', 'height']) {
        assert.ok(Math.abs(metrics.stage[axis] - metrics.canvas[axis]) <= 1, `page ${pageNumber} stage/canvas ${axis} mismatch`);
        assert.ok(Math.abs(metrics.textLayer[axis] - metrics.canvas[axis]) <= 1, `page ${pageNumber} textLayer/canvas ${axis} mismatch`);
      }
      return metrics;
    };
    const waitPageStable = async pageNumber => until(async () => reader.evaluate(async (panel, target) => {
      const frame = document.querySelector(`.pdf-page-frame[data-page-number="${target}"]`);
      const stage = frame?.querySelector('.pdf-page-stage');
      if (!stage) return false;
      const sample = () => {
        const rect = stage.getBoundingClientRect();
        return [rect.left, rect.top, rect.width, rect.height];
      };
      let previous = sample();
      let stable = 0;
      for (let index = 0; index < 20; index += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const current = sample();
        if (current.every((value, axis) => Math.abs(value - previous[axis]) < 0.25)) stable += 1;
        else stable = 0;
        if (stable >= 2) return true;
        previous = current;
      }
      return false;
    }, pageNumber), `Page ${pageNumber} geometry must settle before interaction`);

    const marks = async () => main.evaluate(id => window.workbench.request({ path: `/papers/${id}/annotations` }), fixture.paper_id);
    const waitForMark = async (before, text, kind, markKind = 'highlight') => {
      let match;
      await until(async () => {
        const current = await marks();
        match = current.find(mark => mark.selected_text === text && mark.pdf_kind === kind && mark.kind === markKind && !before.includes(mark.id));
        return Boolean(match);
      }, `saved ${markKind} mark for ${kind}: ${text}`);
      return match;
    };
    const measureRaster = async (pageNumber, rect) => reader.evaluate((panel, target) => {
      const frame = document.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"]`);
      const stage = frame.querySelector('.pdf-page-stage').getBoundingClientRect();
      const canvas = frame.querySelector('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const sx = canvas.width / stage.width;
      const sy = canvas.height / stage.height;
      const vertical = ['left', 'right'].includes(target.rect.underline_edge);
      const padX = vertical ? 8 : 0;
      const padY = vertical ? 0 : 8;
      const x0 = Math.max(0, Math.floor((stage.left + target.rect.x * stage.width - padX - stage.left) * sx));
      const x1 = Math.min(canvas.width, Math.ceil((stage.left + (target.rect.x + target.rect.width) * stage.width + padX - stage.left) * sx));
      const y0 = Math.max(0, Math.floor((stage.top + target.rect.y * stage.height - padY - stage.top) * sy));
      const y1 = Math.min(canvas.height, Math.ceil((stage.top + (target.rect.y + target.rect.height) * stage.height + padY - stage.top) * sy));
      const pixels = context.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      const dark = (x, y) => {
        const offset = (y * pixels.width + x) * 4;
        return pixels.data[offset + 3] > 0 && pixels.data[offset] < 160 && pixels.data[offset + 1] < 160 && pixels.data[offset + 2] < 160;
      };
      if (vertical) {
        const counts = new Array(pixels.width).fill(0);
        for (let x = 0; x < pixels.width; x += 1) for (let y = 0; y < pixels.height; y += 1) if (dark(x, y)) counts[x] += 1;
        const runs = [];
        let run = null;
        for (let x = 0; x < counts.length; x += 1) {
          if (counts[x] > 0) {
            if (!run) run = { first: x, last: x, pixels: 0 };
            run.last = x;
            run.pixels += counts[x];
          } else if (run && x - run.last > 2) {
            runs.push(run);
            run = null;
          }
        }
        if (run) runs.push(run);
        const center = (target.rect.x + target.rect.width / 2) * stage.width * sx;
        const best = runs.sort((a, b) => Math.abs((a.first + a.last + 1) / 2 + x0 - center) - Math.abs((b.first + b.last + 1) / 2 + x0 - center))[0];
        if (!best) return null;
        let minY = pixels.height, maxY = -1, count = 0;
        for (let x = best.first; x <= best.last; x += 1) for (let y = 0; y < pixels.height; y += 1) if (dark(x, y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); count += 1; }
        return {
          ink: {
            left: stage.left + (x0 + best.first) * stage.width / canvas.width,
            right: stage.left + (x0 + best.last + 1) * stage.width / canvas.width,
            top: stage.top + (y0 + minY) * stage.height / canvas.height,
            bottom: stage.top + (y0 + maxY + 1) * stage.height / canvas.height,
          },
          counts: count,
        };
      }
      const counts = new Array(pixels.height).fill(0);
      for (let y = 0; y < pixels.height; y += 1) {
        for (let x = 0; x < pixels.width; x += 1) {
          if (dark(x, y)) counts[y] += 1;
        }
      }
      const runs = [];
      let run = null;
      for (let y = 0; y < counts.length; y += 1) {
        if (counts[y] > 0) {
          if (!run) run = { first: y, last: y, pixels: 0 };
          run.last = y;
          run.pixels += counts[y];
        } else if (run && y - run.last > 2) {
          runs.push(run);
          run = null;
        }
      }
      if (run) runs.push(run);
      const center = (target.rect.y + target.rect.height / 2) * stage.height * sy;
      const best = runs.sort((a, b) => Math.abs((a.first + a.last + 1) / 2 + y0 - center) - Math.abs((b.first + b.last + 1) / 2 + y0 - center))[0];
      if (!best) return null;
      let minX = pixels.width, maxX = -1;
      for (let y = best.first; y <= best.last; y += 1) for (let x = 0; x < pixels.width; x += 1) if (dark(x, y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      return {
        ink: {
          left: stage.left + (x0 + minX) * stage.width / canvas.width,
          right: stage.left + (x0 + maxX + 1) * stage.width / canvas.width,
          top: stage.top + (y0 + best.first) * stage.height / canvas.height,
          bottom: stage.top + (y0 + best.last + 1) * stage.height / canvas.height,
        },
        counts: best.pixels,
        runs,
      };
    }, { pageNumber, rect });
    const compareMarkToCanvas = async (mark, pageNumber) => {
      const geometry = [];
      for (const rect of mark.rects) {
        const ink = await measureRaster(pageNumber, rect);
        assert.ok(ink, `Canvas must contain raster glyph pixels under ${mark.selected_text}`);
        const markCss = await reader.locator(`.pdf-page-frame[data-page-number="${pageNumber}"] .pdf-page-stage`).evaluate((stage, normalized) => {
          const box = stage.getBoundingClientRect();
          const mark = {
            left: box.left + normalized.x * box.width,
            right: box.left + (normalized.x + normalized.width) * box.width,
            top: box.top + normalized.y * box.height,
            bottom: box.top + (normalized.y + normalized.height) * box.height,
          };
          const centerX = (mark.left + mark.right) / 2;
          const centerY = (mark.top + mark.bottom) / 2;
          const span = [...stage.querySelectorAll('.textLayer span[role="presentation"]')].find(element => {
            const rect = element.getBoundingClientRect();
            return centerX >= rect.left && centerX <= rect.right && centerY >= rect.top && centerY <= rect.bottom;
          });
          return { ...mark, fontSize: span ? Number.parseFloat(getComputedStyle(span).fontSize) : 0 };
        }, rect);
        const delta = Object.fromEntries(['left', 'right', 'top', 'bottom'].map(key => [key, markCss[key] - ink.ink[key]]));
        geometry.push({ rect, markCss, ...ink, delta });
        evidence.marks[mark.id] = { kind: mark.kind, pdfKind: mark.pdf_kind, page: pageNumber, text: mark.selected_text, rects: geometry };
        for (const key of ['left', 'right', 'top', 'bottom']) {
          const coversInk = key === 'left' || key === 'top' ? markCss[key] <= ink.ink[key] + 2 : markCss[key] >= ink.ink[key] - 2;
          assert.ok(coversInk, `${mark.pdf_kind} ${mark.selected_text} mark must cover canvas ink at ${key}; mark=${JSON.stringify(markCss)} ink=${JSON.stringify(ink.ink)}`);
        }
        const vertical = ['left', 'right'].includes(rect.underline_edge);
        const crossEdges = vertical ? ['left', 'right'] : ['top', 'bottom'];
        for (const key of crossEdges) {
          assert.ok(Math.abs(delta[key]) <= 4, `${mark.pdf_kind} ${mark.selected_text} ${key} cross-axis mark/glyph offset ${delta[key].toFixed(2)}px exceeds 4px; mark=${JSON.stringify(markCss)} ink=${JSON.stringify(ink.ink)}`);
        }
        const alongEdges = vertical ? ['top', 'bottom'] : ['left', 'right'];
        const advanceSlack = Math.max(4, markCss.fontSize || 12);
        for (const [index, key] of alongEdges.entries()) {
          const withinAdvance = index === 0
            ? delta[key] >= -advanceSlack - 2 && delta[key] <= 2
            : delta[key] >= -2 && delta[key] <= advanceSlack + 2;
          assert.ok(withinAdvance, `${mark.pdf_kind} ${mark.selected_text} ${key} exceeds PDF glyph advance slack (${advanceSlack.toFixed(2)}px): ${delta[key].toFixed(2)}px`);
        }
      }
      return geometry;
    };
    const selectSnippet = async (kind, pageNumber, snippet) => reader.evaluate((panel, target) => {
      const frame = document.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"][data-rendered="true"]`);
      const layer = frame.querySelector('.textLayer');
      const span = [...layer.querySelectorAll('span')].find(node => node.textContent.includes(target.snippet));
      if (!span) throw new Error(`Missing text span: ${target.snippet}`);
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent.includes(target.snippet)) textNode = walker.nextNode();
      if (!textNode) throw new Error(`Missing text node: ${target.snippet}`);
      const offset = textNode.textContent.indexOf(target.snippet);
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + target.snippet.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rangeRect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0);
      const spanRect = span.getBoundingClientRect();
      const textRotation = Number.parseFloat(getComputedStyle(span).getPropertyValue('--rotate')) || 0;
      const pageRotation = Number.parseFloat(layer.dataset.mainRotation || '0') || 0;
      const vertical = Math.abs(Math.round((textRotation + pageRotation) / 90) % 2) === 1;
      const left = vertical ? Math.max(rangeRect.left, spanRect.left) : rangeRect.left;
      const top = vertical ? rangeRect.top : Math.max(rangeRect.top, spanRect.top);
      const right = vertical ? Math.min(rangeRect.right, spanRect.right) : rangeRect.right;
      const bottom = vertical ? rangeRect.bottom : Math.min(rangeRect.bottom, spanRect.bottom);
      const rect = { left, top, right, bottom, width: right - left, height: bottom - top };
      layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: left + rect.width / 2, clientY: top + rect.height / 2 }));
      return { text: selection.toString(), rect, rangeRect: rangeRect.toJSON(), spanRect: spanRect.toJSON(), vertical };
    }, { pageNumber, snippet });
    const saveHighlight = async (kind, pageNumber, expectedText, clickPoint) => {
      const before = (await marks()).map(mark => mark.id);
      await main.mouse.click(clickPoint.x, clickPoint.y, { button: 'right' });
      await reader.getByTestId('reader-selection-context-menu').waitFor();
      assert.equal(await main.evaluate(() => window.getSelection()?.toString() || ''), expectedText);
      await reader.getByTestId('reader-selection-context-menu').getByRole('button', { name: '高亮', exact: true }).click();
      await reader.getByRole('button', { name: '黄色高亮', exact: true }).click();
      const mark = await waitForMark(before, expectedText, kind);
      await reader.getByTestId('reader-selection-context-menu').waitFor({ state: 'detached' });
      return mark;
    };
    const saveUnderline = async (kind, expectedText, clickPoint) => {
      const before = (await marks()).map(mark => mark.id);
      await main.mouse.click(clickPoint.x, clickPoint.y, { button: 'right' });
      evidence.lastContextTrace = await main.evaluate(point => {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const anchor = selection?.anchorNode?.parentElement?.closest('span[role="presentation"]');
        const anchorRect = anchor?.getBoundingClientRect();
        const target = document.elementFromPoint(point.x, point.y);
        return {
          point,
          selectionText: selection?.toString() || '',
          rangeRects: range ? [...range.getClientRects()].map(rect => rect.toJSON()) : [],
          spanRect: anchorRect?.toJSON() || null,
          target: target ? { tag: target.tagName, className: target.className?.toString?.() || '' } : null,
          selectionNotice: document.querySelector('.selection-notice')?.textContent || '',
          menuCount: document.querySelectorAll('[data-testid="reader-selection-context-menu"]').length,
        };
      }, clickPoint);
      const menu = reader.getByTestId('reader-selection-context-menu');
      await menu.waitFor();
      assert.equal(await main.evaluate(() => window.getSelection()?.toString() || ''), expectedText);
      await menu.getByRole('button', { name: '下划线', exact: true }).click();
      const mark = await waitForMark(before, expectedText, kind, 'underline');
      await menu.waitFor({ state: 'detached' });
      return mark;
    };
    const assertUnderlineStroke = async (mark, pageNumber, geometry) => {
      for (let index = 0; index < mark.rects.length; index += 1) {
        const edge = mark.rects[index].underline_edge || 'bottom';
        if (pageNumber === 1) assert.equal(edge, 'bottom', 'Unrotated text underline edge must stay at the bottom');
        if (pageNumber === 2) assert.equal(edge, 'left', 'A 90-degree page underline edge must stay on the left');
        const stroke = await reader.getByTestId(`annotation-rect-${mark.id}-${index}`).evaluate(element => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            left: box.left + Number.parseFloat(style.borderLeftWidth) / 2,
            right: box.right - Number.parseFloat(style.borderRightWidth) / 2,
            top: box.top + Number.parseFloat(style.borderTopWidth) / 2,
            bottom: box.bottom - Number.parseFloat(style.borderBottomWidth) / 2,
            borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth,
            borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth,
          };
        });
        const expectedBorder = { left: '2px', right: '2px', top: '2px', bottom: '2px' }[edge];
        assert.equal(stroke[`border${edge[0].toUpperCase()}${edge.slice(1)}`], expectedBorder, `Underline must render on ${edge}`);
        const coordinate = edge === 'left' ? 'left' : edge === 'right' ? 'right' : edge === 'top' ? 'top' : 'bottom';
        const delta = stroke[coordinate] - geometry[index].ink[coordinate];
        if (edge === 'bottom' || edge === 'right') assert.ok(delta >= -1, `${edge} underline stroke must stay outside the glyph, delta=${delta.toFixed(2)}px`);
        else assert.ok(delta <= 1, `${edge} underline stroke must stay outside the glyph, delta=${delta.toFixed(2)}px`);
        assert.ok(Math.abs(delta) <= 4, `${edge} underline stroke is ${delta.toFixed(2)}px from canvas glyph edge`);
        evidence.marks[mark.id].stroke = { edge, stroke, glyph: geometry[index].ink, delta };
      }
    };

    const modeResults = {};
    for (const kind of ['original', 'mono', 'dual']) {
      await reader.getByRole('button', { name: modeLabels[kind], exact: true }).click();
      await waitMode(kind);
      const metrics = await checkStageAlignment(1);
      modeResults[kind] = metrics;
      evidence.modes[kind] = metrics;
      await main.screenshot({ path: path.join(output, `${kind}-page-1.png`) });
      if (kind === 'original') {
        const ordered = metrics.order;
        const left7 = ordered.findIndex(text => text.includes('左栏第7行'));
        const left8 = ordered.findIndex(text => text.includes('左栏第8行'));
        const right7 = ordered.findIndex(text => text.includes('右栏第7行'));
        const title = ordered.findIndex(text => text.includes('中文双栏定位'));
        const footer = ordered.findIndex(text => text.includes('页脚跨越'));
        assert.ok(title >= 0 && title < left7 && left7 >= 0 && left8 > left7 && right7 > left8 && footer > right7, `Title/body/columns/footer reading order must stay stable: ${JSON.stringify(ordered)}`);
      }
    }
    evidence.modes = modeResults;
    const originalWidthRatio = modeResults.original.canvas.width / modeResults.original.canvas.height;
    const dualWidthRatio = modeResults.dual.canvas.width / modeResults.dual.canvas.height;
    assert.ok(Math.abs(dualWidthRatio / originalWidthRatio - 2) < 0.02, 'The bilingual fixture must retain twice the page width ratio');

    await reader.getByRole('button', { name: modeLabels.original, exact: true }).click();
    await waitMode('original');
    const drag = await reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"][data-rendered="true"]');
      const spans = [...frame.querySelectorAll('.textLayer span')];
      const first = spans.find(span => span.textContent.includes('左栏第7行'));
      const last = spans.find(span => span.textContent.includes('左栏第8行'));
      if (!first || !last) throw new Error('Missing left-column rows for native selection');
      const box = span => span.getBoundingClientRect();
      const a = box(first);
      const b = box(last);
      return { start: { x: a.left + 1, y: a.top + a.height / 2 }, end: { x: b.right - 1, y: b.top + b.height / 2 }, first: a.toJSON(), last: b.toJSON() };
    });
    await main.mouse.move(drag.start.x, drag.start.y);
    await main.mouse.down();
    await main.mouse.move(drag.end.x, drag.end.y, { steps: 16 });
    await main.mouse.up();
    const native = await reader.evaluate(() => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return null;
      const stage = document.querySelector('.pdf-page-frame[data-page-number="1"] .pdf-page-stage').getBoundingClientRect();
      const range = selection.getRangeAt(0);
      return {
        text: selection.toString(),
        rects: [...range.getClientRects()].map(rect => ({ x: (rect.left - stage.left) / stage.width, y: (rect.top - stage.top) / stage.height, width: rect.width / stage.width, height: rect.height / stage.height })),
      };
    });
    assert.ok(native?.text.includes('左栏第7行') && native.text.includes('左栏第8行'), `Native drag must span both left-column rows: ${native?.text}`);
    assert.ok(!native.text.includes('右栏'), `Native drag must not select neighboring right-column text: ${native.text}`);
    assert.equal(await reader.getByTestId('reader-selection-context-menu').count(), 0, 'Native mouse selection alone must not open the action menu');
    assert.ok(native.rects.length >= 2, 'The cross-paragraph native drag must preserve both visual lines');
    assert.ok(native.rects.every(rect => rect.x + rect.width < 0.5), `Stored selection geometry must stay in the left column: ${JSON.stringify(native.rects)}`);
    evidence.nativeDrag = { ...native, drag };
    await main.screenshot({ path: path.join(output, 'native-left-column-two-lines.png') });
    const dragEnd = { x: drag.end.x, y: drag.end.y };
    const nativeMark = await saveHighlight('original', 1, native.text.trim(), dragEnd);
    assert.ok(nativeMark.rects.every(rect => rect.x + rect.width < 0.5), 'Persisted rectangles must stay in the left column');
    assert.ok(nativeMark.rects.length >= 2, 'The saved native selection must retain both line rectangles');
    const nativeGeometry = await compareMarkToCanvas(nativeMark, 1);
    for (let i = 0; i < nativeMark.rects.length; i += 1) for (let j = i + 1; j < nativeMark.rects.length; j += 1) {
      const a = nativeMark.rects[i], b = nativeMark.rects[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 0 || overlapY <= 0, 'Adjacent selected line highlight boxes must not overlap');
    }

    const adjacentDrag = await reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"][data-rendered="true"]');
      const spans = [...frame.querySelectorAll('.textLayer span')];
      const first = spans.find(span => span.textContent.includes('左栏第5行'));
      const last = spans.find(span => span.textContent.includes('左栏第6行'));
      if (!first || !last) throw new Error('Missing adjacent left-column rows for native selection');
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      return { start: { x: a.left + 1, y: a.top + a.height / 2 }, end: { x: b.right - 1, y: b.top + b.height / 2 } };
    });
    await main.mouse.move(adjacentDrag.start.x, adjacentDrag.start.y);
    await main.mouse.down();
    await main.mouse.move(adjacentDrag.end.x, adjacentDrag.end.y, { steps: 10 });
    await main.mouse.up();
    const adjacentSelection = await main.evaluate(() => window.getSelection()?.toString().trim() || '');
    assert.ok(adjacentSelection.includes('左栏第5行') && adjacentSelection.includes('左栏第6行'), `Adjacent-row drag must select both lines: ${adjacentSelection}`);
    assert.ok(!adjacentSelection.includes('右栏'), `Adjacent-row drag must not select right-column text: ${adjacentSelection}`);
    const adjacentMark = await saveHighlight('original', 1, adjacentSelection, adjacentDrag.end);
    assert.ok(adjacentMark.rects.length >= 2, 'Adjacent native lines must retain separate highlight rectangles');
    for (let i = 0; i < adjacentMark.rects.length; i += 1) for (let j = i + 1; j < adjacentMark.rects.length; j += 1) {
      const a = adjacentMark.rects[i], b = adjacentMark.rects[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 0 || overlapY <= 0, 'Native adjacent-line highlights must not overlap');
    }
    evidence.adjacentDrag = { text: adjacentSelection, rects: adjacentMark.rects };
    await compareMarkToCanvas(adjacentMark, 1);
    await main.screenshot({ path: path.join(output, 'native-adjacent-lines.png') });

    const normalUnderlineSelection = await selectSnippet('original', 1, '医学图像AI');
    const nativeUnderline = await saveUnderline('original', '医学图像AI', { x: normalUnderlineSelection.rect.left + normalUnderlineSelection.rect.width / 2, y: normalUnderlineSelection.rect.top + normalUnderlineSelection.rect.height / 2 });
    const nativeUnderlineGeometry = await compareMarkToCanvas(nativeUnderline, 1);
    await assertUnderlineStroke(nativeUnderline, 1, nativeUnderlineGeometry);
    evidence.nativeUnderline = nativeUnderlineGeometry;
    await main.screenshot({ path: path.join(output, 'native-two-line-underline.png') });

    const sameRow = await selectSnippet('original', 1, '同行多段文本');
    const bridgePart = await reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"]');
      const spans = [...frame.querySelectorAll('.textLayer span')];
      return spans.find(span => span.textContent.includes('高亮重叠'))?.textContent || '';
    });
    const middlePart = await reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"]');
      return [...frame.querySelectorAll('.textLayer span')].find(span => span.textContent.includes('用于检查'))?.textContent || '';
    });
    assert.ok(bridgePart && middlePart, 'Three same-baseline spans must render for transitive merge');
    await reader.evaluate(expected => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="1"]');
      const first = [...frame.querySelectorAll('.textLayer span')].find(span => span.textContent.includes('同行多段文本'));
      const last = [...frame.querySelectorAll('.textLayer span')].find(span => span.textContent.includes('高亮重叠'));
      const firstNode = first.firstChild;
      const lastNode = last.firstChild;
      const range = document.createRange();
      range.setStart(firstNode, 0);
      range.setEnd(lastNode, lastNode.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      const rect = range.getBoundingClientRect();
      frame.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right - 1, clientY: rect.top + rect.height / 2 }));
    }, sameRow.text);
    const sameRowText = await main.evaluate(() => window.getSelection()?.toString().trim() || '');
    assert.equal(sameRowText, '同行多段文本 用于检查高亮重叠');
    const sameRowBounds = await reader.evaluate(() => {
      const range = window.getSelection().getRangeAt(0);
      const stage = document.querySelector('.pdf-page-frame[data-page-number="1"] .pdf-page-stage').getBoundingClientRect();
      return [...range.getClientRects()].map(rect => ({ x: (rect.left - stage.left) / stage.width, y: (rect.top - stage.top) / stage.height, width: rect.width / stage.width, height: rect.height / stage.height }));
    });
    const sameRowMark = await saveHighlight('original', 1, sameRowText, { x: sameRow.rect.right - 1, y: sameRow.rect.top + sameRow.rect.height / 2 });
    assert.equal(sameRowMark.rects.length, 1, 'Three transitive same-row fragments must merge into one highlight rectangle');
    const overlappingPairs = [];
    for (let i = 0; i < sameRowMark.rects.length; i += 1) for (let j = i + 1; j < sameRowMark.rects.length; j += 1) {
      const a = sameRowMark.rects[i], b = sameRowMark.rects[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > 0.0001 && overlapY > 0.0001) overlappingPairs.push({ i, j, overlapX, overlapY });
    }
    assert.deepEqual(overlappingPairs, [], `Same-row spans must not stack transparent highlights: ${JSON.stringify(overlappingPairs)}`);
    evidence.sameRow = { rangeRects: sameRowBounds, storedRects: sameRowMark.rects, overlappingPairs };
    await compareMarkToCanvas(sameRowMark, 1);
    await main.screenshot({ path: path.join(output, 'same-row-overlap.png') });

    for (const [kind, snippet] of [['mono', '左栏第5行'], ['dual', '双语右栏第5行']]) {
      await reader.getByRole('button', { name: modeLabels[kind], exact: true }).click();
      await waitMode(kind);
      const selected = await selectSnippet(kind, 1, snippet);
      assert.equal(selected.text, snippet);
      const mark = await saveHighlight(kind, 1, snippet, { x: selected.rect.left + selected.rect.width / 2, y: selected.rect.top + selected.rect.height / 2 });
      await compareMarkToCanvas(mark, 1);
      evidence.modes[kind].selectedText = snippet;
      await main.screenshot({ path: path.join(output, `${kind}-mark.png`) });
    }

    await reader.getByRole('button', { name: modeLabels.original, exact: true }).click();
    await waitMode('original');
    await reader.getByLabel('当前页码').fill('2');
    await reader.getByLabel('当前页码').press('Tab');
    await until(async () => main.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="2"]');
      const canvas = frame?.querySelector('canvas');
      return frame?.dataset.rendered === 'true' && canvas?.width > canvas?.height;
    }), 'Rotated page must render in landscape');
    await waitPageStable(2);
    const rotated = await checkStageAlignment(2);
    assert.equal(rotated.mainRotation, '90');
    evidence.rotatedPage = rotated;
    await main.screenshot({ path: path.join(output, 'rotated-page-2.png') });
    const rotatedSelection = await selectSnippet('original', 2, '中文字符');
    assert.equal(rotatedSelection.text, '中文字符');
    evidence.rotatedSelection = rotatedSelection;
    await waitPageStable(2);
    const rotatedMark = await saveUnderline('original', '中文字符', { x: rotatedSelection.rect.left + rotatedSelection.rect.width / 2, y: rotatedSelection.rect.top + rotatedSelection.rect.height / 2 });
    const rotatedGeometry = await compareMarkToCanvas(rotatedMark, 2);
    await assertUnderlineStroke(rotatedMark, 2, rotatedGeometry);
    evidence.rotatedMark = evidence.marks[rotatedMark.id];
    await main.screenshot({ path: path.join(output, 'rotated-mark.png') });
    await reader.getByLabel('放大 PDF').click();
    await until(async () => main.evaluate(() => document.querySelector('.pdf-page-frame[data-page-number="2"]')?.dataset.rendered === 'true'), 'Zoomed rotated page must rerender');
    const zoomed = await checkStageAlignment(2);
    evidence.zoomedRotatedPage = zoomed;
    evidence.zoomedRotatedMark = await compareMarkToCanvas(rotatedMark, 2);
    await main.screenshot({ path: path.join(output, 'zoomed-rotated-mark.png') });

    await reader.getByLabel('当前页码').fill('3');
    await reader.getByLabel('当前页码').press('Tab');
    await until(async () => reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="3"]');
      return frame?.dataset.rendered === 'true' && frame.querySelectorAll('.textLayer span[role="presentation"]').length >= 520;
    }), 'The 520-fragment stress page must render');
    await waitPageStable(3);
    const stressSelection = await reader.evaluate(() => {
      const frame = document.querySelector('.pdf-page-frame[data-page-number="3"][data-rendered="true"]');
      const layer = frame.querySelector('.textLayer');
      const spans = [...layer.querySelectorAll('span[role="presentation"]')].filter(span => span.textContent === 'x');
      if (spans.length < 520) throw new Error(`Expected 520 PDF.js text fragments, found ${spans.length}`);
      const range = document.createRange();
      range.setStart(spans[0].firstChild, 0);
      range.setEnd(spans.at(-1).firstChild, spans.at(-1).textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right - 1, clientY: rect.top + rect.height / 2 }));
      return {
        fragmentCount: spans.length,
        selectedText: selection.toString().trim(),
        rangeRectCount: range.getClientRects().length,
        point: { x: rect.right - 1, y: rect.top + rect.height / 2 },
      };
    });
    assert.ok(stressSelection.fragmentCount > 512, `The stress selection needs more than 512 source fragments: ${stressSelection.fragmentCount}`);
    assert.equal(stressSelection.selectedText.length, stressSelection.fragmentCount, 'The stress selection must retain each selected character');
    const stressMark = await saveHighlight('original', 3, stressSelection.selectedText, stressSelection.point);
    assert.ok(stressMark.rects.length < 512, `Merged same-line fragments should stay under the persisted rectangle cap: ${stressMark.rects.length}`);
    evidence.mergedFragmentLimit = {
      sourceFragments: stressSelection.fragmentCount,
      rangeRectCount: stressSelection.rangeRectCount,
      selectedTextLength: stressSelection.selectedText.length,
      storedRectCount: stressMark.rects.length,
    };
    await main.screenshot({ path: path.join(output, 'merged-fragment-limit.png') });

    assert.equal(evidence.errors.length, 0, evidence.errors.join('\n'));
    evidence.result = 'passed';
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ result: evidence.result, output, nativeText: native.text, nativeRects: native.rects.length, adjacentRects: adjacentMark.rects.length, sameRowRectCount: sameRowMark.rects.length, sourceFragments: stressSelection.fragmentCount, storedStressRects: stressMark.rects.length, modes: Object.keys(modeResults), rotated: rotated.mainRotation }));
  } catch (error) {
    evidence.result = 'failed';
    evidence.failure = String(error.stack || error);
    if (main) await main.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    if (app) await app.close();
  }
})();
