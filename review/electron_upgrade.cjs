const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createAgentFixture } = require('./fixture_agent_api.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', 'electron-upgrade-' + Date.now() + '-' + process.pid);
const data = path.join(output, 'data');
const python = path.join(root, '.venv/Scripts/python.exe');
const env = {
  ...process.env,
  WORKBENCH_DATA_DIR: data,
  WORKBENCH_CREDENTIAL_ROOT: path.join(output, 'credentials'),
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'),
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

const seeded = spawnSync(python, ['-B', '-m', 'review.seed_reader_fixture', data], { cwd: root, env, encoding: 'utf8' });
assert.equal(seeded.status, 0, seeded.stderr);
const { paper_id: paperId } = JSON.parse(seeded.stdout.trim());

const pdfPath = path.join(output, 'two-page-attachment.pdf');
const pdfSource = [
  'import sys',
  'from reportlab.pdfgen import canvas',
  'document = canvas.Canvas(sys.argv[1], pagesize=(612, 792), pageCompression=0)',
  'document.setFont("Helvetica", 14)',
  'document.drawString(54, 720, "QA PDF PAGE ONE TOKEN")',
  'document.showPage()',
  'document.setFont("Helvetica", 14)',
  'document.drawString(54, 720, "QA PDF PAGE TWO TOKEN")',
  'document.showPage()',
  'document.save()',
].join('\n');
const pdfCreated = spawnSync(python, ['-B', '-c', pdfSource, pdfPath], { cwd: root, env, encoding: 'utf8' });
assert.equal(pdfCreated.status, 0, pdfCreated.stderr);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

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
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();

    const api = (pathName, method = 'GET', body) => page.evaluate(input => window.workbench.request(input), {
      path: pathName,
      method,
      body,
    });
    const paperApi = (suffix, method = 'GET', body) => api('/papers/' + paperId + '/' + suffix, method, body);
    const sessions = () => paperApi('chat-sessions');
    const notes = () => paperApi('notes');
    const getAttachments = sessionId => paperApi('chat-sessions/' + sessionId + '/attachments');
    const history = sessionId => paperApi('chat?session_id=' + encodeURIComponent(sessionId));

    await api('/settings', 'PUT', {
      base_url: fixture.apiUrl,
      protocol: 'custom_chat_completions',
      model: 'deepseek-flash',
      api_key: 'review-only-upgrade-key',
    });
    await api('/settings/models', 'PUT', { models: ['deepseek-flash', 'fixture-basic'] });
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    const reader = page.getByTestId('reader-tab-panel-' + paperId);
    await reader.getByLabel('当前页码').waitFor();
    await reader.getByTestId('reader-side-tab-chat').click();
    const firstSession = (await sessions())[0].id;
    const panelFor = id => reader.locator('.chat-session-content[data-session-id="' + id + '"]');
    const panel = panelFor(firstSession);
    await panel.getByLabel('向当前文献提问').waitFor();

    const openModelMenu = async targetPanel => {
      const menu = targetPanel.getByRole('dialog', { name: '选择模型与推理强度' });
      if (!(await menu.count())) await targetPanel.locator('.chat-model-menu-trigger').click();
      return targetPanel.getByRole('dialog', { name: '选择模型与推理强度' });
    };
    const selectModel = async (targetPanel, model) => {
      const menu = await openModelMenu(targetPanel);
      await menu.getByRole('button', { name: model, exact: true }).click();
      await until(async () => (await targetPanel.locator('.chat-model-menu-trigger').getAttribute('aria-label')).includes(model),
        'Model should switch to ' + model);
    };
    const setEffortIndex = async (targetPanel, index) => {
      const menu = await openModelMenu(targetPanel);
      const slider = menu.getByRole('slider', { name: '推理强度' });
      await slider.focus();
      await slider.press('Home');
      for (let i = 0; i < index; i++) await slider.press('ArrowRight');
      await delay(80);
      return slider.getAttribute('aria-valuetext');
    };
    const sendQuestion = async (targetPanel, question, timeout = 30000) => {
      const sessionId = await targetPanel.getAttribute('data-session-id');
      assert.ok(sessionId, 'Chat panel should identify its session');
      await targetPanel.getByLabel('向当前文献提问').fill(question);
      await targetPanel.getByRole('button', { name: '发送', exact: true }).click();
      await until(async () => {
        const messages = await history(sessionId);
        return messages.some(message => message.role === 'user' && message.content === question)
          && messages.some(message => message.role === 'assistant' && message.status === 'completed');
      }, 'Chat turn should finish: ' + question, timeout);
    };
    const waitHistory = (sessionId, predicate, message) => until(async () => predicate(await history(sessionId)), message);
    const getAction = async (sessionId, kind) => {
      await until(async () => (await paperApi('agent-actions?session_id=' + encodeURIComponent(sessionId)))
        .some(action => action.kind === kind && action.status === 'pending'), 'Pending ' + kind + ' action should appear');
      return (await paperApi('agent-actions?session_id=' + encodeURIComponent(sessionId)))
        .find(action => action.kind === kind && action.status === 'pending');
    };
    const waitActionStatus = (sessionId, actionId, status) => until(async () => {
      const actions = await paperApi('agent-actions?session_id=' + encodeURIComponent(sessionId));
      return actions.some(action => action.id === actionId && action.status === status);
    }, 'Agent action should become ' + status);

    await selectModel(panel, 'deepseek-flash');
    assert.equal(await setEffortIndex(panel, 2), '高');
    await selectModel(panel, 'fixture-basic');
    assert.equal(await panel.locator('.chat-effort-slider').getAttribute('aria-valuetext'), '默认');
    assert.equal(await setEffortIndex(panel, 2), '低');
    await selectModel(panel, 'deepseek-flash');
    assert.equal(await panel.locator('.chat-effort-slider').getAttribute('aria-valuetext'), '高');
    await selectModel(panel, 'fixture-basic');
    assert.equal(await panel.locator('.chat-effort-slider').getAttribute('aria-valuetext'), '低');
    const storedPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('paper-workbench.reasoning-preferences.v1') || '{}'));
    assert.equal(storedPreferences['deepseek-flash'].effort, 'high');
    assert.equal(storedPreferences['fixture-basic'].effort, 'low');
    checks.push('Per-model reasoning strength saves and restores independently');

    await selectModel(panel, 'deepseek-flash');
    fixture.state.reasoningDelayMs = 1000;
    const reasoningQuestion = '请解释本研究为什么使用独立样本';
    const reasoningRequestStart = fixture.requests.length;
    const reasoningSentStart = fixture.state.reasoningSent;
    await panel.getByLabel('向当前文献提问').fill(reasoningQuestion);
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await until(async () => fixture.state.reasoningSent > reasoningSentStart, 'Provider should emit a reasoning delta');
    await panel.getByTestId('streaming-answer').waitFor();
    await until(async () => (await panel.locator('.chat-message.user').filter({ hasText: reasoningQuestion }).count()) > 0,
      'The current question should appear while its answer is streaming');
    assert.ok((await panel.getByTestId('chat-messages').innerText()).includes(reasoningQuestion));
    assert.ok(!(await reader.innerText()).includes('先检查文献中的样本描述，再结合方法目的解释。'),
      'Streaming reasoning must not be shown in the chat UI');
    await panel.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    fixture.state.reasoningDelayMs = 0;
    const reasoningHistory = await history(firstSession);
    assert.ok(reasoningHistory.some(message => message.role === 'assistant' && message.reasoning.includes('先检查文献')),
      'Provider reasoning should remain in history for audit');
    assert.ok(!(await reader.innerText()).includes('先检查文献中的样本描述，再结合方法目的解释。'),
      'Persisted reasoning must remain hidden from the chat UI');
    const reasoningRequest = fixture.requests.slice(reasoningRequestStart).find(request => request.stream && request.model === 'deepseek-flash');
    assert.ok(reasoningRequest);
    assert.equal(reasoningRequest.reasoning_effort, 'high');
    checks.push('The live question appears before completion while its reasoning text remains hidden');

    await selectModel(panel, 'fixture-basic');
    await setEffortIndex(panel, 0);
    const noThinkingQuestion = '回答普通问题时不需要启用推理';
    const noThinkingStart = fixture.requests.length;
    const completedAnswers = panel.locator('.chat-message.assistant:not(.active-chat-stream) .message-content');
    const completedAnswersBefore = await completedAnswers.count();
    await sendQuestion(panel, noThinkingQuestion);
    const noThinkingRequest = fixture.requests.slice(noThinkingStart).find(request => request.stream && request.model === 'fixture-basic');
    assert.ok(noThinkingRequest);
    assert.equal(noThinkingRequest.reasoning_effort, undefined);
    assert.equal(noThinkingRequest.thinking, undefined);
    const noThinkingHistory = await history(firstSession);
    assert.equal(noThinkingHistory.filter(message => message.role === 'assistant').at(-1).reasoning, '');
    await until(async () => (await completedAnswers.count()) > completedAnswersBefore
      && await panel.locator('.active-chat-stream').count() === 0,
    'The latest answer should finish rendering in chat history');
    const completedAnswer = completedAnswers.last();
    assert.equal(await completedAnswer.evaluate(element => getComputedStyle(element).fontSize), '16px');
    await setEffortIndex(panel, 2);
    checks.push('Default reasoning sends no thinking parameters and assistant text remains at least 16px');

    const nav = panel.getByRole('navigation', { name: '对话问题导航' });
    await nav.waitFor();
    const chatMessages = panel.getByTestId('chat-messages');
    for (let i = 0; i < 6; i++) {
      const dimensions = await chatMessages.evaluate(element => ({ height: element.scrollHeight, viewport: element.clientHeight }));
      if (dimensions.height > dimensions.viewport + 40) break;
      await sendQuestion(panel, '导航长问题 ' + i + '：' + '请分析实验设计、样本选择、统计前提和结论边界，'.repeat(12));
    }
    const secondMark = nav.getByRole('button', { name: '跳到问题：' + noThinkingQuestion });
    await secondMark.waitFor();
    const beforeJump = await chatMessages.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return element.scrollTop;
    });
    assert.ok(beforeJump > 0, 'Question navigation fixture should overflow the chat viewport');
    await secondMark.click();
    await until(async () => await secondMark.getAttribute('aria-current') === 'location', 'Clicked question marker should become active');
    await until(async () => await chatMessages.evaluate(element => element.scrollTop) < beforeJump - 20,
      'Question navigation should scroll the chat to its earlier turn');
    await panel.getByRole('button', { name: '回到最新 ↓' }).click();
    checks.push('Question navigation jumps to an earlier chat turn and returns to the latest');

    await reader.getByTestId('reader-side-tab-notes').click();
    await reader.getByRole('button', { name: '新建笔记', exact: true }).click();
    await until(async () => (await notes()).notes.length === 2, 'Second note should be created');
    const firstTwoNotes = (await notes()).notes;
    const firstNote = firstTwoNotes[0];
    const secondNote = firstTwoNotes[1];
    assert.equal((await notes()).active_note_id, secondNote.id);
    await reader.getByTestId('reader-side-tab-chat').click();

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p3sAAAAASUVORK5CYII=', 'base64');
    const pdfBuffer = fs.readFileSync(pdfPath);
    const attachmentFiles = [
      { name: 'qa-image.png', mimeType: 'image/png', buffer: png },
      { name: 'qa-text.txt', mimeType: 'text/plain', buffer: Buffer.from('QA TXT CONTENT TOKEN', 'utf8') },
      { name: 'qa-two-pages.pdf', mimeType: 'application/pdf', buffer: pdfBuffer },
    ];
    await panel.getByLabel('选择图片或文件').setInputFiles(attachmentFiles);
    for (const file of attachmentFiles) {
      const card = panel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: file.name });
      await card.waitFor();
      await until(async () => !(await card.innerText()).includes('正在上传'), file.name + ' should finish uploading');
      assert.ok(await card.isVisible());
    }
    const preSendAttachments = await getAttachments(firstSession);
    assert.equal(preSendAttachments.length, 3);
    assert.equal(preSendAttachments.find(item => item.name === 'qa-two-pages.pdf').page_count, 2);
    const attachmentQuestion = '请结合这些附件说明实验设计';
    await sendQuestion(panel, attachmentQuestion);
    const attachmentHistory = await history(firstSession);
    const userMessage = attachmentHistory.find(message => message.role === 'user' && message.content === attachmentQuestion);
    assert.equal(userMessage.attachments.length, 3);
    assert.equal(userMessage.attachments.find(item => item.name === 'qa-two-pages.pdf').page_count, 2);
    const attachmentRequest = fixture.requests.slice().reverse().find(request => request.stream && request.messages.at(-1)?.role === 'user'
      && Array.isArray(request.messages.at(-1).content)
      && request.messages.at(-1).content.some(part => part?.text?.includes(attachmentQuestion)));
    assert.ok(attachmentRequest, 'Provider should receive multimodal content parts');
    const contentParts = attachmentRequest.messages.at(-1).content;
    assert.ok(contentParts.some(part => part.type === 'text' && part.text.includes('QA TXT CONTENT TOKEN')));
    assert.ok(contentParts.some(part => part.type === 'text' && part.text.includes('QA PDF PAGE ONE TOKEN')));
    assert.ok(contentParts.some(part => part.type === 'text' && part.text.includes('QA PDF PAGE TWO TOKEN')));
    assert.equal(contentParts.filter(part => part.type === 'image_url').length, 3,
      'One image attachment and both PDF page renders should reach the provider');
    assert.ok(contentParts.filter(part => part.type === 'image_url').some(part => part.image_url.url.startsWith('data:image/png;base64,')));

    const userCard = panel.locator('.chat-message.user').filter({ hasText: attachmentQuestion });
    const openPreview = async name => {
      await userCard.getByRole('button', { name: '预览附件：' + name }).click();
      return reader.getByRole('dialog', { name: '预览附件：' + name });
    };
    let preview = await openPreview('qa-image.png');
    const previewImage = preview.locator('img.chat-attachment-modal-image');
    await previewImage.evaluate(image => image.decode());
    assert.ok(await previewImage.evaluate(image => image.naturalWidth === 1 && image.naturalHeight === 1));
    await preview.getByRole('button', { name: '关闭预览' }).click();
    preview = await openPreview('qa-text.txt');
    await until(async () => (await preview.locator('pre.chat-attachment-modal-text').innerText()).includes('QA TXT CONTENT TOKEN'),
      'Text attachment preview should show its content');
    await preview.getByRole('button', { name: '关闭预览' }).click();
    preview = await openPreview('qa-two-pages.pdf');
    const pdfScroller = preview.getByTestId('chat-attachment-pdf-preview');
    const pdfPages = pdfScroller.locator('.chat-attachment-modal-pdf-page');
    await until(async () => {
      const pages = await pdfPages.evaluateAll(items => items.map(item => {
        const canvas = item.querySelector('canvas');
        return { pageNumber: Number(item.getAttribute('data-page-number')), rendered: canvas?.dataset.rendered === 'true' };
      }));
      return pages.length === 2 && pages.every(item => item.rendered);
    }, 'Both PDF pages should finish rendering to canvas');
    const renderedPdfPages = await pdfPages.evaluateAll(items => items.map(item => {
      const canvas = item.querySelector('canvas');
      const context = canvas?.getContext('2d');
      let inkPixels = 0;
      if (canvas && context) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)) inkPixels += 1;
        }
      }
      return {
        pageNumber: Number(item.getAttribute('data-page-number')),
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        inkPixels,
      };
    }));
    assert.deepEqual(renderedPdfPages.map(item => item.pageNumber), [1, 2]);
    assert.ok(renderedPdfPages.every(item => item.width > 0 && item.height > 0 && item.inkPixels > 0),
      'Both PDF pages should contain rendered document pixels');
    await pdfScroller.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'pdf-history-preview.png') });
    await pdfScroller.evaluate(element => {
      const pageTwo = element.querySelector('[data-page-number="2"]');
      if (pageTwo) element.scrollTop += pageTwo.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    await until(async () => pdfPages.nth(1).evaluate(element => {
      const pageBounds = element.getBoundingClientRect();
      const scrollerBounds = element.closest('.chat-attachment-modal-pdf').getBoundingClientRect();
      return pageBounds.top >= scrollerBounds.top && pageBounds.top < scrollerBounds.bottom;
    }), 'Second PDF page should be visible before its screenshot');
    await page.screenshot({ path: path.join(output, 'pdf-history-preview-page-2.png') });
    await preview.getByRole('button', { name: '关闭预览' }).click();
    checks.push('Image, TXT, and two-page PDF reach the provider and open from chat history previews');

    await reader.getByTestId('reader-side-tab-notes').click();
    const makeNoteAction = async (sessionId, targetPanel) => {
      await reader.getByTestId('reader-side-tab-chat').click();
      await sendQuestion(targetPanel, '请把研究结论保存到笔记');
      return getAction(sessionId, 'note');
    };
    const firstNoteAction = await makeNoteAction(firstSession, panel);
    const firstActionCard = panel.getByTestId('reader-agent-action-' + firstNoteAction.id);
    const targetSelect = firstActionCard.getByLabel('建议笔记保存到');
    assert.equal(await targetSelect.inputValue(), secondNote.id, 'New note suggestions should default to the selected note');
    await firstActionCard.getByTestId('reader-agent-action-confirm-' + firstNoteAction.id).click();
    await waitActionStatus(firstSession, firstNoteAction.id, 'applied');
    const afterDefault = await notes();
    assert.ok(afterDefault.notes.find(note => note.id === secondNote.id).text.includes('新增阅读笔记'));
    const firstNoteBeforeManual = afterDefault.notes.find(note => note.id === firstNote.id).text;
    const secondNoteBeforeManual = afterDefault.notes.find(note => note.id === secondNote.id).text;
    checks.push('Agent note suggestion confirms into the selected note by default');

    await reader.getByTestId('reader-side-tab-notes').click();
    await reader.getByRole('tab', { name: firstNote.title, exact: true }).click();
    await until(async () => (await notes()).active_note_id === firstNote.id, 'First note should become active');
    await reader.getByTestId('reader-side-tab-chat').click();
    const secondNoteAction = await makeNoteAction(firstSession, panel);
    const secondActionCard = panel.getByTestId('reader-agent-action-' + secondNoteAction.id);
    const overrideSelect = secondActionCard.getByLabel('建议笔记保存到');
    assert.equal(await overrideSelect.inputValue(), firstNote.id);
    await overrideSelect.selectOption(secondNote.id);
    await secondActionCard.getByTestId('reader-agent-action-confirm-' + secondNoteAction.id).click();
    await waitActionStatus(firstSession, secondNoteAction.id, 'applied');
    const afterManual = await notes();
    assert.equal(afterManual.notes.find(note => note.id === firstNote.id).text, firstNoteBeforeManual,
      'Manual destination should leave the other note unchanged');
    assert.notEqual(afterManual.notes.find(note => note.id === secondNote.id).text, secondNoteBeforeManual,
      'Manual destination should append to the selected note');
    checks.push('Agent note suggestion allows manual selection of another destination');

    const switchSession = async () => {
      const before = await sessions();
      await reader.getByRole('button', { name: '新建 AI 会话', exact: true }).click();
      await until(async () => (await sessions()).length === before.length + 1, 'New chat session should be created');
      const latest = await sessions();
      const current = latest.find(session => !before.some(item => item.id === session.id));
      assert.ok(current);
      await reader.getByTestId('chat-session-' + current.id).click();
      return current.id;
    };
    let activeSession = await switchSession();
    let activePanel = panelFor(activeSession);
    await activePanel.getByLabel('向当前文献提问').waitFor();
    await page.evaluate(() => {
      const Original = window.FileReader;
      window.__reviewOriginalFileReader = Original;
      window.FileReader = class DelayedFileReader extends Original {
        readAsDataURL(file) {
          const reader = this;
          window.setTimeout(() => Original.prototype.readAsDataURL.call(reader, file), 1400);
        }
      };
    });
    const input = activePanel.getByLabel('选择图片或文件');
    await input.setInputFiles({ name: 'remove-during-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('REMOVE UPLOAD TOKEN') });
    const removingCard = activePanel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: 'remove-during-upload.txt' });
    await removingCard.getByRole('status').waitFor();
    await removingCard.getByRole('button', { name: '移除附件：remove-during-upload.txt' }).click();
    await removingCard.waitFor({ state: 'detached' });
    await delay(1700);
    await until(async () => (await getAttachments(activeSession)).length === 0, 'Removed in-flight upload should be deleted');

    const ownershipSession = activeSession;
    const ownershipPanel = activePanel;
    await ownershipPanel.getByLabel('选择图片或文件').setInputFiles({
      name: 'session-owned-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('SESSION OWNERSHIP TOKEN'),
    });
    await ownershipPanel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: 'session-owned-upload.txt' }).getByRole('status').waitFor();
    const switchedSession = await switchSession();
    activeSession = switchedSession;
    activePanel = panelFor(switchedSession);
    await until(async () => (await getAttachments(ownershipSession)).length === 1, 'Upload should finish in its original session');
    assert.equal((await getAttachments(switchedSession)).length, 0, 'Switching sessions must not move the in-flight upload');
    await until(async () => !(await ownershipPanel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: 'session-owned-upload.txt' }).innerText()).includes('正在上传'),
      'Original session attachment should finish uploading while hidden');
    await page.evaluate(() => { window.FileReader = window.__reviewOriginalFileReader; delete window.__reviewOriginalFileReader; });
    await reader.getByTestId('chat-session-' + ownershipSession).click();
    const ownedCard = ownershipPanel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: 'session-owned-upload.txt' });
    await ownedCard.waitFor();
    await ownedCard.getByRole('button', { name: '移除附件：session-owned-upload.txt' }).click();
    await until(async () => (await getAttachments(ownershipSession)).length === 0, 'Ownership fixture upload should be removable');
    checks.push('Uploads can be removed while pending and stay with the session where they started');

    await reader.getByTestId('reader-side-tab-notes').click();
    await reader.getByRole('button', { name: '新建笔记', exact: true }).click();
    await until(async () => (await notes()).notes.length === 3, 'Temporary note should be created');
    const staleNoteId = (await notes()).active_note_id;
    await api('/papers/' + paperId + '/notes/' + staleNoteId, 'DELETE', {});
    const preservedQuestion = '预校验失败后保留问题与附件';
    await reader.getByTestId('reader-side-tab-chat').click();
    await reader.getByTestId('chat-session-' + switchedSession).click();
    const retryPanel = panelFor(switchedSession);
    await retryPanel.waitFor({ state: 'visible' });
    await retryPanel.getByLabel('选择图片或文件').setInputFiles({
      name: 'retry-after-precheck.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('RETRY ATTACHMENT TOKEN'),
    });
    const retryCard = retryPanel.locator('.chat-composer-attachments .chat-attachment-card').filter({ hasText: 'retry-after-precheck.txt' });
    await retryCard.waitFor();
    await until(async () => !(await retryCard.innerText()).includes('正在上传'), 'Retry attachment should upload before rejection test');
    await retryPanel.getByLabel('向当前文献提问').fill(preservedQuestion);
    const requestsBeforeReject = fixture.requests.length;
    await retryPanel.getByRole('button', { name: '发送', exact: true }).click();
    await retryPanel.getByRole('alert').filter({ hasText: '所选笔记不属于当前文献' }).waitFor();
    assert.equal(await retryPanel.getByLabel('向当前文献提问').inputValue(), preservedQuestion);
    assert.ok(await retryCard.isVisible(), 'Attachment should remain available for retry');
    assert.equal((await history(switchedSession)).some(message => message.content === preservedQuestion), false);
    assert.equal(fixture.requests.length, requestsBeforeReject, 'Pre-validation rejection should happen before contacting the provider');
    checks.push('Pre-validation failure preserves both the question and pending attachment');

    await reader.getByTestId('reader-side-tab-notes').click();
    await reader.getByRole('tab', { name: firstNote.title, exact: true }).click();
    await until(async () => (await notes()).active_note_id === firstNote.id, 'A valid note should be selectable after the pre-check rejection');
    await reader.getByTestId('reader-side-tab-chat').click();
    const retryQuestionCount = fixture.requests.length;
    await retryPanel.getByRole('button', { name: '发送', exact: true }).click();
    await waitHistory(switchedSession, messages => messages.some(message => message.role === 'user' && message.content === preservedQuestion),
      'Retried question should reach chat history');
    assert.ok(fixture.requests.length > retryQuestionCount);
    const retriedUser = (await history(switchedSession)).find(message => message.role === 'user' && message.content === preservedQuestion);
    assert.equal(retriedUser.attachments[0].name, 'retry-after-precheck.txt');
    checks.push('The preserved question and attachment can be retried after selecting a valid note');

    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();
    const reloadedReader = page.getByTestId('reader-tab-panel-' + paperId);
    await reloadedReader.waitFor({ state: 'visible' });
    await reloadedReader.getByLabel('当前页码').waitFor();
    await reloadedReader.getByTestId('reader-side-tab-chat').click();
    const reloadedSessions = await sessions();
    await reloadedReader.getByTestId('chat-session-' + reloadedSessions[0].id).click();
    const reloadedPanel = reloadedReader.locator('.chat-session-content[data-session-id="' + reloadedSessions[0].id + '"]');
    await reloadedPanel.waitFor({ state: 'visible' });
    await reloadedPanel.locator('.chat-model-menu-trigger').waitFor();
    await selectModel(reloadedPanel, 'fixture-basic');
    assert.equal(await reloadedPanel.locator('.chat-effort-slider').getAttribute('aria-valuetext'), '低');
    await selectModel(reloadedPanel, 'deepseek-flash');
    assert.equal(await reloadedPanel.locator('.chat-effort-slider').getAttribute('aria-valuetext'), '高');
    checks.push('Per-model reasoning preferences survive a renderer restart');

    assert.deepEqual(errors, [], 'Electron page errors: ' + errors.join('; '));
    await page.screenshot({ path: path.join(output, 'chat-final.png') });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
      paperId,
      checks,
      providerRequests: fixture.requests.length,
      errors,
    }, null, 2));
    console.log(JSON.stringify({ output, paperId, checks, providerRequests: fixture.requests.length, errors }, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    throw error;
  } finally {
    if (application) await application.close();
    await new Promise(resolve => fixture.server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
