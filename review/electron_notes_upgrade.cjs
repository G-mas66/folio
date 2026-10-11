// Real Electron QA for multi-note persistence and PDF cross-view locations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `notes-upgrade-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const profile = path.join(output, 'profile');
const temp = path.join(output, 'temp');
const env = {
  ...process.env,
  APPDATA: path.join(profile, 'appdata'),
  LOCALAPPDATA: path.join(profile, 'localappdata'),
  USERPROFILE: path.join(profile, 'user'),
  WORKBENCH_DATA_DIR: dataRoot,
  WORKBENCH_CREDENTIAL_ROOT: dataRoot,
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'),
  TEMP: temp,
  TMP: temp,
  PYTHONIOENCODING: 'utf-8',
};
for (const folder of [output, env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, temp]) fs.mkdirSync(folder, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;

const seeded = spawnSync(
  path.join(root, '.venv/Scripts/python.exe'),
  ['-B', '-m', 'review.seed_notes_upgrade_fixture', dataRoot],
  { cwd: root, env, encoding: 'utf8' },
);
assert.equal(seeded.status, 0, seeded.stderr);
const [paperId] = seeded.stdout.trim().split('\t');
assert.match(paperId, /^[a-f0-9]{32}$/);

const options = {
  cwd: root,
  env,
  timeout: 90000,
  executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

(async () => {
  const errors = [];
  const checks = [];
  let app;
  let main;
  const panel = () => main.getByTestId(`reader-tab-panel-${paperId}`);
  const api = (pathName, method = 'GET', body) => main.evaluate(
    input => window.workbench.request(input),
    { path: pathName.startsWith('/') ? pathName : `/papers/${paperId}/${pathName}`, method, body },
  );
  const notes = () => api('notes');
  const annotations = () => api('annotations');
  const openPaper = async () => {
    await main.getByTestId('library-tab').click();
    await main.locator('.paper-card').filter({ hasText: '笔记与跨视图 QA 文献' })
      .getByRole('button', { name: '阅读', exact: true }).click();
    await panel().getByLabel('当前页码').waitFor();
  };
  const setPage = async number => {
    const input = panel().getByLabel('当前页码');
    await input.fill(String(number));
    await input.press('Tab');
    await until(async () => await input.inputValue() === String(number), `Reader should navigate to page ${number}`);
  };
  const selectSnippet = async (pageNumber, quote, expectMenu = true) => {
    const selected = await panel().evaluate(async (root, target) => {
      const deadline = Date.now() + 10000;
      const scrollRoot = root.querySelector('.pdf-scroll');
      if (!scrollRoot) throw new Error('PDF scroll container is missing');
      let page;
      let span;
      let node;
      let range;
      let previousScrollTop = null;
      let stableFrames = 0;
      while (Date.now() < deadline) {
        page = root.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"]`);
        span = page && [...page.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(target.quote));
        node = span && [...span.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.includes(target.quote));
        if (page?.dataset.rendered === 'true' && span && node) {
          const start = node.textContent.indexOf(target.quote);
          range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + target.quote.length);
          const rect = range.getBoundingClientRect();
          const viewport = scrollRoot.getBoundingClientRect();
          const visible = rect.top >= viewport.top && rect.bottom <= viewport.bottom;
          const scrollTop = scrollRoot.scrollTop;
          stableFrames = visible && previousScrollTop !== null && Math.abs(scrollTop - previousScrollTop) < 0.25
            ? stableFrames + 1 : 0;
          if (stableFrames >= 3) break;
          previousScrollTop = scrollTop;
        }
        await new Promise(requestAnimationFrame);
      }
      if (page?.dataset.rendered !== 'true' || !span || !node || !range || stableFrames < 3) {
        throw new Error(`PDF text did not finish scrolling into view: page ${target.pageNumber}, quote ${target.quote}`);
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString();
      const rect = range.getBoundingClientRect();
      const textLayer = page.querySelector('.textLayer');
      textLayer.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      const contextMenuEvent = target.expectMenu ? new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }) : null;
      if (contextMenuEvent) textLayer.dispatchEvent(contextMenuEvent);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        text: selectedText,
        contextMenuAccepted: contextMenuEvent?.defaultPrevented || false,
        menuPresent: Boolean(root.querySelector('[data-testid="reader-selection-context-menu"]')),
        globalMenuPresent: Boolean(document.querySelector('[data-testid="reader-selection-context-menu"]')),
        rangeVisible: (() => {
          const selectedBounds = range.getBoundingClientRect();
          const scrollBounds = scrollRoot.getBoundingClientRect();
          return selectedBounds.top >= scrollBounds.top && selectedBounds.bottom <= scrollBounds.bottom;
        })(),
      };
    }, { pageNumber, quote, expectMenu });
    if (expectMenu) assert.ok(selected.contextMenuAccepted && selected.menuPresent, `The app should show its PDF selection menu: ${JSON.stringify(selected)}`);
    return selected.text;
  };
  const textGeometry = async (pageNumber, quote) => panel().evaluate((root, target) => {
    const page = root.querySelector(`.pdf-page-frame[data-page-number="${target.pageNumber}"]`);
    const span = [...page.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(target.quote));
    const node = [...span.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.includes(target.quote));
    const start = node.textContent.indexOf(target.quote);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + target.quote.length);
    const rect = range.getBoundingClientRect();
    const stage = page.querySelector('.pdf-page-stage').getBoundingClientRect();
    return { page: Number(page.dataset.pageNumber), x: (rect.left - stage.left) / stage.width, y: (rect.top - stage.top) / stage.height,
      width: rect.width / stage.width, height: rect.height / stage.height };
  }, { pageNumber, quote });
  const assertOverlayMatchesText = async (id, pageNumber, quote) => {
    const mark = panel().getByTestId(`annotation-rect-${id}-0`);
    await mark.waitFor();
    const actual = await mark.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const stage = element.closest('.pdf-page-stage').getBoundingClientRect();
      return { page: Number(element.closest('.pdf-page-frame').dataset.pageNumber),
        x: (rect.left - stage.left) / stage.width, y: (rect.top - stage.top) / stage.height,
        width: rect.width / stage.width, height: rect.height / stage.height };
    });
    const expected = await textGeometry(pageNumber, quote);
    assert.equal(actual.page, pageNumber);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[key] - expected[key]) < 0.015, `Mapped ${key} should follow target text: ${actual[key]} vs ${expected[key]}`);
    }
  };

  try {
    app = await _electron.launch(options);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000));
    await openPaper();
    await panel().getByTestId('reader-side-tab-notes').click();
    await until(async () => (await notes()).notes?.length === 1, 'Initial note tab should load');

    const firstMarkdown = '# Original reading\n\nA **saved** note with [a link](https://example.test/folio).';
    await panel().getByRole('button', { name: '编辑', exact: true }).click();
    await panel().getByTestId('reader-note-editor').fill(firstMarkdown);
    await panel().getByRole('button', { name: '保存', exact: true }).click();
    await until(async () => (await notes()).text === firstMarkdown, 'First Markdown note should save to the backend');
    const firstNoteId = (await notes()).active_note_id;

    await panel().getByRole('button', { name: '新建笔记' }).click();
    const secondTab = panel().getByRole('tab', { name: '笔记 2' });
    await secondTab.waitFor();
    const secondMarkdown = '# Translation page\n\n- Mono PDF target: page 3\n- Draft survives restart.';
    await panel().getByRole('button', { name: '编辑', exact: true }).click();
    await panel().getByTestId('reader-note-editor').fill(secondMarkdown);
    await panel().getByRole('button', { name: '保存', exact: true }).click();
    await until(async () => (await notes()).text === secondMarkdown, 'Second Markdown note should save to the backend');
    let noteState = await notes();
    const secondNoteId = noteState.active_note_id;
    assert.notEqual(firstNoteId, secondNoteId);
    assert.equal(noteState.notes.length, 2);

    await panel().getByRole('tab', { name: '笔记 1' }).click();
    await panel().getByRole('heading', { name: 'Original reading' }).waitFor();
    assert.equal((await notes()).active_note_id, firstNoteId);
    await panel().getByRole('tab', { name: '笔记 2' }).click();
    await panel().getByRole('heading', { name: 'Translation page' }).waitFor();
    assert.equal((await notes()).active_note_id, secondNoteId);

    const upper = panel().locator('.reader-notes-upgrade-upper');
    const beforeResize = await upper.boundingBox();
    const splitter = panel().getByRole('separator', { name: '调整笔记与批注区域高度' });
    const splitBox = await splitter.boundingBox();
    assert.ok(beforeResize && splitBox);
    await main.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
    await main.mouse.down();
    await main.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2 + 80, { steps: 6 });
    await main.mouse.up();
    const resizedUpper = await upper.boundingBox();
    assert.ok(resizedUpper && resizedUpper.height >= beforeResize.height + 50, 'Dragging the splitter should resize the note pane');
    const savedSplit = await main.evaluate(id => JSON.parse(localStorage.getItem(`paper-workbench.reader-notes-split.v1.${id}`)), paperId);
    assert.ok(Math.abs(savedSplit.upperHeight - resizedUpper.height) < 3, 'The dragged split height should persist locally');
    assert.deepEqual((await notes()).notes.map(note => note.text), [firstMarkdown, secondMarkdown]);
    checks.push('Two Markdown note tabs save, switch, render, and resize independently');

    await app.close();
    app = await _electron.launch(options);
    main = await app.firstWindow();
    main.on('pageerror', error => errors.push(error.message));
    await main.getByTestId('library-tab').waitFor();
    if (await main.getByTestId(`reader-tab-panel-${paperId}`).count() === 0) await openPaper();
    await panel().getByTestId('reader-side-tab-notes').click();
    await panel().getByRole('tab', { name: '笔记 2' }).waitFor();
    noteState = await notes();
    assert.equal(noteState.active_note_id, secondNoteId, 'The active note tab should restore after restart');
    assert.deepEqual(noteState.notes.map(note => note.text), [firstMarkdown, secondMarkdown]);
    await panel().getByRole('heading', { name: 'Translation page' }).waitFor();
    const restoredUpper = await panel().locator('.reader-notes-upgrade-upper').boundingBox();
    assert.ok(restoredUpper && Math.abs(restoredUpper.height - resizedUpper.height) < 4, 'The note split should restore after restart');
    await main.screenshot({ path: path.join(output, 'notes-tabs-markdown.png') });
    checks.push('Note tabs, active selection, Markdown, and split height survive Electron restart');

    const remoteMarkdown = '# External revision\n\nThe server changed this note outside the editor.';
    const localMarkdown = '# Local revision\n\nThe open editor has a different draft.';
    const expectedBeforeRemoteSave = noteState.notes.find(note => note.id === secondNoteId).text;
    await api(`/papers/${paperId}/notes/${secondNoteId}`, 'PUT', { text: remoteMarkdown, expected_text: expectedBeforeRemoteSave });
    await panel().getByRole('button', { name: '编辑', exact: true }).click();
    await panel().getByTestId('reader-note-editor').fill(localMarkdown);
    const mergeConflictButton = panel().getByRole('button', { name: '合并冲突版本', exact: true });
    await mergeConflictButton.waitFor({ timeout: 15000 });
    await panel().getByRole('status').filter({ hasText: '保存失败' }).waitFor();
    await mergeConflictButton.click();
    const editor = panel().getByTestId('reader-note-editor');
    await until(async () => {
      const draft = await editor.inputValue();
      return draft.includes('## 服务端版本') && draft.includes(remoteMarkdown)
        && draft.includes('## 本地草稿') && draft.includes(localMarkdown);
    }, 'Conflict recovery should retain the latest server text and local draft');
    const mergedMarkdown = await editor.inputValue();
    assert.ok(mergedMarkdown.includes('## 服务端版本'));
    assert.ok(mergedMarkdown.includes(remoteMarkdown));
    assert.ok(mergedMarkdown.includes('## 本地草稿'));
    assert.ok(mergedMarkdown.includes(localMarkdown));
    assert.match(await panel().getByRole('alert').textContent(), /自动保存已暂停/);
    const manualSave = panel().getByRole('button', { name: '保存', exact: true });
    assert.equal(await manualSave.isDisabled(), false, 'The merged draft should be saved only by an explicit user action');
    await manualSave.click();
    await until(async () => (await notes()).text === mergedMarkdown, 'The reviewed merged note should save to the backend');
    await panel().getByRole('tab', { name: '笔记 1' }).click();
    await panel().getByRole('heading', { name: 'Original reading' }).waitFor();
    await panel().getByRole('tab', { name: '笔记 2' }).click();
    await panel().getByRole('heading', { name: '服务端版本' }).waitFor();
    await until(async () => (await notes()).text === mergedMarkdown, 'The merged note should remain after switching tabs');
    await panel().getByRole('button', { name: '编辑', exact: true }).click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), mergedMarkdown);
    checks.push('A real backend 409 offers conflict recovery, preserves both Markdown versions, then saves and switches cleanly');

    await panel().getByRole('button', { name: '原文 PDF', exact: true }).click();
    await panel().locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"] .textLayer span').first().waitFor();
    const sourceQuote = 'ZORVEX-Q7 assay';
    await setPage(1);
    assert.equal(await selectSnippet(1, sourceQuote), sourceQuote);
    await panel().getByTestId('reader-selection-context-menu').getByRole('button', { name: '高亮', exact: true }).click();
    await panel().getByTestId('reader-selection-context-menu').getByRole('button', { name: '蓝色高亮', exact: true }).click();
    await until(async () => (await annotations()).length === 1, 'Original PDF highlight should save');
    const originalHighlight = (await annotations())[0];
    assert.equal(originalHighlight.pdf_kind, 'original');
    assert.equal(originalHighlight.selected_text, sourceQuote);

    await setPage(2);
    const manualSource = 'MANUAL-ORIGINAL-ANCHOR';
    assert.equal(await selectSnippet(2, manualSource), manualSource);
    await panel().getByTestId('reader-selection-context-menu').getByRole('button', { name: '批注', exact: true }).click();
    await panel().getByLabel('批注内容', { exact: true }).fill('Manual association test note.');
    await panel().getByRole('button', { name: '保存批注', exact: true }).click();
    await until(async () => (await annotations()).length === 2, 'Manual-link annotation should save');
    const manualAnnotation = (await annotations()).find(item => item.comment.includes('Manual association'));
    assert.ok(manualAnnotation);
    assert.equal(manualAnnotation.pdf_kind, 'original');
    checks.push('Annotations are created from real source PDF text selections');

    await panel().getByRole('button', { name: '双语对照', exact: true }).click();
    await setPage(1);
    await panel().locator('.pdf-page-frame[data-page-number="1"][data-rendered="true"] .textLayer span').first().waitFor();
    await assertOverlayMatchesText(originalHighlight.id, 1, sourceQuote);
    const highlightRow = panel().getByTestId(`reader-annotation-${originalHighlight.id}`);
    await until(async () => await highlightRow.locator('.annotation-view-links span').nth(2).getAttribute('class') === 'linked', 'Exact source quote should map into the bilingual text layer');
    checks.push('Original quote automatically maps to measured bilingual PDF highlight geometry');

    await panel().getByRole('button', { name: '中文 PDF', exact: true }).click();
    await panel().locator('.pdf-scroll[data-pdf-kind="mono"]').waitFor();
    await until(async () => await panel().locator('.page-stepper > span').textContent() === '/ 3', 'Chinese PDF should finish loading before page navigation');
    await setPage(3);
    await panel().locator('.pdf-page-frame[data-page-number="3"][data-rendered="true"] .textLayer span').first().waitFor();
    const targetTranslation = '独特译段：ZORVEX-Q7 量化 LANTERN-48 的钴响应。';
    const paragraphMarker = panel().getByTestId(`paragraph-annotation-marker-${originalHighlight.id}`);
    await paragraphMarker.waitFor();
    assert.equal(await paragraphMarker.evaluate(element => Number(element.closest('.pdf-page-frame').dataset.pageNumber)), 3);
    assert.ok(await paragraphMarker.boundingBox(), 'Chinese paragraph mapping should produce a visible page marker');
    const highlightViews = panel().getByTestId(`reader-annotation-${originalHighlight.id}`).locator('.annotation-view-links span');
    assert.equal(await highlightViews.nth(1).getAttribute('class'), 'linked', 'The Chinese view should be marked as linked');
    await setPage(1);
    await panel().getByTestId(`reader-annotation-${originalHighlight.id}`).getByRole('button', { name: '跳到此处', exact: true }).click();
    await until(async () => await panel().getByLabel('当前页码').inputValue() === '3', 'Paragraph location should navigate to the actual third mono PDF page');
    checks.push('A source quotation locates its Chinese translated paragraph on mono PDF page 3');

    await panel().getByRole('button', { name: '双语对照', exact: true }).click();
    await setPage(2);
    const manualRow = panel().getByTestId(`reader-annotation-${manualAnnotation.id}`);
    await manualRow.getByRole('button', { name: '手动关联当前视图' }).waitFor();
    assert.equal(manualAnnotation.view_contexts.dual, undefined, 'The manual target should not be pre-linked');
    await manualRow.getByRole('button', { name: '手动关联当前视图' }).click();
    const manualTarget = 'MANUAL-BILINGUAL-DESTINATION';
    assert.equal(await selectSnippet(2, manualTarget, false), manualTarget);
    const confirmLink = panel().getByRole('button', { name: '确认关联', exact: true });
    await confirmLink.waitFor();
    await confirmLink.click();
    await until(async () => {
      const saved = (await annotations()).find(item => item.id === manualAnnotation.id);
      return saved?.view_contexts?.dual?.selected_text === manualTarget;
    }, 'Manual selection should persist as the bilingual view context');
    const linkedManual = (await annotations()).find(item => item.id === manualAnnotation.id);
    assert.equal(linkedManual.view_contexts.dual.page_no, 2);
    assert.ok(linkedManual.view_contexts.dual.rects.length);
    await assertOverlayMatchesText(manualAnnotation.id, 2, manualTarget);
    await main.screenshot({ path: path.join(output, 'annotation-dual.png') });
    checks.push('Manual association saves measured target-view selection and renders its highlight');

    assert.deepEqual(errors, [], `Electron page errors: ${errors.join('; ')}`);
    const screenshots = ['notes-tabs-markdown.png', 'annotation-dual.png'];
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ paperId, checks, errors, screenshots }, null, 2));
    console.log(JSON.stringify({ output, paperId, checks, errors, screenshots }));
  } catch (error) {
    if (main) await main.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    throw error;
  } finally {
    if (app) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
