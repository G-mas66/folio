// Native Electron GUI coverage for Agent selection, location, session and action edges.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createAgentFixture } = require('./fixture_agent_api.cjs');

const root = path.resolve(__dirname, '..');
const output = process.env.AGENT_REVIEW_OUTPUT || path.join(root, '.review', `agent-edges-${Date.now()}-${process.pid}`);
const data = path.join(output, 'data');
const credentialRoot = path.join(output, 'credentials');
const locationConfig = path.join(output, 'location.json');
const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: data,
  CREDENTIAL_ROOT: credentialRoot,
  WORKBENCH_CREDENTIAL_ROOT: credentialRoot,
  LOCATION_CONFIG: locationConfig,
  WORKBENCH_LOCATION_CONFIG: locationConfig,
  APPDATA: path.join(output, 'appdata'),
  LOCALAPPDATA: path.join(output, 'localappdata'),
  USERPROFILE: path.join(output, 'userprofile'),
  TEMP: path.join(output, 'temp'),
  TMP: path.join(output, 'temp'),
  PYTHONIOENCODING: 'utf-8',
};
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'WORKBENCH_API_KEY']) delete env[key];
for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP']) fs.mkdirSync(env[key], { recursive: true });
fs.mkdirSync(output, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;

const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', data], {
  cwd: root, env, encoding: 'utf8',
});
assert.equal(seed.status, 0, seed.stderr);
const { paper_id: paperId } = JSON.parse(seed.stdout.trim());

(async () => {
  const fixture = await createAgentFixture();
  const checks = [];
  const errors = [];
  let application;
  let page;
  try {
    application = await _electron.launch({
      cwd: root,
      env,
      timeout: 90000,
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : ['.'],
    });
    page = await application.firstWindow();
    // Poll awaited API results in Node; waitForFunction treats a Promise as truthy.
    const waitForApi = async (predicate, argument, options = {}) => {
      const deadline = Date.now() + (options.timeout || 30000);
      while (Date.now() < deadline) {
        const value = await page.evaluate(predicate, argument);
        if (value) return { dispose: async () => {}, jsonValue: async () => value };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for the API condition');
    };
    page.on('pageerror', error => errors.push(error.message));
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), '1.1.0');
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();

    const api = (suffix, method = 'GET', body) => page.evaluate(input => window.workbench.request(input), {
      path: suffix.startsWith('/') ? suffix : `/papers/${paperId}/${suffix}`,
      method,
      body,
    });
    await api('/settings', 'PUT', {
      base_url: fixture.apiUrl,
      protocol: 'custom_chat_completions',
      model: 'deepseek-flash',
      api_key: 'review-only-agent-key',
    });
    await api('/settings/models', 'PUT', { models: ['deepseek-flash', 'fixture-basic'] });
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    const reader = page.getByTestId(`reader-tab-panel-${paperId}`);
    await reader.getByLabel('当前页码').waitFor();
    await reader.getByRole('button', { name: '原文 PDF', exact: true }).click();
    await reader.locator('.textLayer').filter({ hasText: '137 independent samples' }).first().waitFor();

    const waitForValue = async (selector, value) => page.waitForFunction(({ selector, value }) => {
      return [...document.querySelectorAll(selector)].some(element => element.value === value || element.textContent.trim() === value);
    }, { selector, value }, { timeout: 30000 });
    const modelSelect = reader.getByTestId('reader-model-select');
    const thinkingSelect = reader.getByTestId('reader-thinking-mode');
    const effortSelect = reader.getByTestId('reader-reasoning-effort');
    await thinkingSelect.selectOption('enabled');
    await effortSelect.selectOption('high');
    await modelSelect.selectOption('fixture-basic');
    await waitForValue('[data-testid="reader-model-name"]', 'fixture-basic');
    assert.equal(await thinkingSelect.inputValue(), 'default');
    assert.equal(await effortSelect.inputValue(), 'default');
    await thinkingSelect.selectOption('enabled');
    await effortSelect.selectOption('low');
    await modelSelect.selectOption('deepseek-flash');
    await waitForValue('[data-testid="reader-model-name"]', 'deepseek-flash');
    assert.equal(await thinkingSelect.inputValue(), 'enabled');
    assert.equal(await effortSelect.inputValue(), 'high');
    await modelSelect.selectOption('fixture-basic');
    await waitForValue('[data-testid="reader-model-name"]', 'fixture-basic');
    assert.equal(await thinkingSelect.inputValue(), 'enabled');
    assert.equal(await effortSelect.inputValue(), 'low');
    await modelSelect.selectOption('deepseek-flash');
    await waitForValue('[data-testid="reader-model-name"]', 'deepseek-flash');
    checks.push('Model switching restores each model’s thinking and reasoning settings');

    const pageInput = reader.getByLabel('当前页码');
    const setPage = async pageNo => {
      await pageInput.fill(String(pageNo));
      await pageInput.press('Enter');
      await reader.locator(`.pdf-page-frame[data-page-number="${pageNo}"][data-rendered="true"]`).waitFor();
    };
    const selectText = async (pageNo, quote, rightClick = true) => {
      const point = await reader.evaluate((element, { pageNo, quote }) => {
        const frame = document.querySelector(`.pdf-page-frame[data-page-number="${pageNo}"][data-rendered="true"]`);
        if (!frame) throw new Error(`PDF page ${pageNo} is not rendered`);
        const span = [...frame.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(quote));
        if (!span) throw new Error(`Missing fixture quote on page ${pageNo}: ${quote}`);
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        let node;
        let offset = -1;
        while ((node = walker.nextNode())) {
          offset = node.textContent.indexOf(quote);
          if (offset >= 0) break;
        }
        if (!node || offset < 0) throw new Error(`Missing text node for fixture quote: ${quote}`);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + quote.length);
        const selected = window.getSelection();
        selected.removeAllRanges();
        selected.addRange(range);
        const rect = range.getBoundingClientRect();
        frame.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, clientX: rect.left + 1, clientY: rect.top + 1,
        }));
        return { x: rect.left + Math.min(3, rect.width / 2), y: rect.top + Math.min(3, rect.height / 2) };
      }, { pageNo, quote });
      if (rightClick) {
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await reader.getByTestId('reader-selection-context-menu').waitFor();
      }
      return point;
    };
    const getSessions = () => api('chat-sessions');
    const waitForActionCard = async (sessionId, kind) => {
      const panel = reader.locator(`.chat-session-content[data-session-id="${sessionId}"]`);
      const card = panel.locator(`article.agent-action-card[data-action-kind="${kind}"]`).last();
      await card.waitFor({ timeout: 90000 });
      return card;
    };
    const actionIdFromCard = async card => (await card.getAttribute('data-testid')).replace('reader-agent-action-', '');
    const waitForActionStatus = async (actionId, status) => page.waitForFunction(({ actionId, status }) => {
      return document.querySelector(`[data-testid="reader-agent-action-${actionId}"]`)?.dataset.actionStatus === status;
    }, { actionId, status }, { timeout: 30000 });
    const waitForAnnotations = count => waitForApi(async ({ paperId, count }) => {
      return (await window.workbench.request({ path: `/papers/${paperId}/annotations` })).length === count;
    }, { paperId, count }, { timeout: 30000 });
    const sendQuestion = async (sessionId, question, kind = 'annotation') => {
      const session = reader.locator(`.chat-session-content[data-session-id="${sessionId}"]`);
      await session.getByLabel('向当前文献提问').fill(question);
      await session.getByRole('button', { name: '发送 ↑', exact: true }).click();
      return waitForActionCard(sessionId, kind);
    };

    let sessions = await getSessions();
    assert.ok(sessions.length > 0, 'The seeded paper should have a default chat session');
    const firstSession = sessions[0].id;
    const firstTab = reader.getByTestId(`chat-session-${firstSession}`);
    await firstTab.waitFor();
    await reader.getByTestId('reader-side-tab-chat').click();
    await setPage(1);
    await selectText(1, '137 independent samples');
    await reader.getByTestId('reader-ask-ai-about-selection').click();
    const firstPanel = reader.locator(`.chat-session-content[data-session-id="${firstSession}"]`);
    const association = firstPanel.getByTestId('reader-selection-association');
    await association.waitFor();
    assert.match(await association.innerText(), /137 independent samples/);
    const savedSessions = await getSessions();
    const firstContext = savedSessions.find(session => session.id === firstSession).selection_context;
    assert.equal(firstContext.page_no, 1);
    assert.ok(firstContext.selected_text.includes('137 independent samples'));
    checks.push('Right-click selection associates with the active chat session and displays its location');

    fixture.state.repeatedQuote = false;
    const linkedCard = await sendQuestion(firstSession, '请把问题和简要解释批注到这里');
    const linkedActionId = await actionIdFromCard(linkedCard);
    await linkedCard.getByTestId('reader-action-location-preview').waitFor();
    assert.match(await linkedCard.getByTestId('reader-action-location-preview').innerText(), /第 1 页[\s\S]*137 independent samples/);
    const editedDraft = '会话 A 的人工编辑草稿。';
    await linkedCard.getByTestId(`reader-agent-action-text-${linkedActionId}`).fill(editedDraft);

    await reader.getByRole('button', { name: '新建 AI 会话' }).click();
    await waitForApi(async ({ paperId, previousId }) => {
      const list = await window.workbench.request({ path: `/papers/${paperId}/chat-sessions` });
      return list.find(session => session.id !== previousId)?.id || false;
    }, { paperId, previousId: firstSession }, { timeout: 30000 });
    sessions = await getSessions();
    const secondSession = sessions.find(session => session.id !== firstSession).id;
    const secondTab = reader.getByTestId(`chat-session-${secondSession}`);
    await secondTab.click();
    const secondPanel = reader.locator(`.chat-session-content[data-session-id="${secondSession}"]`);
    await secondPanel.getByLabel('向当前文献提问').waitFor();
    assert.equal(await secondPanel.getByTestId('reader-selection-association').count(), 0);
    assert.equal(await secondPanel.getByTestId(`reader-agent-action-${linkedActionId}`).count(), 0);
    const secondDraft = '只属于会话 B 的未发送问题';
    await secondPanel.getByLabel('向当前文献提问').fill(secondDraft);
    await firstTab.click();
    assert.equal(await firstPanel.getByLabel('向当前文献提问').inputValue(), '');
    assert.match(await firstPanel.getByTestId('reader-selection-association').innerText(), /137 independent samples/);
    assert.equal(await linkedCard.getByTestId(`reader-agent-action-text-${linkedActionId}`).inputValue(), editedDraft);
    await secondTab.click();
    assert.equal(await secondPanel.getByLabel('向当前文献提问').inputValue(), secondDraft);
    await secondPanel.getByLabel('向当前文献提问').fill('');
    await firstTab.click();
    await linkedCard.getByRole('button', { name: '重新定位', exact: true }).click();
    await linkedCard.getByTestId('reader-action-location-preview').waitFor();
    const beforeLinked = await api('annotations');
    await linkedCard.getByTestId(`reader-agent-action-confirm-${linkedActionId}`).click();
    await waitForActionStatus(linkedActionId, 'applied');
    await waitForAnnotations(beforeLinked.length + 1);
    const linkedSaved = (await api('annotations')).find(annotation => !beforeLinked.some(item => item.id === annotation.id));
    assert.equal(linkedSaved.page_no, 1);
    assert.equal(linkedSaved.selected_text, firstContext.selected_text);
    assert.equal(linkedSaved.comment, editedDraft);
    checks.push('New sessions isolate selection and drafts; returning restores the prior association and edited action draft');
    checks.push('“批注到这里” action saves against the same associated PDF selection');

    fixture.state.repeatedQuote = true;
    await secondTab.click();
    const beforeRepeated = await api('annotations');
    const repeatedCard = await sendQuestion(secondSession, '找到对应原文，把问题和简要解释批注进去');
    const repeatedActionId = await actionIdFromCard(repeatedCard);
    const choice = repeatedCard.getByRole('button', { name: /位置 \d+ · 第 7 页/ }).first();
    await choice.waitFor({ timeout: 90000 });
    assert.equal(await repeatedCard.getByTestId('reader-action-location-preview').count(), 0,
      'A repeated quote without a page must remain unselected until the reader chooses a location');
    assert.equal(await repeatedCard.getByTestId(`reader-agent-action-confirm-${repeatedActionId}`).isDisabled(), true);
    const candidateLabels = await repeatedCard.locator('[data-testid^="reader-agent-action-location-"]').allTextContents();
    assert.ok(candidateLabels.length > 1);
    await choice.click();
    const repeatedPreview = repeatedCard.getByTestId('reader-action-location-preview');
    await repeatedPreview.waitFor();
    assert.match(await repeatedPreview.innerText(), /第 7 页/);
    await repeatedCard.getByTestId(`reader-agent-action-confirm-${repeatedActionId}`).click();
    await waitForActionStatus(repeatedActionId, 'applied');
    await waitForAnnotations(beforeRepeated.length + 1);
    const repeatedSaved = (await api('annotations')).find(annotation => !beforeRepeated.some(item => item.id === annotation.id));
    assert.equal(repeatedSaved.page_no, 7);
    checks.push(`Repeated identical quotes remain ambiguous until the reader chooses a page (${candidateLabels.length} visible matches)`);

    await reader.getByRole('button', { name: '新建 AI 会话' }).click();
    await waitForApi(async ({ paperId, knownIds }) => {
      const list = await window.workbench.request({ path: `/papers/${paperId}/chat-sessions` });
      return list.find(session => !knownIds.includes(session.id))?.id || false;
    }, { paperId, knownIds: [firstSession, secondSession] }, { timeout: 30000 });
    sessions = await getSessions();
    const thirdSession = sessions.find(session => ![firstSession, secondSession].includes(session.id)).id;
    const thirdTab = reader.getByTestId(`chat-session-${thirdSession}`);
    await thirdTab.click();
    const thirdPanel = reader.locator(`.chat-session-content[data-session-id="${thirdSession}"]`);
    await thirdPanel.getByLabel('向当前文献提问').waitFor();
    assert.equal(await thirdPanel.getByTestId('reader-selection-association').count(), 0);
    fixture.state.repeatedQuote = false;
    fixture.state.missingQuote = true;
    const missingCard = await sendQuestion(thirdSession, '找到对应原文，把问题和简要解释批注进去');
    const missingActionId = await actionIdFromCard(missingCard);
    const missingDraft = missingCard.getByTestId(`reader-agent-action-text-${missingActionId}`);
    await missingDraft.waitFor();
    assert.match(await missingDraft.inputValue(), /为什么使用独立样本/);
    await missingDraft.fill('引文未找到时仍保留的人工草稿。');
    const confirmMissing = missingCard.getByTestId(`reader-agent-action-confirm-${missingActionId}`);
    assert.equal(await confirmMissing.isDisabled(), true);
    assert.match(await missingCard.innerText(), /没有可自动定位的页码和引文/);
    const beforeManual = await api('annotations');
    await missingCard.getByTestId(`reader-agent-action-reselect-${missingActionId}`).click();
    const currentPage = Number(await pageInput.inputValue());
    await selectText(currentPage, 'The data generation seed was 811.', false);
    await missingCard.getByTestId('reader-action-location-preview').waitFor();
    assert.equal(await missingDraft.inputValue(), '引文未找到时仍保留的人工草稿。');
    assert.equal(await confirmMissing.isEnabled(), true);
    await confirmMissing.click();
    await waitForAnnotations(beforeManual.length + 1);
    const manuallySaved = (await api('annotations')).find(annotation => !beforeManual.some(item => item.id === annotation.id));
    assert.equal(manuallySaved.selected_text, 'The data generation seed was 811.');
    assert.equal(manuallySaved.comment, '引文未找到时仍保留的人工草稿。');
    checks.push('Not-found quotation keeps the edited draft and cannot save until manual PDF reselection');

    fixture.state.missingQuote = false;
    const notesBeforeCancel = await api('notes');
    const noteCard = await sendQuestion(thirdSession, '请把解释追加到笔记', 'note');
    const noteActionId = await actionIdFromCard(noteCard);
    assert.equal((await api('notes')).text, notesBeforeCancel.text);
    await noteCard.getByTestId(`reader-agent-action-cancel-${noteActionId}`).click();
    await waitForActionStatus(noteActionId, 'cancelled');
    assert.equal((await api('notes')).text, notesBeforeCancel.text);
    checks.push('Cancelling a note suggestion records cancellation and writes no note content');

    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'agent-edges.png') });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
      version: '1.1.0',
      packaged: Boolean(process.env.REVIEW_EXECUTABLE),
      paperId,
      checks,
      repeatedQuoteMatches: candidateLabels.length,
      providerRequests: fixture.requests.length,
      errors,
    }, null, 2));
    console.log(JSON.stringify({ output, checks, providerRequests: fixture.requests.length, errors }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, error: error.message, errors }, null, 2));
    throw error;
  } finally {
    if (application) await application.close();
    await new Promise(resolve => fixture.server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
