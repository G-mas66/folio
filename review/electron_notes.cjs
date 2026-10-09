// Independent native QA of text selection, PDF marks and per-paper notes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createStreamFixture } = require('./fixture_stream_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `notes-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
const profile = path.join(output, 'profile');
const appData = path.join(profile, 'appdata');
const localAppData = path.join(profile, 'localappdata');
const userProfile = path.join(profile, 'user');
for (const directory of [temp, appData, localAppData, userProfile]) fs.mkdirSync(directory, { recursive: true });
const env = {
  ...process.env,
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
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = (module, args = []) => {
  const result = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', module, dataRoot, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};
const first = seed('review.seed_reader_fixture', ['--mixed']);
const second = seed('review.seed_tabs_fixture');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources = [first, second].map(paper => ({ path: paper.source, hash: digest(paper.source) }));
const libraryPdfs = [first, second].flatMap(paper => {
  const folder = path.join(dataRoot, 'papers', paper.paper_id);
  return fs.readdirSync(folder).filter(name => name.endsWith('.pdf')).map(name => ({ path: path.join(folder, name), hash: digest(path.join(folder, name)) }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error(message);
};

(async () => {
  const fixture = await createStreamFixture();
  const errors = [];
  const started = Date.now();
  let app, main;
  const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };
  const panel = id => main.getByTestId(`reader-tab-panel-${id}`);
  const current = () => panel(first.paper_id);
  const api = (url, method, body) => main.evaluate(input => window.workbench.request(input), { path: url, method, body });
  const marks = id => api(`/papers/${id}/annotations`);
  const note = id => api(`/papers/${id}/notes`);
  const open = async id => {
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').first().waitFor();
    const title = id === first.paper_id ? '连续阅读验收文献' : '第二篇隔离验收文献';
    await main.locator('.paper-card').filter({ hasText: title }).getByRole('button', { name: '阅读', exact: true }).click();
    await panel(id).getByLabel('当前页码').waitFor();
  };
  const select = async (id, lines = 1) => {
    await panel(id).locator('.textLayer span').first().waitFor();
    const selected = await panel(id).evaluate((element, lineCount) => {
      const page = element.querySelector('.pdf-page-frame[data-rendered="true"]');
      const spans = [...page.querySelectorAll('.textLayer span')].filter(span => span.textContent.trim());
      const start = spans.findIndex(span => /137|249/.test(span.textContent));
      const firstSpan = spans[Math.max(0, start)];
      const lastSpan = spans[Math.min(spans.length - 1, Math.max(0, start) + lineCount - 1)];
      const range = document.createRange();
      range.setStart(firstSpan.firstChild, 0);
      range.setEnd(lastSpan.firstChild, lastSpan.firstChild.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect();
      page.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    }, lines);
    assert.equal(await panel(id).getByTestId('reader-selection-context-menu').count(), 0, 'Selecting text alone must not open the context menu');
    return selected;
  };
  const selectSnippet = async (id, snippet, pageNumber = 1) => {
    const selected = await panel(id).evaluate((element, target) => {
      const page = element.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"][data-rendered="true"]`);
      const span = [...page.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(target.snippet));
      const textNode = [...span.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
      if (!textNode) throw new Error(`Could not find text node for ${target.snippet}`);
      const offset = textNode.textContent.indexOf(target.snippet);
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + target.snippet.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const bounds = page.querySelector('.pdf-page-stage').getBoundingClientRect();
      const rects = [...range.getClientRects()].map(rect => ({
        x: (rect.left - bounds.left) / bounds.width,
        y: (rect.top - bounds.top) / bounds.height,
        width: rect.width / bounds.width,
        height: rect.height / bounds.height,
      }));
      const rect = range.getBoundingClientRect();
      page.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
      return { text: selection.toString(), rects };
    }, { pageNumber, snippet });
    assert.equal(selected.text, snippet, 'The DOM selection must contain only the requested characters');
    assert.equal(await panel(id).getByTestId('reader-selection-context-menu').count(), 0, 'Selecting a text fragment alone must not open the context menu');
    return selected;
  };
  const dragSnippet = async (id, snippet, pageNumber = 1) => {
    const target = await panel(id).evaluate((element, target) => {
      const page = element.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"][data-rendered="true"]`);
      const span = [...page.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(target.snippet));
      const textNode = [...span.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
      if (!textNode) throw new Error(`Could not find text node for ${target.snippet}`);
      const offset = textNode.textContent.indexOf(target.snippet);
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + target.snippet.length);
      const rect = range.getBoundingClientRect();
      return {
        start: { x: rect.left + 1, y: rect.top + rect.height / 2 },
        end: { x: rect.right - 1, y: rect.top + rect.height / 2 },
        spanWidth: span.getBoundingClientRect().width,
        stageWidth: page.querySelector('.pdf-page-stage').getBoundingClientRect().width,
      };
    }, { pageNumber, snippet });
    await main.mouse.move(target.start.x, target.start.y);
    await main.mouse.down();
    await main.mouse.move(target.end.x, target.end.y, { steps: 8 });
    await main.mouse.up();
    const selected = await panel(id).evaluate(element => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0);
      const stage = element.querySelector('.pdf-page-stage').getBoundingClientRect();
      return {
        text: selection.toString().trim(),
        rects: [...range.getClientRects()].map(rect => ({
          x: (rect.left - stage.left) / stage.width,
          y: (rect.top - stage.top) / stage.height,
          width: rect.width / stage.width,
          height: rect.height / stage.height,
        })),
      };
    });
    assert.equal(selected?.text, snippet, 'A real mouse drag must select only the requested characters');
    assert.equal(selected.rects.length, 1, 'A single visual line must produce one dragged selection rectangle');
    const neighborSpanWidth = target.spanWidth / target.stageWidth;
    assert.ok(selected.rects[0].width < neighborSpanWidth * .8,
      'The dragged character range must stay narrower than its full neighboring text span');
    assert.equal(await panel(id).getByTestId('reader-selection-context-menu').count(), 0, 'A mouse drag alone must not open the context menu');
    return { ...selected, neighborSpanWidth, selectedToSpanWidth: selected.rects[0].width / neighborSpanWidth };
  };
  const waitForTextVisible = async (id, pageNumber, snippet) => until(async () => panel(id).evaluate((element, target) => {
    const page = element.querySelector('.pdf-page-frame[data-page-number="' + target.pageNumber + '"]');
    const span = [...page.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(target.snippet));
    if (!span) return false;
    const text = span.getBoundingClientRect();
    const scroll = element.querySelector('.pdf-scroll').getBoundingClientRect();
    return text.top >= Math.max(0, scroll.top) && text.bottom <= Math.min(window.innerHeight, scroll.bottom);
  }, { pageNumber, snippet }), 'Text "' + snippet + '" on page ' + pageNumber + ' must scroll into the visible reader area');
  const openSelectionMenu = async id => {
    const point = await panel(id).evaluate(async element => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) throw new Error('A selected sentence is required');
      let previous = null;
      let rect = null;
      let stableFrames = 0;
      for (let frame = 0; frame < 60 && stableFrames < 1; frame++) {
        await new Promise(requestAnimationFrame);
        if (selection.isCollapsed || !selection.rangeCount) throw new Error('The selected sentence changed before right-click');
        rect = selection.getRangeAt(0).getBoundingClientRect();
        const current = [rect.left, rect.top, rect.width, rect.height];
        stableFrames = previous && current.every((value, index) => Math.abs(value - previous[index]) < .25) ? stableFrames + 1 : 0;
        previous = current;
      }
      if (!rect || stableFrames < 1) throw new Error('The selected sentence geometry did not stabilize');
      const range = selection.getRangeAt(0);
      const line = [...range.getClientRects()].find(candidate => candidate.width > 0 && candidate.height > 0);
      if (!line || !range.startContainer.parentElement?.closest('.textLayer')) throw new Error('The selected sentence must be inside the PDF text layer');
      const x = line.left + line.width / 2;
      const y = line.top + line.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y, text: selection.toString(),
        rangeBounds: rect.toJSON(),
        rangeRects: [...range.getClientRects()].map(rect => rect.toJSON()),
        hit: hit instanceof Element ? `${hit.tagName}.${hit.className}` : hit?.nodeName,
        hitText: hit?.textContent?.slice(0, 100),
      };
    });
    await main.mouse.click(point.x, point.y, { button: 'right' });
    try {
      await panel(id).getByTestId('reader-selection-context-menu').waitFor({ timeout: 3000 });
    } catch {
      const after = await panel(id).evaluate(() => ({
        selected: window.getSelection()?.toString() || '',
        rangeBounds: window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).getBoundingClientRect().toJSON() : null,
        menu: Boolean(document.querySelector('[data-testid="reader-selection-context-menu"]')),
      }));
      throw new Error(`Right-click did not open the selection menu: ${JSON.stringify({ point, after })}`);
    }
    assert.equal(await main.evaluate(() => window.getSelection()?.toString()), point.text, 'A real right-click must preserve the selected text');
  };
  const rect = async id => current().getByTestId(`annotation-rect-${id}-0`).evaluate(element => {
    const mark = element.getBoundingClientRect();
    const page = element.closest('.pdf-page-stage').getBoundingClientRect();
    return { x: (mark.x - page.x) / page.width, y: (mark.y - page.y) / page.height, width: mark.width / page.width, height: mark.height / page.height };
  });
  const aligned = (actual, expected) => {
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < .003, `${key} mark alignment changed: ${actual[key]} vs ${expected[key]}`);
  };
  try {
    app = await _electron.launch(options);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), require(path.join(root, 'package.json')).version);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    await open(first.paper_id);
    await current().getByRole('button', { name: '原文 PDF', exact: true }).click();
    await until(async () => current().locator('.pdf-page-stage > canvas').first().evaluate(canvas => canvas.width / canvas.height < 1), 'Original PDF must finish loading');
    await current().locator('.pdf-page-frame[data-page-number="1"] .textLayer span').first().waitFor();
    const manyFragmentSelection = await current().evaluate(() => {
      const page = document.querySelector('.pdf-page-frame[data-page-number="1"]');
      const spans = [...page.querySelectorAll('.textLayer span')];
      const first = spans.find(span => span.textContent.trim() === '00');
      const last = spans.find(span => span.textContent.trim() === '39');
      if (!first?.firstChild || !last?.firstChild) throw new Error('The synthetic many-fragment text line did not render');
      const range = document.createRange();
      range.setStart(first.firstChild, 0);
      range.setEnd(last.firstChild, last.firstChild.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      page.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { text: selection.toString(), rectCount: range.getClientRects().length };
    });
    assert.ok(manyFragmentSelection.rectCount > 32, 'The synthetic one-line selection must exceed the former 32-rectangle limit');
    assert.ok(manyFragmentSelection.text.startsWith('00') && manyFragmentSelection.text.endsWith('39'));
    await openSelectionMenu(first.paper_id);
    const manyFragmentScreenshot = path.join(output, 'many-fragment-context-menu.png');
    await main.screenshot({ path: manyFragmentScreenshot });
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '取消文字选择', exact: true }).click();
    assert.equal(await current().getByTestId('reader-selection-context-menu').count(), 0, 'A one-line selection with many fragments must remain valid');
    await current().getByLabel('向当前文献提问').fill('我的 AI 草稿不应被选区覆盖');
    const selectedText = await select(first.paper_id, 2);
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '高亮', exact: true }).click();
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '绿色高亮', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 1, 'Highlight must reach the database');
    const highlight = (await marks(first.paper_id))[0];
    assert.equal(highlight.pdf_kind, 'original');
    assert.equal(highlight.color, 'green');
    assert.equal(highlight.page_no, 1);
    assert.equal(highlight.selected_text, selectedText);
    assert.ok(highlight.rects.length >= 2, 'Multi-line highlight must preserve all text rectangles');
    assert.equal(await current().getByLabel('向当前文献提问').inputValue(), '我的 AI 草稿不应被选区覆盖');
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    aligned(await rect(highlight.id), highlight.rects[0]);
    const highlightedBox = await current().getByTestId(`annotation-rect-${highlight.id}-0`).boundingBox();
    const reselectY = highlightedBox.y + highlightedBox.height / 2;
    await main.mouse.move(highlightedBox.x + 2, reselectY);
    await main.mouse.down();
    await main.mouse.move(highlightedBox.x + highlightedBox.width - 2, reselectY, { steps: 8 });
    await main.mouse.up();
    assert.ok((await main.evaluate(() => window.getSelection()?.toString() || '')).trim().length > 5, 'Highlighted text must remain selectable with the mouse');
    await current().getByTestId('reader-selection-context-menu').waitFor({ state: 'detached' });
    await openSelectionMenu(first.paper_id);
    for (let count = 0; count < 5; count++) await current().getByLabel('放大 PDF').click();
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 780));
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await delay(300);
    for (let count = 0; count < 5; count++) await current().getByLabel('缩小 PDF').click();

    await current().getByLabel('当前页码').fill('3');
    await current().getByLabel('当前页码').press('Tab');
    await until(async () => current().locator('.pdf-page-frame[data-page-number="3"][data-rendered="true"] canvas').evaluate(canvas => canvas.width > canvas.height), 'A rotated page must render in landscape orientation');
    await current().locator('.pdf-page-frame[data-page-number="3"] .textLayer').waitFor();
    await waitForTextVisible(first.paper_id, 3, 'measured signal');
    const edgeText = await current().locator('.pdf-page-frame[data-page-number="3"] .textLayer').innerText();
    assert.match(edgeText, /Downloaded by Folio synthetic review only/, 'The rotated fixture must contain page-edge download text');
    const preciseSelection = await selectSnippet(first.paper_id, 'measured signal', 3);
    assert.equal(preciseSelection.rects.length, 1);
    assert.ok(preciseSelection.rects[0].width < .2, 'A character-range mark must not expand to the full text span');
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '下划线', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 2, 'Underline must reach the database');
    const underline = (await marks(first.paper_id)).find(mark => mark.kind === 'underline');
    assert.equal(underline.page_no, 3);
    assert.equal(underline.selected_text, 'measured signal');
    assert.equal(underline.rects.length, preciseSelection.rects.length);
    assert.equal(underline.rects[0].underline_edge, 'left', 'A text line rotated 90 degrees must underline its left edge');
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(underline.rects[0][key] - preciseSelection.rects[0][key]) < .003, `Partial text geometry must preserve ${key}`);
    await current().getByTestId(`annotation-rect-${underline.id}-0`).waitFor();
    aligned(await rect(underline.id), underline.rects[0]);
    const rotatedStroke = await current().getByTestId('annotation-rect-' + underline.id + '-0').evaluate(element => {
      const style = getComputedStyle(element);
      return { left: style.borderLeftWidth, bottom: style.borderBottomWidth };
    });
    assert.equal(rotatedStroke.left, '2px');
    assert.equal(rotatedStroke.bottom, '0px');
    const rotatedUnderlineScreenshot = path.join(output, 'rotated-underline.png');
    await main.screenshot({ path: rotatedUnderlineScreenshot });

    await current().locator('.pdf-page-frame[data-page-number="4"]').scrollIntoViewIfNeeded();
    await until(async () => (await current().locator('.pdf-page-frame[data-page-number="4"] .textLayer span').count()) > 0, 'The adjacent rotated page text layer must render');
    const crossPageText = await current().evaluate(() => {
      const first = document.querySelector('.pdf-page-frame[data-page-number="3"] .textLayer span');
      const second = document.querySelector('.pdf-page-frame[data-page-number="4"] .textLayer span');
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(first.firstChild, 0);
      range.setEnd(second.firstChild, Math.min(5, second.firstChild.textContent.length));
      selection.removeAllRanges();
      selection.addRange(range);
      first.closest('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection.toString();
    });
    assert.ok(crossPageText.length > 0);
    assert.match(await current().locator('.selection-notice').innerText(), /同一页内/);
    assert.equal(await current().getByTestId('reader-selection-context-menu').count(), 0, 'Cross-page selections must not open annotation actions');
    await current().getByLabel('当前页码').fill('1');
    await current().getByLabel('当前页码').press('Tab');
    await waitForTextVisible(first.paper_id, 1, 'measured signal');

    await current().locator('.pdf-page-frame[data-page-number="1"] .textLayer span').filter({ hasText: 'The original raster image and vector chart must remain in both versions.' }).first().evaluate(span => span.scrollIntoView({ block: 'end' }));
    await waitForTextVisible(first.paper_id, 1, 'raster image and vector chart');
    const draggedSelection = await dragSnippet(first.paper_id, 'raster image and vector chart');
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '下划线', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 3, 'Normal page underline must persist');
    const normalUnderline = (await marks(first.paper_id)).find(mark => mark.kind === 'underline' && mark.page_no === 1);
    assert.equal(normalUnderline.selected_text, draggedSelection.text, 'The saved underline must preserve the native mouse-drag text range');
    assert.equal(normalUnderline.rects.length, draggedSelection.rects.length);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(normalUnderline.rects[0][key] - draggedSelection.rects[0][key]) < .003, `The saved underline must stay within the dragged range (${key})`);
    assert.equal(normalUnderline.rects[0].underline_edge, 'bottom', 'Horizontal text must keep the legacy bottom underline edge');
    const normalStroke = await current().getByTestId('annotation-rect-' + normalUnderline.id + '-0').evaluate(element => {
      const style = getComputedStyle(element);
      return { left: style.borderLeftWidth, bottom: style.borderBottomWidth };
    });
    assert.equal(normalStroke.left, '0px');
    assert.equal(normalStroke.bottom, '2px');
    await selectSnippet(first.paper_id, 'The original raster image and vector chart must remain in both versions.');
    await openSelectionMenu(first.paper_id);
    const contextMenu = current().getByTestId('reader-selection-context-menu');
    await contextMenu.getByRole('button', { name: '高亮', exact: true }).click();
    const palette = contextMenu.getByRole('group', { name: '高亮颜色' });
    await palette.waitFor();
    const viewportHeight = await main.evaluate(() => window.innerHeight);
    const contextMenuBounds = await contextMenu.boundingBox();
    const paletteBounds = await palette.boundingBox();
    assert.ok(contextMenuBounds.y + contextMenuBounds.height <= viewportHeight - 8, 'An expanded menu near the bottom must remain inside the window');
    assert.ok(paletteBounds.y + paletteBounds.height <= viewportHeight - 8, 'The highlight palette must remain fully visible');
    const contextMenuScreenshot = path.join(output, 'context-menu-palette-bottom.png');
    await main.screenshot({ path: contextMenuScreenshot });
    await contextMenu.getByRole('button', { name: '取消文字选择', exact: true }).click();

    await select(first.paper_id);
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '批注', exact: true }).click();
    await current().getByLabel('批注内容', { exact: true }).fill('这里的样本数是 137，需要复核患者独立性。');
    await current().getByRole('button', { name: '保存批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 4, 'Comment must persist');
    const comment = (await marks(first.paper_id)).find(mark => mark.kind === 'comment');
    assert.ok(comment.comment.includes('患者独立性'));
    assert.equal(comment.color, 'yellow');
    const row = () => current().getByTestId(`reader-annotation-${comment.id}`);
    await row().getByRole('button', { name: '编辑批注', exact: true }).click();
    await current().getByLabel('批注内容', { exact: true }).fill('已核对：样本数为 137。');
    await current().getByRole('button', { name: '保存批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).find(mark => mark.id === comment.id)?.comment === '已核对：样本数为 137。', 'Edited comment must persist');

    await app.evaluate(({ ipcMain }, id) => {
      const handler = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__notesOriginalHandler = handler;
      globalThis.__selectionTranslationCount = 0;
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', async (event, input) => {
        if (input.path === `/papers/${id}/translate-selection`) {
          globalThis.__selectionTranslationCount += 1;
          await new Promise(resolve => setTimeout(resolve, globalThis.__selectionTranslationCount === 1 ? 300 : 1200));
          const longSuffix = globalThis.__selectionTranslationCount === 1 ? '译文内容。'.repeat(180) : '';
          return { translation: `合成译文：${input.body.text}${longSuffix}` };
        }
        return handler(event, input);
      });
    }, first.paper_id);
    await selectSnippet(first.paper_id, 'measured signal');
    assert.equal(await current().getByTestId('reader-sentence-translation').count(), 0, 'Translation must not open before choosing the menu action');
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '翻译句子', exact: true }).click();
    const translationWindow = () => current().getByTestId('reader-sentence-translation');
    await translationWindow().getByRole('status').waitFor();
    const selectionBounds = await current().evaluate(() => window.getSelection().getRangeAt(0).getBoundingClientRect().toJSON());
    const translationBounds = await translationWindow().boundingBox();
    const overlapsSelection = translationBounds.x < selectionBounds.right && translationBounds.x + translationBounds.width > selectionBounds.left
      && translationBounds.y < selectionBounds.bottom && translationBounds.y + translationBounds.height > selectionBounds.top;
    assert.equal(overlapsSelection, false, 'The translation window must initially avoid the selected sentence');
    await until(async () => (await translationWindow().innerText()).includes('合成译文：measured signal'), 'Selected sentence translation must appear in its own window');
    const longWindow = await translationWindow().evaluate(element => ({
      height: element.getBoundingClientRect().height,
      contentHeight: element.querySelector('.pdf-translation-window-content').clientHeight,
      contentScrollHeight: element.querySelector('.pdf-translation-window-content').scrollHeight,
    }));
    assert.ok(longWindow.height <= 320, 'Long translations must stay within the small-window height limit');
    assert.ok(longWindow.contentScrollHeight > longWindow.contentHeight, 'Long translations must scroll inside the window');
    const longTranslationScreenshot = path.join(output, 'long-translation-window.png');
    await main.screenshot({ path: longTranslationScreenshot });
    const beforeDrag = await translationWindow().boundingBox();
    const heading = await translationWindow().locator('.pdf-translation-window-heading').boundingBox();
    await main.mouse.move(heading.x + 70, heading.y + heading.height / 2);
    await main.mouse.down();
    await main.mouse.move(heading.x + 115, heading.y + heading.height / 2 + 28, { steps: 4 });
    await main.mouse.up();
    const afterDrag = await translationWindow().boundingBox();
    assert.ok(afterDrag.x > beforeDrag.x + 25 && afterDrag.y > beforeDrag.y + 15, 'The translation window must be draggable');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 780));
    await delay(400);
    const resizedTranslation = await translationWindow().boundingBox();
    const resizedViewport = await main.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    assert.ok(resizedTranslation.x >= 0 && resizedTranslation.y >= 0
      && resizedTranslation.x + resizedTranslation.width <= resizedViewport.width
      && resizedTranslation.y + resizedTranslation.height <= resizedViewport.height,
    'The translation window must stay inside the viewport after the main window shrinks');
    const resizedClose = await translationWindow().getByRole('button', { name: '关闭翻译', exact: true }).boundingBox();
    assert.ok(resizedClose.x >= 0 && resizedClose.y >= 0
      && resizedClose.x + resizedClose.width <= resizedViewport.width
      && resizedClose.y + resizedClose.height <= resizedViewport.height,
    'The close button must remain visible after the main window shrinks');
    const resizedTranslationScreenshot = path.join(output, 'resized-translation-window.png');
    await main.screenshot({ path: resizedTranslationScreenshot });
    await translationWindow().getByRole('button', { name: '关闭翻译', exact: true }).click();
    await translationWindow().waitFor({ state: 'detached' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await delay(300);

    await selectSnippet(first.paper_id, 'measured signal');
    await openSelectionMenu(first.paper_id);
    await current().getByTestId('reader-selection-context-menu').getByRole('button', { name: '翻译句子', exact: true }).click();
    await translationWindow().getByRole('status').waitFor();
    await open(second.paper_id);
    assert.equal(await panel(second.paper_id).getByTestId('reader-sentence-translation').count(), 0, 'A pending translation must not appear in another paper');
    await delay(1300);
    assert.equal(await panel(second.paper_id).getByTestId('reader-sentence-translation').count(), 0, 'A late translation response must remain scoped to its source paper');
    await main.getByTestId(`paper-tab-${first.paper_id}`).click();
    await translationWindow().waitFor();
    await main.keyboard.press('Escape');
    await translationWindow().waitFor({ state: 'detached' });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', globalThis.__notesOriginalHandler);
    });

    await current().getByLabel('阅读笔记', { exact: true }).fill('第一篇笔记：137 个样本；改善 23.7%。\n<script>window.__notesXss = true</script>');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text.includes('23.7%'), 'First note must persist');
    assert.equal(await main.evaluate(() => window.__notesXss), undefined);
    await current().getByLabel('阅读笔记', { exact: true }).fill('第一篇笔记：137 个样本；改善 23.7%。\n需关注：实验条件与实际场景的差异。');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text.includes('实际场景'), 'Clean preview note must save');
    await main.screenshot({ path: path.join(output, 'notes-and-highlights.png') });

    await current().getByRole('button', { name: '中文 PDF', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor({ state: 'detached' });
    await row().getByRole('button', { name: '跳到此处', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    assert.equal(await current().locator('.mode-button.active').getAttribute('aria-label'), '原文 PDF');
    aligned(await rect(highlight.id), highlight.rects[0]);
    // Virtualization destroys distant text layers, but saved marks return correctly.
    await current().getByLabel('当前页码').fill('12');
    await current().getByLabel('当前页码').press('Tab');
    await delay(500);
    await row().getByRole('button', { name: '跳到此处', exact: true }).click();
    await current().getByTestId(`annotation-rect-${highlight.id}-0`).waitFor();
    await delay(400);
    aligned(await rect(highlight.id), highlight.rects[0]);

    await open(second.paper_id);
    await panel(second.paper_id).getByTestId('reader-side-tab-notes').click();
    assert.equal(await panel(second.paper_id).getByLabel('阅读笔记', { exact: true }).inputValue(), '');
    assert.equal((await marks(second.paper_id)).length, 0);
    const duplicateIds = await main.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    });
    assert.deepEqual(duplicateIds, [], 'Document tabs must not share DOM IDs or accessibility targets');
    await panel(second.paper_id).getByLabel('阅读笔记', { exact: true }).fill('第二篇独立笔记：249 个样本。');
    await panel(second.paper_id).getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(second.paper_id)).text.includes('249'), 'Second note must persist');
    await main.getByTestId(`paper-tab-${first.paper_id}`).click();
    assert.ok((await current().getByLabel('阅读笔记', { exact: true }).inputValue()).includes('137'));

    // A delayed old save must never erase edits made while it is in flight.
    await app.evaluate(({ ipcMain }, id) => {
      const handler = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__notesOriginalHandler = handler;
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', async (event, input) => {
        if (input.path === `/papers/${id}/notes` && input.method === 'PUT') await new Promise(resolve => setTimeout(resolve, 450));
        return handler(event, input);
      });
    }, first.paper_id);
    await current().getByLabel('阅读笔记', { exact: true }).fill('延迟保存的旧内容');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await current().getByLabel('阅读笔记', { exact: true }).fill('保存期间继续输入的新内容，不可被旧保存覆盖');
    await delay(600);
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '保存期间继续输入的新内容，不可被旧保存覆盖');
    await until(async () => (await note(first.paper_id)).text === '保存期间继续输入的新内容，不可被旧保存覆盖', 'Latest revision must eventually persist');
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', globalThis.__notesOriginalHandler);
    });

    // Deliberately block only this isolated document's note PUT in Electron.
    await app.evaluate(({ ipcMain }, id) => {
      const handler = ipcMain._invokeHandlers.get('workbench:request');
      globalThis.__notesOriginalHandler = handler;
      ipcMain.removeHandler('workbench:request');
      ipcMain.handle('workbench:request', (event, input) => {
        if (input.path === `/papers/${id}/notes` && input.method === 'PUT') throw new Error('测试保存失败：保留草稿');
        return handler(event, input);
      });
    }, first.paper_id);
    await current().getByLabel('阅读笔记', { exact: true }).fill('网络失败期间仍须保留的笔记草稿');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => /失败/.test(await current().getByTestId('reader-note-save-status').innerText()), 'Failed save must not claim success');
    await main.getByTestId(`close-tab-${first.paper_id}`).click();
    await open(first.paper_id);
    await current().getByTestId('reader-side-tab-notes').click();
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '网络失败期间仍须保留的笔记草稿');
    await app.close();
    app = await _electron.launch(options);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await current().getByTestId('reader-side-tab-notes').waitFor();
    await current().getByTestId('reader-side-tab-notes').click();
    assert.equal(await current().getByLabel('阅读笔记', { exact: true }).inputValue(), '网络失败期间仍须保留的笔记草稿');
    await current().getByRole('button', { name: '保存笔记', exact: true }).click();
    await until(async () => (await note(first.paper_id)).text === '网络失败期间仍须保留的笔记草稿', 'Recovered draft must save to DB');
    assert.equal((await marks(first.paper_id)).length, 4);
    assert.ok((await note(second.paper_id)).text.includes('249'));
    await main.screenshot({ path: path.join(output, 'restored-notes.png') });
    await row().getByRole('button', { name: '删除批注', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 3, 'Deleting comment must preserve highlight and underlines');
    await current().getByTestId(`reader-annotation-${highlight.id}`).getByRole('button', { name: '删除高亮', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 2, 'Highlight must be deletable without removing underlines');
    await current().getByTestId(`reader-annotation-${underline.id}`).getByRole('button', { name: '删除下划线', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 1, 'Rotated underline must be deletable');
    await current().getByTestId('reader-annotation-' + normalUnderline.id).getByRole('button', { name: '删除下划线', exact: true }).click();
    await until(async () => (await marks(first.paper_id)).length === 0, 'Normal underline must be deletable');
    assert.equal(fixture.requests.length, 0, 'Notes, marks and edits must never invoke AI');
    await api('/settings', 'PUT', { base_url: fixture.apiUrl, protocol: 'custom_chat_completions', model: 'stream-fixture', api_key: 'review-only-notes-key' });
    await current().getByTestId('reader-side-tab-chat').click();
    await until(async () => (await current().getByTestId('reader-model-select').inputValue()) === 'stream-fixture', 'Chat must receive settings');
    fixture.state.pause = true;
    await current().getByLabel('向当前文献提问').fill('停止思考测试');
    await current().getByRole('button', { name: /发送/ }).click();
    await current().getByTestId('streaming-reasoning').getByText(/思考第一段/).waitFor();
    await current().getByTestId('reader-side-tab-notes').click();
    await delay(400);
    assert.equal(fixture.sessions.at(-1).closedEarly, false, 'Switching to notes must not cancel AI');
    await current().getByTestId('reader-side-tab-chat').click();
    await current().getByRole('button', { name: '停止生成', exact: true }).click();
    await until(() => fixture.sessions.at(-1).closedEarly, 'Stop must still work after returning from notes');
    for (const source of sources) assert.equal(digest(source.path), source.hash, 'Original PDF must remain unchanged');
    for (const pdf of libraryPdfs) assert.equal(digest(pdf.path), pdf.hash, 'Library original/Chinese/bilingual PDFs must remain unchanged');
    await main.evaluate(([firstId, secondId]) => {
      localStorage.setItem(`paper-workbench.note-draft.${firstId}`, '删除时清理此篇草稿');
      localStorage.setItem(`paper-workbench.note-draft.${secondId}`, '其他篇草稿不得清理');
    }, [first.paper_id, second.paper_id]);
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: '连续阅读验收文献' }).locator('summary').click();
    const confirmation = main.waitForEvent('dialog');
    const deletion = main.locator('.paper-card').filter({ hasText: '连续阅读验收文献' }).getByRole('button', { name: '删除', exact: true }).click();
    await (await confirmation).accept();
    await deletion;
    await main.getByTestId(`paper-tab-${first.paper_id}`).waitFor({ state: 'detached' });
    assert.equal(await main.evaluate(id => localStorage.getItem(`paper-workbench.note-draft.${id}`), first.paper_id), null);
    assert.equal(await main.evaluate(id => localStorage.getItem(`paper-workbench.note-draft.${id}`), second.paper_id), '其他篇草稿不得清理');
    assert.ok((await note(second.paper_id)).text.includes('249'));
    for (const source of sources) assert.equal(digest(source.path), source.hash);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(app.windows().length, 1);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
      result: 'passed', version: require(path.join(root, 'package.json')).version, seconds: (Date.now() - started) / 1000,
      first, second, highlight, underline, normalUnderline, comment, sourceHashes: sources, aiRequests: fixture.requests.length, errors,
      selectionEvidence: {
        manyFragments: { selectedText: manyFragmentSelection.text, rectCount: manyFragmentSelection.rectCount, contextMenuAccepted: true },
        nativeDrag: { selectedText: draggedSelection.text, selectionRectCount: draggedSelection.rects.length, storedRectCount: normalUnderline.rects.length, selectedToSpanWidth: draggedSelection.selectedToSpanWidth },
        rotatedUnderline: { edge: underline.rects[0].underline_edge, borderLeftWidth: rotatedStroke.left, borderBottomWidth: rotatedStroke.bottom },
        horizontalUnderline: { edge: normalUnderline.rects[0].underline_edge, borderLeftWidth: normalStroke.left, borderBottomWidth: normalStroke.bottom },
      },
      translationEvidence: longWindow,
      screenshots: [manyFragmentScreenshot, rotatedUnderlineScreenshot, contextMenuScreenshot, longTranslationScreenshot, resizedTranslationScreenshot, path.join(output, 'notes-and-highlights.png'), path.join(output, 'restored-notes.png')],
    }, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    await main?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    throw error;
  } finally {
    if (app) await app.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    const cleaned = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env, encoding: 'utf8' });
    if (cleaned.status !== 0) throw new Error('Isolated credential cleanup failed');
  }
})();
