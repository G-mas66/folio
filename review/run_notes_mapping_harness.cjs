const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseUrl = process.env.HARNESS_URL || 'http://127.0.0.1:4174';

async function waitForTab(page, name) {
  await page.getByRole('tab', { name }).waitFor({ state: 'visible' });
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const failedRequests = [];
  const pageErrors = [];
  page.on('request', (request) => {
    if (request.url().includes('example.test/remote.png')) failedRequests.push(request.url());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${baseUrl}/review/pdf-text-locator-harness.html`);
    await page.waitForFunction(() => Boolean(window.pdfLocatorResults));
    const locatorResults = await page.evaluate(() => window.pdfLocatorResults);
    assert.equal(locatorResults.lineBreak.length, 1, 'quote should match once across explicit line breaks');
    assert.ok(locatorResults.lineBreak[0].rects.length >= 2, 'line-spanning quote should yield measured geometry across multiple lines');
    assert.equal(locatorResults.lineBreak[0].normalized_selected_text, 'masked marker modeling to learn contextual representations of cells.');
    assert.equal(locatorResults.ligature.length, 1, 'NFKC ligature expansion should match the ordinary spelling');
    assert.equal(locatorResults.repeated.length, 2, 'repeated quotes should report both matches so callers can reject ambiguity');
    assert.equal(locatorResults.longParagraph.full, 0, 'oversized ranges should remain rejected by the normal selection limit');
    assert.equal(locatorResults.longParagraph.short.length, 1, 'a bounded paragraph prefix should still locate a long paragraph');
    assert.ok(locatorResults.longParagraph.short[0].rects.length > 0, 'paragraph fallback should use actual DOM rects');

    await page.goto(`${baseUrl}/review/notes-panel-harness.html`);
    await page.getByRole('heading', { name: 'Reading note' }).waitFor();
    assert.equal(await page.locator('.reader-notes-upgrade-markdown img').count(), 0, 'remote markdown images must not load');
    await page.getByRole('button', { name: 'A safe link' }).click();
    assert.equal(await page.evaluate(() => window.openedExternal), 'https://example.test/paper');
    assert.deepEqual(failedRequests, []);

    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '阅读笔记 Markdown 源文' });
    const edited = '# Reading note\n\nA changed local draft survives switching tabs.';
    await editor.fill(edited);
    await page.getByRole('tab', { name: '方法理解' }).click();
    await page.getByRole('heading', { name: 'Second note' }).waitFor();
    await page.getByRole('tab', { name: '阅读笔记' }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '阅读笔记 Markdown 源文' }).inputValue(), edited, 'tab changes should preserve the selected note draft');

    const splitter = page.getByRole('separator', { name: '调整笔记与批注区域高度' });
    const upper = page.locator('.reader-notes-upgrade-upper');
    const beforeResize = await upper.boundingBox();
    const splitBox = await splitter.boundingBox();
    assert.ok(beforeResize && splitBox);
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2 + 90, { steps: 6 });
    await page.mouse.up();
    const afterResize = await upper.boundingBox();
    assert.ok(afterResize && Math.abs(afterResize.height - beforeResize.height) >= 50, 'dragging the splitter should resize the upper notes pane');
    const savedSplit = await page.evaluate(() => JSON.parse(localStorage.getItem('paper-workbench.reader-notes-split.v1.reader-notes-harness')));
    assert.ok(Math.abs(savedSplit.upperHeight - afterResize.height) < 3, 'split height should be remembered');

    await page.getByRole('button', { name: '收起笔记区域' }).click();
    await page.getByRole('button', { name: '展开笔记区域' }).click();
    await page.getByRole('textbox', { name: '阅读笔记 Markdown 源文' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '阅读笔记 Markdown 源文' }).inputValue(), edited, 'collapsing the notes pane should preserve its draft');
    await page.getByRole('button', { name: '收起批注区域' }).click();
    await page.getByRole('button', { name: '展开批注区域' }).click();
    await page.getByText('Annotation content stays in the lower pane.').waitFor();

    await page.getByRole('button', { name: '笔记操作' }).click();
    await page.getByRole('menuitem', { name: '重命名' }).click();
    await page.getByRole('textbox', { name: '笔记名称' }).fill('阅读笔记（已改名）');
    await page.getByRole('button', { name: '保存名称' }).click();
    await waitForTab(page, '阅读笔记（已改名）');
    await page.getByRole('button', { name: '新建笔记' }).click();
    await waitForTab(page, '新笔记');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '笔记操作' }).click();
    await page.getByRole('menuitem', { name: '删除笔记' }).click();
    await page.getByRole('tab', { name: '新笔记' }).waitFor({ state: 'detached' });

    assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join('; ')}`);
    console.log('Passed: source-segment matching, text-layer geometry/normalization, notes switching, external links, splitter persistence, collapse, rename, and deletion.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
