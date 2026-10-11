'use strict';

// Isolated Electron/preload/backend/bridge integration; the model provider is a local fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { _electron, chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `research-plugins-${Date.now()}`);
const data = path.join(output, 'data');
const env = { ...process.env, WORKBENCH_DATA_DIR: data, WORKBENCH_CREDENTIAL_ROOT: data,
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), APPDATA: path.join(output, 'profile'),
  LOCALAPPDATA: path.join(output, 'local-profile'), USERPROFILE: path.join(output, 'user'),
  TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8' };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_research_fixture', data], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const seeded = JSON.parse(seed.stdout.trim());
const requests = [];
let held = false;
const provider = http.createServer(async (request, response) => {
  if (request.method === 'GET') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const messages = body.messages || [];
  const question = messages.find(message => message.role === 'user' && typeof message.content === 'string')?.content || '';
  if (/停止恢复/.test(question) && !held) { held = true; await new Promise(resolve => setTimeout(resolve, 1200)); }
  const reads = messages.filter(message => message.role === 'tool' && message.name === 'read_paper');
  const images = messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
  let name, args;
  if (!reads.length) { name = 'read_paper'; args = { start_page: 1, end_page: 2 }; }
  else if (/图像/.test(question) && !images) { name = 'read_page_image'; args = { page_no: 1 }; }
  else {
    const source = JSON.parse(reads.at(-1).content).excerpts[0];
    const claim = '文献提供了研究样本的描述。';
    name = 'submit_research_answer';
    args = { answer: `${claim} [${source.source_id}]`, claims: [{ claim, support: [{ source_id: source.source_id, quote: source.text.slice(0, 100) }] }] };
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: `fixture_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
});

(async () => {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let application;
  let extensionContext;
  const errors = [], checks = [];
  try {
    application = await _electron.launch({ cwd: root, env, timeout: 90000,
      executablePath: process.env.FOLIO_REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: process.env.FOLIO_REVIEW_EXECUTABLE ? [] : ['.'] });
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();
    const api = (suffix, method, body) => page.evaluate(input => window.workbench.request(input), { path: suffix, method, body });
    const waitTask = async (id, expected = ['completed']) => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const task = (await api(`/papers/${seeded.paper_id}/research/${id}`)).task;
        if (expected.includes(task.status)) return task;
        if (['failed', 'budget_exhausted'].includes(task.status)) throw new Error(JSON.stringify(task));
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error(`Research task ${id} timed out`);
    };
    await api('/settings', 'PUT', { base_url: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`, protocol: 'custom_chat_completions', model: 'gpt-4o', api_key: 'isolated-review-key' });
    const connection = await page.evaluate(() => window.workbench.pluginConnection('token'));
    assert.equal(connection.running, true);
    assert.equal(connection.word.state, 'certificate_missing');
    const bridge = `http://127.0.0.1:${connection.port}`;
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', Origin: `chrome-extension://${'a'.repeat(32)}` };
    assert.equal((await fetch(`${bridge}/v1/literature`)).status, 401);
    assert.equal((await fetch(`${bridge}/settings`, { headers })).status, 404);
    const capture = await fetch(`${bridge}/v1/capture`, { method: 'POST', headers, body: JSON.stringify({
      title: '收藏与引用联调', authors: [{ given: 'Ada', family: 'Lovelace' }], year: 2024,
      container_title: 'Fixture Journal', volume: '2', issue: '1', pages: '1-8', source: 'local_pdf',
      pdf_name: 'review.pdf', pdf_content_base64: fs.readFileSync(seeded.source).toString('base64'),
    }) });
    assert.equal(capture.status, 200);
    const captured = await capture.json();
    assert.equal(captured.item.paper_id, seeded.paper_id);
    assert.equal(captured.pdf_import.status, 'duplicate');
    const records = await (await fetch(`${bridge}/v1/literature?q=${encodeURIComponent('收藏与引用')}`, { headers })).json();
    assert.equal(records.items.length, 1);
    assert.equal(records.items[0].csl.id, captured.item.id);
    assert.equal(records.items[0].csl.volume, '2');
    checks.push('Authenticated real bridge imports PDF, deduplicates hash and returns stable CSL metadata');
    const extensionDirectory = path.join(root, 'extensions/browser');
    extensionContext = await chromium.launchPersistentContext(path.join(output, 'chromium-extension'), {
      headless: false, executablePath: process.env.FOLIO_REVIEW_BROWSER || 'C:/Users/17919/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe',
      args: ['--no-proxy-server', `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
    });
    const worker = extensionContext.serviceWorkers()[0] || await extensionContext.waitForEvent('serviceworker');
    const pairing = await worker.evaluate(authToken => handle({ type: 'FOLIO_PAIR', token: authToken }), connection.token);
    assert.equal(pairing.paired, true);
    const documentPage = await extensionContext.newPage();
    await documentPage.route('https://papers.example.org/article', route => route.fulfill({ contentType: 'text/html', body:
      '<title>Fixture article</title><meta name="citation_title" content="Browser captured article"><meta name="citation_author" content="Grace Hopper"><meta name="citation_publication_date" content="2023"><meta name="citation_journal_title" content="Fixture Journal">' }));
    await documentPage.goto('https://papers.example.org/article');
    await documentPage.addScriptTag({ path: path.join(extensionDirectory, 'shared.js') });
    const metadata = await documentPage.evaluate(() => FolioCapture.extractPage(document, location.href));
    const browserItem = metadata.candidates?.[0] || metadata;
    const browserSaved = await worker.evaluate(item => handle({ type: 'FOLIO_CAPTURE', item, fetchPdf: false }), browserItem);
    assert.equal(browserSaved.item.title, 'Browser captured article');
    assert.equal(browserSaved.item.authors[0].family, 'Hopper');
    const browserSearch = await worker.evaluate(() => handle({ type: 'FOLIO_SEARCH', query: 'Browser captured' }));
    assert.equal(browserSearch.items.length, 1);
    checks.push('Loaded MV3 extension pairs through its real service worker, extracts real DOM metadata and saves/searches using the real Folio bridge');
    await extensionContext.close(); extensionContext = null;
    await page.evaluate(() => window.workbench.pluginConnection('rotate'));
    assert.equal((await fetch(`${bridge}/v1/literature`, { headers })).status, 401);
    checks.push('Rotating plugin credentials immediately invalidates the old credential');
    const start = async question => (await api(`/papers/${seeded.paper_id}/research`, 'POST', { question, model: 'gpt-4o', start_page: 1, end_page: 2 })).task.id;
    const initial = await waitTask(await start('解释研究样本的描述'));
    assert.equal(initial.coverage.complete, true);
    assert.deepEqual(initial.coverage.covered_pages, [1, 2]);
    assert.match(initial.answer, /\[S\d+\]/);
    assert.equal((await api(`/papers/${seeded.paper_id}/annotations`)).length, 0);
    checks.push('Research reads real PDF evidence, validates structured answer and leaves annotations unchanged');
    const stoppedId = await start('停止恢复研究样本描述');
    await waitTask(stoppedId, ['running']);
    await api(`/papers/${seeded.paper_id}/research/${stoppedId}/stop`, 'POST');
    const stopped = await waitTask(stoppedId, ['stopped']);
    await api(`/papers/${seeded.paper_id}/research/${stoppedId}/resume`, 'POST');
    const resumed = await waitTask(stoppedId);
    assert.ok(resumed.budget.model_calls >= stopped.budget.model_calls);
    checks.push('Stop/resume persists task budget and completes using existing task ID');
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    await page.getByTestId('reader-chat-mode-research').click();
    await page.getByLabel('研究问题', { exact: true }).fill('核对图像和研究样本描述');
    await page.getByRole('button', { name: '页码范围', exact: true }).click();
    const rangeInputs = page.locator('.research-range-fields input');
    await rangeInputs.nth(0).fill('1'); await rangeInputs.nth(1).fill('2');
    await page.getByRole('button', { name: '开始研究', exact: true }).click();
    await page.locator('.research-task-card[data-status="completed"]').filter({ hasText: '核对图像' }).waitFor({ timeout: 45000 });
    assert.ok(requests.some(body => body.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))));
    assert.ok(!requests.some(body => body.messages.some(message => message.role === 'tool' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))));
    checks.push('Reader renders actual original PDF page and provider receives valid user-role multimodal image');
    await page.getByTestId('reader-chat-mode-chat').click();
    const chat = page.locator('.chat-session-content:not([hidden]) .chat-messages');
    await chat.waitFor();
    const scrollStyle = await chat.evaluate(element => {
      element.scrollTop = 0;
      return { width: getComputedStyle(element).scrollbarWidth, overflow: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight };
    });
    assert.deepEqual(scrollStyle, { width: 'none', overflow: 'auto', scrollable: true });
    await page.getByRole('button', { name: '跳到问题：Navigation fixture question 5', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-session-content:not([hidden]) .chat-messages')].some(element => element.scrollTop > 0));
    checks.push('Chat hides native scrollbar while preserving scrolling and question-position navigation');
    await page.getByTestId('reader-chat-mode-research').click();
    if (!process.env.FOLIO_REVIEW_BROWSER) {
      await page.bringToFront();
      await page.screenshot({ path: path.join(output, 'research.png'), animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, modelCalls: requests.length }, null, 2));
    console.log(JSON.stringify({ output, checks }));
  } finally {
    if (extensionContext) await extensionContext.close();
    if (application) await application.close();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
