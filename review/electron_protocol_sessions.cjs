// Native regressions for protocol settings, independent conversations and reader state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `protocol-sessions-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const temp = path.join(output, 'temp');
const credentialRoot = path.join(output, 'credential-identity');
const locationConfig = path.join(output, 'location.json');
const userProfile = path.join(output, 'user-profile');
const appData = path.join(userProfile, 'AppData', 'Roaming');
const localAppData = path.join(userProfile, 'AppData', 'Local');
for (const directory of [temp, appData, localAppData]) fs.mkdirSync(directory, { recursive: true });
const prepared = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', dataRoot, '--mixed', '--chinese'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_CREDENTIAL_ROOT: credentialRoot, WORKBENCH_LOCATION_CONFIG: locationConfig, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile, TEMP: temp, TMP: temp, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf8' });
assert.equal(prepared.status, 0, prepared.stderr);
const seeded = JSON.parse(prepared.stdout.trim());
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const chineseHash = digest(seeded.chinese);
const requests = [];
const modelRequests = [];
const upstreamRequests = [];
const settingsSnapshots = [];
const browserEvents = [];
const electronEvents = [];
const electronStderr = [];
const state = { long: false, release: false, session: null };
const delay = time => new Promise(resolve => setTimeout(resolve, time));
const server = http.createServer(async (request, response) => {
  upstreamRequests.push({ path: request.url, userAgent: request.headers['user-agent'] || '' });
  if (request.method === 'GET') {
    modelRequests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fixture-chat' }, { id: 'fixture-responses' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ path: request.url, ...body });
  const responses = request.url.includes('/responses?');
  const question = responses ? body.input.filter(item => item.role === 'user').at(-1)?.content : body.messages.filter(item => item.role === 'user').at(-1)?.content;
  const answer = `独立回答：${question}`;
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const result = { id: 'resp_fixture', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } };
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responses ? result : { choices: [{ finish_reason: 'stop', message: { content: answer } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    return;
  }
  const session = { closed: false, completed: false, count: 0 };
  state.session = session;
  response.on('close', () => { session.closed = true; });
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const chat = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (responses && question === '读取中文原文验收' && !body.input.some(entry => entry.type === 'function_call_output')) {
    event('response.completed', { response: { ...result, output: [
      { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'fixture-opaque' },
      { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'read_paper', arguments: '{"start_page":1,"end_page":2}', status: 'completed' },
    ] } });
    session.completed = true;
    response.end();
    return;
  }
  if (responses) event('response.reasoning_summary_text.delta', { delta: '这是服务返回的思考摘要。' });
  else chat({ reasoning_content: '这是服务返回的思考。' });
  const pieces = state.long ? Array.from({ length: 60 }, (_, index) => `\n\n第 ${index + 1} 段：${'生成期间可以阅读前面的内容，不应被拉回底部。'.repeat(3)}`) : [answer];
  let generated = '';
  for (let index = 0; index < pieces.length; index++) {
    if (index === 20 && state.long) while (!state.release && !response.destroyed) await delay(30);
    if (response.destroyed) return;
    const piece = pieces[index];
    generated += piece;
    if (responses) event('response.output_text.delta', { delta: piece, output_index: 0, content_index: 0, item_id: item.id });
    else chat({ content: piece });
    session.count += 1;
    await delay(state.long ? 70 : 100);
  }
  if (response.destroyed) return;
  if (responses) event('response.completed', { response: { ...result, output: [{ ...item, content: [{ type: 'output_text', text: generated, annotations: [] }] }] } });
  else { chat({}, 'stop'); response.write('data: [DONE]\n\n'); }
  session.completed = true;
  response.end();
});

(async () => {
  let application;
  let page;
  const errors = [];
  const started = Date.now();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/gateway/v1?tenant=fixture`;
    const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_CREDENTIAL_ROOT: credentialRoot, WORKBENCH_LOCATION_CONFIG: locationConfig, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile, TEMP: temp, TMP: temp };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WORKBENCH_DEV;
    const options = { cwd: root, env, timeout: 90000, executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] };
    application = await _electron.launch(options);
    const electronProcess = application.process();
    electronProcess.on('exit', (code, signal) => electronEvents.push({ type: 'exit', code, signal }));
    electronProcess.on('close', (code, signal) => electronEvents.push({ type: 'close', code, signal }));
    electronProcess.on('error', error => electronEvents.push({ type: 'error', message: error.message }));
    electronProcess.stderr?.on('data', chunk => {
      electronStderr.push(String(chunk).replaceAll('review-only-protocol-key', '[redacted synthetic key]'));
      if (electronStderr.length > 30) electronStderr.shift();
    });
    const version = await application.evaluate(({ app }) => app.getVersion());
    assert.equal(version, require('../package.json').version);
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') browserEvents.push({ type: 'console', text: message.text() }); });
    page.on('close', () => browserEvents.push({ type: 'page-close' }));
    page.on('crash', () => browserEvents.push({ type: 'page-crash' }));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#api-protocol').disabled);
    assert.equal(await page.getByLabel('API 协议').inputValue(), 'openai_chat_completions');
    assert.equal(await page.getByLabel('默认模型', { exact: true }).evaluate(node => node.tagName), 'SELECT');
    await page.getByLabel('API 基础地址').fill(baseUrl);
    await page.getByLabel('AI API Key', { exact: true }).fill('review-only-protocol-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 服务设置已保存' }).waitFor();
    const savedSettings = await page.evaluate(() => window.workbench.request({ path: '/settings' }));
    settingsSnapshots.push({ base_url: savedSettings.base_url, protocol: savedSettings.protocol, model: savedSettings.model, model_options: savedSettings.model_options, key_configured: savedSettings.key_configured });
    assert.equal(savedSettings.base_url, baseUrl);
    assert.equal(savedSettings.protocol, 'openai_chat_completions');
    assert.equal(savedSettings.key_configured, true);
    assert.equal(savedSettings.model, '');
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await page.waitForFunction(() => {
      const model = document.querySelector('#model');
      return model && !model.disabled && [...model.options].some(option => option.value === 'fixture-chat');
    }, undefined, { timeout: 15000 });
    await page.getByRole('status').filter({ hasText: '读取到 2 个模型' }).waitFor();
    assert.deepEqual(modelRequests, ['/gateway/v1/models?tenant=fixture']);
    await page.getByLabel('默认模型', { exact: true }).selectOption('fixture-chat');
    assert.equal(requests.length, 0, 'Discovering models must not send inference requests');
    await page.getByRole('checkbox', { name: 'fixture-chat', exact: true }).check();
    await page.getByRole('checkbox', { name: 'fixture-responses', exact: true }).check();
    await page.getByRole('button', { name: '添加所选模型', exact: true }).click();
    await page.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 服务连接成功' }).waitFor();
    assert.equal(requests.at(-1).path, '/gateway/v1/chat/completions?tenant=fixture');
    await page.getByLabel('API 协议').selectOption('openai_responses');
    await page.getByLabel('默认模型', { exact: true }).selectOption('fixture-responses');
    await page.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'AI 服务连接成功' }).waitFor();
    assert.equal(requests.at(-1).path, '/gateway/v1/responses?tenant=fixture');
    assert.ok(Array.isArray(requests.at(-1).input) && !requests.at(-1).messages);
    await page.screenshot({ path: path.join(output, 'settings.png') });
    await page.getByTestId('library-tab').click();

    // File drag exits from nested targets, cancellation and releases outside the list.
    const drag = async (selector, type, options = {}) => page.evaluate(({ selector, type, options }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['fixture'], 'fixture.pdf', { type: 'application/pdf' }));
      document.querySelector(selector).dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer, clientX: 400, clientY: 300, ...options }));
    }, { selector, type, options });
    await drag('.paper-title-row', 'dragenter');
    await page.locator('.drop-overlay').waitFor();
    await drag('.paper-title-row', 'dragleave', { clientX: -1 });
    await page.locator('.drop-overlay').waitFor({ state: 'hidden' });
    await drag('.paper-title-row', 'dragenter');
    await page.keyboard.press('Escape');
    await page.locator('.drop-overlay').waitFor({ state: 'hidden' });
    await drag('.paper-title-row', 'dragenter');
    await drag('.topbar', 'drop');
    await page.locator('.drop-overlay').waitFor({ state: 'hidden' });
    await page.evaluate(() => document.querySelector('.paper-title-row').dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: new DataTransfer() })));
    assert.equal(await page.locator('.drop-overlay').count(), 0, 'Dragging text must not show file import UI');

    // Verify native shell targets without opening real Explorer windows during automated QA.
    await application.evaluate(({ shell }) => {
      globalThis.__reviewLocations = [];
      shell.showItemInFolder = file => globalThis.__reviewLocations.push(file);
      shell.openPath = async folder => { globalThis.__reviewLocations.push(folder); return ''; };
    });
    await page.locator('.paper-card summary').click();
    await page.getByRole('button', { name: '打开文件位置', exact: true }).click();
    await page.getByRole('button', { name: '打开文献目录', exact: true }).click();
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas[data-page-number="1"]')?.width > 0);
    await page.getByLabel('当前页码').fill('7');
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid=pdf-scroll]');
      const frame = root?.querySelector('.pdf-page-frame[data-page-number="7"]');
      return frame && Math.abs(frame.getBoundingClientRect().top - root.getBoundingClientRect().top) < 25 && document.querySelector('.page-index.current .page-index-number')?.textContent === '7';
    });
    for (const name of ['原文 PDF', '中文 PDF', '双语对照', '原文 PDF']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.waitForFunction(kind => {
        const root = document.querySelector('[data-testid=pdf-scroll]');
        const frame = root?.querySelector('.pdf-page-frame[data-page-number="7"]');
        const bounds = frame?.getBoundingClientRect();
        return root?.dataset.pdfKind === kind && root?.scrollTop > 1000 && bounds && Math.abs(bounds.top - root.getBoundingClientRect().top) < 25;
      }, name === '原文 PDF' ? 'original' : name === '中文 PDF' ? 'mono' : 'dual');
      await page.waitForFunction(() => document.querySelector('canvas[data-page-number="7"]')?.width > 0);
      assert.equal(await page.getByLabel('当前页码').inputValue(), '7');
    }
    await page.getByRole('button', { name: '双语对照', exact: true }).click();
    await page.getByLabel('打开当前 PDF 文件位置').click();
    for (let attempt = 0; attempt < 50 && await application.evaluate(() => globalThis.__reviewLocations.length) < 3; attempt++) await delay(100);
    const locations = await application.evaluate(() => globalThis.__reviewLocations);
    assert.equal(locations.length, 3);
    assert.ok(locations.includes(path.join(dataRoot, 'papers')));
    const locatedPdfs = locations.filter(file => file.endsWith('.pdf'));
    assert.deepEqual(locatedPdfs.map(file => path.basename(file)).sort(), ['reader-source.pdf', 'review-dual.pdf']);
    for (const file of locatedPdfs) assert.ok(fs.existsSync(file));

    const activeChat = () => page.locator('.app-panel:not([hidden]) .chat-session-content:not([hidden])');
    const send = async question => { await activeChat().getByLabel('向当前文献提问').fill(question); await activeChat().getByRole('button', { name: /发送/ }).click(); };
    const sessions = () => page.evaluate(id => window.workbench.request({ path: `/papers/${id}/chat-sessions` }), seeded.paper_id);
    const initialSessions = await sessions();
    assert.equal(initialSessions.length, 1);
    await page.getByTestId(`chat-session-${initialSessions[0].id}`).waitFor();
    assert.equal(await page.locator('.chat-bound-paper').count(), 0, 'Paper title should not occupy the assistant toolbar');
    const chatMode = page.getByRole('tab', { name: '问答（AI 助手）', exact: true });
    const notesMode = page.getByRole('tab', { name: '笔记', exact: true });
    assert.equal(await page.locator('.reader-side-tabs').count(), 1, 'Only one assistant mode tablist should be rendered');
    await notesMode.focus();
    await page.keyboard.press('Enter');
    assert.equal(await notesMode.getAttribute('aria-selected'), 'true');
    await page.locator('[id^="reader-side-panel-notes-"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const transparent = 'rgba(0, 0, 0, 0)';
      return getComputedStyle(document.querySelector('[data-testid="reader-side-tab-chat"]')).borderBottomColor === transparent
        && getComputedStyle(document.querySelector('[data-testid="reader-side-tab-notes"]')).borderBottomColor !== transparent;
    });
    const modeUnderlines = await page.evaluate(() => ({
      chat: getComputedStyle(document.querySelector('[data-testid="reader-side-tab-chat"]')).borderBottomColor,
      notes: getComputedStyle(document.querySelector('[data-testid="reader-side-tab-notes"]')).borderBottomColor,
    }));
    assert.equal(modeUnderlines.chat, 'rgba(0, 0, 0, 0)', 'Q&A must not show the active underline in Notes mode');
    assert.notEqual(modeUnderlines.notes, 'rgba(0, 0, 0, 0)', 'Notes must be the only mode with an active underline');
    await page.getByTestId(`chat-session-${initialSessions[0].id}`).click();
    assert.equal(await chatMode.getAttribute('aria-selected'), 'true');
    await notesMode.focus();
    await page.keyboard.press('Enter');
    assert.equal(await notesMode.getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '新建 AI 会话', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-session-tab').length === 2);
    const noteModeSessions = await sessions();
    const noteModeCreated = noteModeSessions.find(session => session.id !== initialSessions[0].id);
    assert.ok(noteModeCreated);
    assert.equal(await chatMode.getAttribute('aria-selected'), 'true', 'Creating a session from Notes must switch back to Q&A');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: `删除会话 ${noteModeCreated.title}`, exact: true }).click();
    await page.getByTestId(`chat-session-${noteModeCreated.id}`).waitFor({ state: 'hidden' });
    assert.equal((await sessions()).length, 1);
    await page.locator('.chat-session-content:not([hidden]) .chat-composer').waitFor();
    const assistantMetrics = () => page.evaluate(() => {
      const toolbar = document.querySelector('.chat-session-bar');
      const column = toolbar?.closest('.chat-column');
      const modeTabs = toolbar?.querySelector('.reader-side-tabs');
      const sessionTabs = toolbar?.querySelector('.chat-session-tabs');
      const addSession = toolbar?.querySelector('.chat-session-new');
      const composer = document.querySelector('.chat-session-content:not([hidden]) .chat-composer');
      const centerY = node => {
        const rect = node.getBoundingClientRect();
        return (rect.top + rect.bottom) / 2;
      };
      const toolbarRect = toolbar.getBoundingClientRect();
      const addRect = addSession.getBoundingClientRect();
      const addIcon = addSession.querySelector('svg');
      const addIconRect = addIcon.getBoundingClientRect();
      const plusPathBox = addIcon.querySelector('path').getBBox();
      const viewBox = addIcon.viewBox.baseVal;
      const modeIconSizes = [...modeTabs.querySelectorAll('svg')].map(svg => {
        const rect = svg.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const composerRect = composer.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      return {
        toolbarWidth: toolbarRect.width,
        columnWidth: column.clientWidth,
        addGap: addRect.left - sessionTabs.getBoundingClientRect().right,
        addRightGap: toolbarRect.right - addRect.right,
        addWidth: addRect.width,
        addHeight: addRect.height,
        rowCenters: [centerY(modeTabs), centerY(sessionTabs), centerY(addSession)],
        modeTabsFit: modeTabs.scrollWidth <= modeTabs.clientWidth + 1,
        modeIconSizes,
        addDisplay: getComputedStyle(addSession).display,
        addPlaceItems: getComputedStyle(addSession).placeItems,
        plusPathCenterDelta: {
          x: plusPathBox.x + plusPathBox.width / 2 - viewBox.x - viewBox.width / 2,
          y: plusPathBox.y + plusPathBox.height / 2 - viewBox.y - viewBox.height / 2,
        },
        addIconCenterDelta: {
          x: (addIconRect.left + addIconRect.right - addRect.left - addRect.right) / 2,
          y: (addIconRect.top + addIconRect.bottom - addRect.top - addRect.bottom) / 2,
        },
        toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
        sessionScrollWidth: sessionTabs.scrollWidth,
        sessionClientWidth: sessionTabs.clientWidth,
        composerBottomMargin: composer && getComputedStyle(composer).marginBottom,
        composerBottomGap: columnRect.bottom - composerRect.bottom,
      };
    });
    const chatResizer = page.getByTestId('chat-resizer');
    assert.equal(await chatResizer.getAttribute('aria-valuenow'), '470');
    const assistantLayout = await assistantMetrics();
    assert.ok(Math.abs(assistantLayout.toolbarWidth - assistantLayout.columnWidth) <= 1, `Assistant toolbar should fill the column: ${JSON.stringify(assistantLayout)}`);
    assert.ok(assistantLayout.addGap >= 0 && assistantLayout.addGap <= 12, `New-session button should sit beside the session tabs: ${JSON.stringify(assistantLayout)}`);
    assert.ok(Math.abs(assistantLayout.addRightGap - 8) <= 1, `New-session button should sit at the toolbar right inset: ${JSON.stringify(assistantLayout)}`);
    assert.equal(assistantLayout.addWidth, 32);
    assert.equal(assistantLayout.addHeight, 32);
    assert.equal(assistantLayout.addDisplay, 'grid');
    assert.equal(assistantLayout.addPlaceItems, 'center');
    assert.ok(Math.abs(assistantLayout.addIconCenterDelta.x) <= 0.5 && Math.abs(assistantLayout.addIconCenterDelta.y) <= 0.5, `Plus SVG should be centered in its button: ${JSON.stringify(assistantLayout)}`);
    assert.ok(Math.abs(assistantLayout.plusPathCenterDelta.x) <= 0.5 && Math.abs(assistantLayout.plusPathCenterDelta.y) <= 0.5, `Plus path should be centered in its viewBox: ${JSON.stringify(assistantLayout)}`);
    assert.equal(assistantLayout.toolbarFits, true);
    assert.ok(Math.max(...assistantLayout.rowCenters) - Math.min(...assistantLayout.rowCenters) <= 1, `Toolbar controls should share one aligned row: ${JSON.stringify(assistantLayout)}`);
    assert.equal(assistantLayout.modeTabsFit, true);
    assert.ok(assistantLayout.modeIconSizes.length === 2 && assistantLayout.modeIconSizes.every(size => Math.abs(size.width - 20) <= 0.1 && Math.abs(size.height - 20) <= 0.1), `Q&A and Notes icons should render at 20px: ${JSON.stringify(assistantLayout.modeIconSizes)}`);
    assert.equal(assistantLayout.composerBottomMargin, '5px');
    assert.ok(assistantLayout.composerBottomGap >= 4 && assistantLayout.composerBottomGap <= 7, `Composer should sit about 5px above the chat column bottom: ${JSON.stringify(assistantLayout)}`);
    await page.screenshot({ path: path.join(output, 'assistant-layout.png') });
    await page.locator('.chat-session-bar').screenshot({ path: path.join(output, 'assistant-toolbar.png') });
    const first = initialSessions[0].id;
    state.long = true;
    state.release = false;
    await send('长回答滚动验收');
    await page.waitForFunction(() => document.querySelector('.chat-session-content:not([hidden]) [data-testid=streaming-answer]')?.textContent.includes('第 20 段'));
    const scroller = activeChat().getByTestId('chat-messages');
    const bottomGap = await scroller.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    assert.ok(bottomGap < 5, `Must initially follow the response: ${bottomGap}`);
    await scroller.hover();
    await page.mouse.wheel(0, -800);
    await activeChat().getByRole('button', { name: '回到最新 ↓', exact: true }).waitFor();
    const before = await scroller.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }));
    state.release = true;
    await page.waitForFunction(() => document.querySelector('.chat-session-content:not([hidden]) [data-testid=streaming-answer]')?.textContent.includes('第 30 段'));
    const after = await scroller.evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight }));
    assert.ok(after.height > before.height + 500);
    assert.ok(Math.abs(after.top - before.top) < 3, `Reading position moved during stream: ${JSON.stringify({ before, after })}`);
    await page.screenshot({ path: path.join(output, 'read-above-stream.png') });
    await activeChat().getByRole('button', { name: '回到最新 ↓', exact: true }).click();
    await page.waitForFunction(() => {
      const node = document.querySelector('.chat-session-content:not([hidden]) [data-testid=chat-messages]');
      return node && node.scrollHeight - node.scrollTop - node.clientHeight < 5;
    });
    await page.getByRole('button', { name: '新建 AI 会话', exact: true }).click();
    const list = await sessions();
    assert.equal(list.length, 2);
    const second = list.find(session => session.id !== first).id;
    assert.equal(await activeChat().locator('.chat-message').count(), 0, 'New session must have no old chat');
    state.long = false;
    await send('第二会话独立内容');
    await activeChat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
    await activeChat().getByText('独立回答：第二会话独立内容', { exact: true }).waitFor();
    await chatResizer.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-resizer"]')?.getAttribute('aria-valuenow') === '280');
    const narrowLayout = await assistantMetrics();
    assert.ok(Math.abs(narrowLayout.toolbarWidth - narrowLayout.columnWidth) <= 1, `Narrow assistant toolbar should fill the column: ${JSON.stringify(narrowLayout)}`);
    assert.ok(narrowLayout.addGap >= 0 && narrowLayout.addGap <= 8, `Session tabs should end before the new-session button: ${JSON.stringify(narrowLayout)}`);
    assert.ok(Math.abs(narrowLayout.addRightGap - 8) <= 1, `New-session button should stay at the right inset in a narrow column: ${JSON.stringify(narrowLayout)}`);
    assert.ok(Math.abs(narrowLayout.addIconCenterDelta.x) <= 0.5 && Math.abs(narrowLayout.addIconCenterDelta.y) <= 0.5, `Plus SVG should stay centered in a narrow column: ${JSON.stringify(narrowLayout)}`);
    assert.equal(narrowLayout.toolbarFits, true);
    assert.ok(Math.max(...narrowLayout.rowCenters) - Math.min(...narrowLayout.rowCenters) <= 1, `Narrow toolbar controls should remain on one row: ${JSON.stringify(narrowLayout)}`);
    assert.ok(narrowLayout.composerBottomGap >= 4 && narrowLayout.composerBottomGap <= 7, `Narrow composer should keep a 5px bottom gap: ${JSON.stringify(narrowLayout)}`);
    await page.getByTestId(`chat-session-${first}`).click();
    assert.equal(await page.getByTestId(`chat-session-${first}`).getAttribute('aria-selected'), 'true');
    await page.getByTestId(`chat-session-${second}`).click();
    assert.equal(await page.getByTestId(`chat-session-${second}`).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '新建 AI 会话', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.chat-session-tab').length === 3);
    const narrowSessions = await sessions();
    assert.equal(narrowSessions.length, 3);
    const third = narrowSessions.find(session => session.id !== first && session.id !== second);
    assert.ok(third);
    await page.getByTestId(`chat-session-${third.id}`).waitFor();
    const narrowScrollLayout = await assistantMetrics();
    assert.ok(narrowScrollLayout.sessionScrollWidth > narrowScrollLayout.sessionClientWidth + 1, `Multiple sessions should scroll inside their tab strip: ${JSON.stringify(narrowScrollLayout)}`);
    assert.equal(narrowScrollLayout.toolbarFits, true, `Narrow assistant toolbar should not overflow: ${JSON.stringify(narrowScrollLayout)}`);
    assert.ok(Math.abs(narrowScrollLayout.addRightGap - 8) <= 1, `New-session button should remain at the right inset: ${JSON.stringify(narrowScrollLayout)}`);
    assert.ok(Math.abs(narrowScrollLayout.addIconCenterDelta.x) <= 0.5 && Math.abs(narrowScrollLayout.addIconCenterDelta.y) <= 0.5, `Plus SVG should remain centered while sessions scroll: ${JSON.stringify(narrowScrollLayout)}`);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: `删除会话 ${third.title}`, exact: true }).click();
    await page.getByTestId(`chat-session-${third.id}`).waitFor({ state: 'hidden' });
    assert.equal((await sessions()).length, 2);
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByTestId('theme-toggle').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const darkInk = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      getComputedStyle(document.querySelector('.brand-wordmark')).color;
      getComputedStyle(document.querySelector('.chat-message.assistant .message-content')).color;
      return color;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.waitForFunction(expected => {
      const brand = document.querySelector('.brand-wordmark');
      const message = document.querySelector('.chat-message.assistant .message-content');
      const toolbar = document.querySelector('.chat-session-bar');
      return brand && message && toolbar
        && getComputedStyle(brand).color === expected
        && getComputedStyle(message).color === expected
        && getComputedStyle(toolbar).backgroundColor === 'rgb(34, 40, 38)';
    }, darkInk);
    await page.screenshot({ path: path.join(output, 'assistant-layout-dark.png') });
    await notesMode.hover();
    await page.evaluate(async () => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
    const darkHover = await notesMode.evaluate(button => {
      const tokenProbe = document.createElement('div');
      tokenProbe.style.cssText = 'position: fixed; color: var(--accent); background: var(--surface-selected)';
      document.body.append(tokenProbe);
      const tokens = getComputedStyle(tokenProbe);
      const styles = getComputedStyle(button);
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255);
        const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        const [red, green, blue] = channels.map(linear);
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const backgroundColor = styles.backgroundColor;
      const foregroundColor = styles.color;
      const tokenBackground = tokens.backgroundColor;
      const tokenForeground = tokens.color;
      const [lighter, darker] = [luminance(foregroundColor), luminance(backgroundColor)].sort((a, b) => b - a);
      tokenProbe.remove();
      return { backgroundColor, foregroundColor, tokenBackground, tokenForeground, contrastRatio: (lighter + 0.05) / (darker + 0.05) };
    });
    assert.equal(darkHover.backgroundColor, darkHover.tokenBackground, 'Dark hover should use the selected-surface theme token');
    assert.equal(darkHover.foregroundColor, darkHover.tokenForeground, 'Dark hover should use the accent theme token');
    assert.ok(darkHover.contrastRatio >= 3, `Dark mode icon hover needs at least 3:1 contrast: ${JSON.stringify(darkHover)}`);
    await page.screenshot({ path: path.join(output, 'assistant-layout-dark-hover.png') });
    await page.mouse.move(0, 0);
    if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByTestId('theme-toggle').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const narrowBox = await chatResizer.boundingBox();
    const dragX = narrowBox.x + narrowBox.width / 2;
    const dragY = narrowBox.y + narrowBox.height / 2;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX - 190, dragY, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-resizer"]')?.getAttribute('aria-valuenow') === '470');
    await page.getByTestId(`chat-session-${first}`).click();
    await activeChat().getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
    assert.ok((await activeChat().innerText()).includes('第 60 段'));
    assert.ok(!(await activeChat().innerText()).includes('第二会话独立内容'));
    await page.screenshot({ path: path.join(output, 'sessions.png') });
    await page.getByTestId(`chat-session-${second}`).click();
    const history = await page.evaluate(({ id, session }) => window.workbench.request({ path: `/papers/${id}/chat?session_id=${session}` }), { id: seeded.paper_id, session: second });
    assert.equal(history.length, 2);
    const secondRequest = requests.find(request => request.input?.some(item => item.role === 'user' && item.content === '第二会话独立内容'));
    assert.ok(secondRequest && !JSON.stringify(secondRequest.input).includes('长回答滚动验收'), 'Provider prompt must not leak another session history');

    // Chinese import reads the original PDF with no translation artifacts.
    const imported = await page.evaluate(file => window.workbench.request({ path: '/papers/import', method: 'POST', body: { paths: [file] } }), seeded.chinese);
    const chinese = imported.results[0].paper;
    assert.equal(chinese.source_language, 'zh');
    assert.equal(chinese.status, 'completed');
    assert.equal(chinese.can_read, true);
    assert.equal(chinese.mono_pdf_file_name, '');
    assert.equal(chinese.dual_pdf_file_name, '');
    assert.equal(digest(seeded.chinese), chineseHash);
    assert.equal(digest(path.join(dataRoot, 'papers', chinese.id, chinese.file_name)), chineseHash);
    await page.getByTestId('library-tab').click();
    await page.locator('.paper-card').filter({ hasText: '中文文献导入验收' }).getByRole('button', { name: '阅读', exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-testid="reader-tab-panel-${id}"] canvas`)?.width > 0, chinese.id);
    await page.locator('.reader-binding').getByText('中文原文', { exact: true }).waitFor();
    await send('读取中文原文验收');
    await activeChat().getByRole('button', { name: /停止/ }).waitFor({ state: 'hidden', timeout: 15000 });
    await activeChat().getByText('独立回答：读取中文原文验收', { exact: true }).waitFor();
    const chineseRequest = requests.find(request => request.input?.some(entry => entry.type === 'function_call_output'));
    assert.ok(chineseRequest.input.some(entry => entry.type === 'reasoning' && entry.encrypted_content === 'fixture-opaque'));
    assert.ok(chineseRequest.input.some(entry => entry.type === 'function_call' && entry.call_id === 'call_fixture'));
    assert.ok(chineseRequest.input.some(entry => entry.type === 'function_call_output' && entry.call_id === 'call_fixture' && entry.output.includes('这是一篇中文研究文献')));
    await page.getByTestId(`paper-tab-${seeded.paper_id}`).click();
    await application.close();
    application = await _electron.launch(options);
    const reopenedProcess = application.process();
    reopenedProcess.on('exit', (code, signal) => electronEvents.push({ type: 'exit', code, signal }));
    reopenedProcess.on('close', (code, signal) => electronEvents.push({ type: 'close', code, signal }));
    reopenedProcess.on('error', error => electronEvents.push({ type: 'error', message: error.message }));
    reopenedProcess.stderr?.on('data', chunk => {
      electronStderr.push(String(chunk).replaceAll('review-only-protocol-key', '[redacted synthetic key]'));
      if (electronStderr.length > 30) electronStderr.shift();
    });
    page = await application.firstWindow();
    await page.getByTestId(`chat-session-${second}`).waitFor();
    assert.equal(await page.getByTestId(`chat-session-${second}`).getAttribute('aria-selected'), 'true');
    await activeChat().getByText('独立回答：第二会话独立内容', { exact: true }).waitFor();
    const secondName = list.find(session => session.id === second).title;
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: `删除会话 ${secondName}`, exact: true }).click();
    await page.getByTestId(`chat-session-${second}`).waitFor({ state: 'hidden' });
    assert.equal((await sessions()).length, 1);
    await activeChat().locator('.chat-message.assistant').filter({ hasText: '第 60 段' }).waitFor();
    assert.ok((await activeChat().innerText()).includes('第 60 段'));
    assert.equal((await page.evaluate(id => window.workbench.request({ path: `/papers/${id}` }), chinese.id)).status, 'completed');
    assert.equal(application.windows().length, 1);
    assert.ok(upstreamRequests.length > 0);
    assert.ok(upstreamRequests.every(request => request.userAgent === 'Folio/1.0'), JSON.stringify(upstreamRequests));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', version, seconds: (Date.now() - started) / 1000, seeded, chinese, modelRequests, requests: requests.length, upstreamRequests, locations, assistantLayout: { default470: assistantLayout, narrow280: narrowLayout }, scroll: { before, after }, first, second, errors }, null, 2));
    fs.writeFileSync(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
    console.log(JSON.stringify({ result: 'passed', output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    let windowCount = 0;
    try { windowCount = application?.windows().length || 0; } catch { /* capture diagnostics even after the main process exits */ }
    fs.writeFileSync(path.join(output, 'failure-context.json'), JSON.stringify({ modelRequests, upstreamRequests, settingsSnapshots, browserEvents, electronEvents, electronStderr, pageClosed: page?.isClosed(), windowCount }, null, 2));
    try { if (windowCount) await application.windows()[0].screenshot({ path: path.join(output, 'failure.png') }); } catch { /* preserve the original test failure */ }
    throw error;
  } finally {
    state.release = true;
    if (application) await application.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const cleanup = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_CREDENTIAL_ROOT: credentialRoot, WORKBENCH_LOCATION_CONFIG: locationConfig, APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: userProfile }, encoding: 'utf8' });
    assert.equal(cleanup.status, 0, 'Review credential cleanup failed');
  }
})();
