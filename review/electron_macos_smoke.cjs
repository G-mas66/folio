'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const runRoot = path.resolve(process.env.RUNNER_TEMP || process.cwd(), 'folio-macos-smoke');
const reportPath = path.join(runRoot, `smoke-${process.env.MAC_ARCH || 'unknown'}.json`);
const appPath = path.resolve(process.env.REVIEW_APP_PATH || '');
const executable = path.resolve(process.env.REVIEW_EXECUTABLE || '');
const arch = process.env.MAC_ARCH;
const expectedArch = arch === 'x64' ? 'x86_64' : arch;
const contents = path.join(appPath, 'Contents');
const resources = path.join(contents, 'Resources');
const engine = path.join(resources, 'pdf-engine', 'workbench-pdf-engine');
const backend = path.join(resources, 'backend', 'workbench-service');
const fixtureRoot = path.join(runRoot, 'review', 'fixtures');
const report = { version: require('../package.json').version, architecture: arch, checks: {}, free_translation: { status: 'not_run' } };
const sensitiveEnvironmentNames = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'WORKBENCH_API_KEY', 'WORKBENCH_FREE_API_KEY',
];

function safeEnvironment() {
  const env = { ...process.env };
  for (const name of sensitiveEnvironmentNames) delete env[name];
  for (const name of ['WORKBENCH_DATA_DIR', 'WORKBENCH_LOCATION_CONFIG', 'WORKBENCH_CREDENTIAL_ROOT', 'WORKBENCH_FREE_API_URL']) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: options.env || safeEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      }, 3000).unref();
    }, options.timeout || 60000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function commandFailure(result) {
  return `exit=${result.code}, signal=${result.signal || 'none'}, timedOut=${result.timedOut}: ${result.stderr.slice(-1000)}`;
}

function jsonEvents(text) {
  return text.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function walkFiles(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(folder, entry.name);
    return entry.isDirectory() ? walkFiles(target) : [target];
  });
}

async function waitForPaper(page, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const papers = await page.evaluate(() => window.workbench.request({ path: '/papers' }));
    if (predicate(papers)) return papers;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The imported Chinese PDF did not become readable.');
}

function createProvider() {
  const requests = [];
  const state = { streamCancelled: false };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'folio-smoke-chat' }, { id: 'folio-smoke-responses' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const lastMessage = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    requests.push({ path: request.url, model: body.model, stream: body.stream === true, hasTools: Array.isArray(body.tools), hasToolResult: body.messages?.some(message => message.role === 'tool') === true });
    if (request.url === '/v1/chat/completions' && body.stream === true) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (lastMessage?.content === '读取中文原文验收') {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_macos_smoke', type: 'function', function: { name: 'read_paper', arguments: '{"start_page":1,"end_page":1}' } }] }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        response.end('data: [DONE]\n\n');
        return;
      }
      if (lastMessage?.role === 'tool') {
        send({ choices: [{ index: 0, delta: { content: '原文证据读取完成' }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        response.end('data: [DONE]\n\n');
        return;
      }
      if (lastMessage?.content === '停止生成验收') {
        send({ choices: [{ index: 0, delta: { content: 'MACOS_STREAM_STOP_PARTIAL' }, finish_reason: null }] });
        let count = 0;
        const timer = setInterval(() => {
          if (response.destroyed || response.writableEnded) return clearInterval(timer);
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ` ${++count}` }, finish_reason: null }] })}\n\n`);
        }, 100);
        response.once('close', () => {
          clearInterval(timer);
          if (!response.writableEnded) state.streamCancelled = true;
        });
        return;
      }
      send({ choices: [{ index: 0, delta: { content: '合成翻译样本对话已完成。' }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/v1/responses') {
      response.end(JSON.stringify({ id: 'resp_macos_smoke', object: 'response', status: 'completed', output: [
        { id: 'msg_macos_smoke', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses 协议测试成功', annotations: [] }] },
      ] }));
    } else {
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Chat Completions 协议测试成功' } }] }));
    }
  });
  return { server, requests, state };
}

async function main() {
  fs.mkdirSync(runRoot, { recursive: true });
  assert.ok(['arm64', 'x64'].includes(arch), 'MAC_ARCH must be arm64 or x64.');
  assert.ok(fs.existsSync(path.join(appPath, 'Contents', 'Info.plist')), `Packaged app not found: ${appPath}`);
  assert.equal(executable, path.join(contents, 'MacOS', '阅川 Folio'), 'Smoke must launch the executable inside the packaged .app.');
  assert.ok(fs.statSync(executable).isFile(), `Packaged executable not found: ${executable}`);
  assert.ok(fs.statSync(backend).isFile() && fs.statSync(engine).isFile(), 'Frozen backend and PDF engine must be packaged.');

  const resourceFiles = walkFiles(resources);
  assert.equal(resourceFiles.some(file => file.toLowerCase().endsWith('.exe')), false, 'macOS resources must not contain Windows executables.');
  for (const [name, binary] of [['app', executable], ['backend', backend], ['pdf_engine', engine]]) {
    const result = spawnSync('lipo', ['-archs', binary], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name} is not a native Mach-O binary: ${result.stderr || result.stdout}`);
    assert.ok(result.stdout.trim().split(/\s+/).includes(expectedArch), `${name} must include ${expectedArch}: ${result.stdout.trim()}`);
    report.checks[`${name}_architecture`] = result.stdout.trim();
  }
  report.checks.packaged_resources = { app: appPath, windows_executables: 0 };

  const env = safeEnvironment();
  env.TMPDIR = runRoot;
  env.TEMP = runRoot;
  env.TMP = runRoot;
  env.WORKBENCH_CREDENTIAL_ROOT = path.join(runRoot, 'app-keychain-identity');
  env.PYTHONPATH = root;
  const generatedApiKey = `folio-macos-smoke-${crypto.randomUUID()}`;

  const python = process.env.FOLIO_MAC_SMOKE_PYTHON;
  assert.ok(python && fs.existsSync(python), 'FOLIO_MAC_SMOKE_PYTHON must point to the isolated macOS Python environment.');
  const keychainEnv = { ...env,
    WORKBENCH_DATA_DIR: path.join(runRoot, 'keychain-check-data'),
    WORKBENCH_CREDENTIAL_ROOT: path.join(runRoot, 'keychain-check-identity'),
    WORKBENCH_LOCATION_CONFIG: path.join(runRoot, 'keychain-check-config.json'),
  };
  const keychainCode = [
    'import json, keyring, uuid',
    'from keyring.backends.macOS import Keyring',
    'from backend.ai import credential_service',
    'service = credential_service()',
    'assert isinstance(keyring.get_keyring(), Keyring), type(keyring.get_keyring()).__name__',
    'user = "macos-smoke-" + uuid.uuid4().hex',
    'secret = "temporary-non-secret-keychain-check"',
    'try:',
    '    keyring.set_password(service, user, secret)',
    '    assert keyring.get_password(service, user) == secret, "Keychain round-trip failed"',
    'finally:',
    '    if keyring.get_password(service, user) is not None: keyring.delete_password(service, user)',
    'print(json.dumps({"status":"ok","backend":"macOS Keychain","round_trip":"passed","temporary_entry_removed":True}))',
  ].join('\n');
  const keychain = await run(python, ['-c', keychainCode], { env: keychainEnv, timeout: 60000 });
  assert.equal(keychain.code, 0, `macOS Keychain initialization failed: ${keychain.stderr.slice(-1200)}`);
  report.checks.keychain = JSON.parse(keychain.stdout.trim().split(/\r?\n/).at(-1));

  const engineEnv = { ...env,
    WORKBENCH_PDF_ENGINE_ASSETS: path.join(resources, 'pdf-engine-assets', 'babeldoc'),
    WORKBENCH_PDF_ENGINE_HOME: path.join(runRoot, 'engine-runtime'),
  };
  const engineTest = await run(engine, ['--self-test'], { env: engineEnv, timeout: 240000 });
  const engineTestEvents = jsonEvents(engineTest.stdout);
  assert.equal(engineTest.code, 0, `Packaged PDF engine self-test failed: ${engineTest.stderr.slice(-1500)} ${engineTest.stdout.slice(-1500)}`);
  assert.ok(engineTestEvents.some(event => event.type === 'self_test' && event.status === 'ok'), 'PDF engine did not report successful heavy-import self-test.');
  report.checks.pdf_engine_self_test = 'passed';

  const generated = await run(python, ['-m', 'review.make_review_pdfs'], {
    env: { ...env, WORKBENCH_REVIEW_ROOT: path.join(runRoot, 'review'), WORKBENCH_REVIEW_FIXTURES_DIR: fixtureRoot },
    timeout: 60000,
  });
  assert.equal(generated.code, 0, `Synthetic PDF generation failed: ${generated.stderr.slice(-1000)}`);
  const chinesePdf = path.join(fixtureRoot, 'macos_chinese_original.pdf');
  const translationPdf = path.join(fixtureRoot, 'macos_translation_sample.pdf');
  assert.ok(fs.existsSync(chinesePdf) && fs.existsSync(translationPdf), 'Synthetic smoke PDFs were not generated.');

  let application;
  const provider = createProvider();
  await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.server.address().port}/v1`;
  const browserErrors = [];
  let smokeFailure;
  try {
    application = await _electron.launch({ executablePath: executable, args: [], cwd: root, env, timeout: 60000 });
    const library = await application.firstWindow();
    library.on('pageerror', error => browserErrors.push(error.message));
    await library.getByRole('button', { name: '设置', exact: true }).waitFor();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), report.version);
    const appInfo = await library.evaluate(() => window.workbench.getAppInfo());
    const appDataRoot = await application.evaluate(({ app }) => app.getPath('appData'));
    const expectedDataRoot = path.join(appDataRoot, '阅川 Folio', 'data');
    assert.equal(path.resolve(appInfo.dataRoot), path.resolve(expectedDataRoot), 'macOS must default to user Application Support data.');
    assert.equal(path.resolve(appInfo.uiDataRoot), path.join(path.resolve(expectedDataRoot), 'electron-userData'));
    assert.equal(path.resolve(appInfo.locationConfigPath), path.join(appDataRoot, '阅川 Folio', 'config', 'location.json'));
    report.checks.default_paths = appInfo;

    await library.getByRole('button', { name: '设置', exact: true }).click();
    await library.getByLabel('API 基础地址').fill(providerUrl);
    await library.getByLabel('AI API Key', { exact: true }).fill(generatedApiKey);
    await library.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await library.getByLabel('默认模型', { exact: true }).selectOption('folio-smoke-chat');
    await library.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await library.getByRole('status').filter({ hasText: 'AI 服务连接成功' }).waitFor();
    assert.equal(provider.requests.at(-1).path, '/v1/chat/completions');
    await library.getByLabel('API 协议').selectOption('openai_responses');
    await library.getByLabel('默认模型', { exact: true }).selectOption('folio-smoke-responses');
    await library.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await library.getByRole('status').filter({ hasText: 'AI 服务连接成功' }).waitFor();
    assert.equal(provider.requests.at(-1).path, '/v1/responses');
    await library.getByLabel('API 协议').selectOption('openai_chat_completions');
    await library.getByLabel('默认模型', { exact: true }).selectOption('folio-smoke-chat');
    await library.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await library.getByRole('status').filter({ hasText: 'AI 服务连接成功' }).waitFor();
    report.checks.model_protocols = provider.requests.map(({ path, model }) => ({ path, model }));
    await library.getByTestId('library-tab').click();

    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, chinesePdf);
    await library.getByRole('button', { name: /导入文献/ }).click();
    const papers = await waitForPaper(library, items => items.some(item => item.source_name === path.basename(chinesePdf) && item.can_read));
    const paper = papers.find(item => item.source_name === path.basename(chinesePdf));
    assert.equal(paper.source_language, 'zh');
    assert.equal(paper.status, 'completed');
    assert.equal(paper.mono_pdf_file_name, '');
    assert.equal(paper.dual_pdf_file_name, '');
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(chinesePdf)).digest('hex');
    const storedPdf = path.join(appInfo.dataRoot, 'papers', paper.id, paper.file_name);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(storedPdf)).digest('hex'), sourceHash, 'Import must preserve the synthetic source PDF bytes.');
    report.checks.chinese_import = { status: 'readable_without_translation', source_sha256: sourceHash };

    await library.locator('.paper-card').filter({ hasText: path.basename(chinesePdf) }).getByRole('button', { name: '阅读', exact: true }).click();
    const reader = library;
    reader.on('pageerror', error => browserErrors.push(error.message));
    await reader.waitForFunction(id => document.querySelector(`[data-testid="reader-tab-panel-${id}"] canvas`)?.width > 0, paper.id, { timeout: 30000 });
    await reader.waitForFunction(id => {
      const canvas = document.querySelector(`[data-testid="reader-tab-panel-${id}"] canvas`);
      if (!canvas || !canvas.width || !canvas.height) return false;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pixels.length; index += 64) {
        if (pixels[index + 3] > 0 && pixels[index] < 200 && pixels[index + 1] < 200 && pixels[index + 2] < 200) return true;
      }
      return false;
    }, paper.id, { timeout: 30000 });
    report.checks.pdf_canvas = 'rendered_with_visible_ink';

    await reader.getByLabel('向当前文献提问').fill('读取中文原文验收');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.getByText('原文证据读取完成', { exact: true }).waitFor({ timeout: 30000 });
    assert.ok(provider.requests.some(item => item.hasTools));
    assert.ok(provider.requests.some(item => item.hasToolResult), 'Mock provider must receive the packaged app\'s read_paper tool result.');
    report.checks.read_paper_tool = 'passed';

    await reader.getByLabel('向当前文献提问').fill('停止生成验收');
    await reader.getByRole('button', { name: /发送/ }).click();
    await reader.waitForFunction(() => document.querySelector('[data-testid="streaming-answer"]')?.textContent.includes('MACOS_STREAM_STOP_PARTIAL'));
    await reader.getByRole('button', { name: '停止生成', exact: true }).click();
    await reader.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
    for (let attempt = 0; attempt < 50 && !provider.state.streamCancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(provider.state.streamCancelled, true, 'Stopping the answer must close the provider stream.');
    report.checks.stream_stop = 'passed';

    await reader.getByRole('tab', { name: '笔记', exact: true }).click();
    const note = `macOS smoke ${Date.now()}`;
    await reader.getByLabel('阅读笔记').fill(note);
    await reader.getByRole('button', { name: '保存笔记', exact: true }).click();
    await reader.waitForFunction(() => document.querySelector('[data-testid="reader-note-save-status"]')?.textContent === '已保存');
    const saved = await reader.evaluate(id => window.workbench.request({ path: `/papers/${id}/notes` }), paper.id);
    assert.equal(saved.text, note);
    report.checks.notes = 'saved_and_read_back';
    assert.deepEqual(browserErrors, []);
  } catch (error) {
    smokeFailure = error;
  }
  if (!smokeFailure) report.checks.application_smoke = 'passed';

  const cleanupErrors = [];
  try {
    if (application) await application.close();
  } catch (error) {
    cleanupErrors.push(`Application close failed: ${error.message}`);
  }
  try {
    provider.server.closeAllConnections();
    await new Promise((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()));
  } catch (error) {
    cleanupErrors.push(`Mock provider close failed: ${error.message}`);
  }
  try {
    const serviceResult = await run(python, ['-c', [
      'from backend.ai import credential_service',
      'print(credential_service())',
    ].join('\n')], { env, timeout: 15000 });
    assert.equal(serviceResult.code, 0, `Could not identify the temporary Keychain service: ${commandFailure(serviceResult)}`);
    const service = serviceResult.stdout.trim().split(/\r?\n/).at(-1);
    assert.match(service, /^personal-paper-workbench-[a-f0-9]{16}$/, 'Unexpected temporary Keychain service name.');
    const keychainCheck = report.checks.temporary_api_key_cleanup = { service, account: 'api-key' };
    const keychainArgs = ['-s', service, '-a', 'api-key'];
    const before = await run('security', ['find-generic-password', ...keychainArgs], { env, timeout: 15000 });
    assert.equal(before.code, 0, `The packaged app did not leave its temporary API key in Keychain: ${commandFailure(before)}`);
    keychainCheck.found = true;
    const deletion = await run('security', ['delete-generic-password', ...keychainArgs], { env, timeout: 15000 });
    assert.equal(deletion.code, 0, `Could not delete the temporary app API key from Keychain: ${commandFailure(deletion)}`);
    keychainCheck.deleted = true;
    const after = await run('security', ['find-generic-password', ...keychainArgs], { env, timeout: 15000 });
    assert.equal(after.code, 44, `Expected errSecItemNotFound after Keychain cleanup: ${commandFailure(after)}`);
    keychainCheck.verified_absent = 'errSecItemNotFound';
    report.checks.temporary_api_key_removed = true;
  } catch (error) {
    cleanupErrors.push(`Temporary API key cleanup failed: ${error.message}`);
  }
  if (cleanupErrors.length) report.cleanup_errors = cleanupErrors;
  if (smokeFailure) throw smokeFailure;
  if (cleanupErrors.length) throw new Error(`macOS smoke cleanup failed: ${cleanupErrors.join('\n')}`);

  const translationOutput = path.join(runRoot, 'free-translation-output');
  const translationHome = path.join(runRoot, 'free-translation-runtime');
  const translation = await run(engine, [translationPdf, translationOutput, translationHome], {
    env: engineEnv,
    timeout: 300000,
  });
  const translationEvents = jsonEvents(translation.stdout);
  const finish = translationEvents.find(event => event.type === 'finish');
  if (translation.code === 0 && finish) {
    const outputs = [finish.mono_pdf_path, finish.dual_pdf_path];
    assert.ok(outputs.every(file => file && fs.existsSync(file) && fs.statSync(file).size > 0), 'Free translation must emit Chinese and bilingual PDFs.');
    const verify = await run(python, ['-c', [
      'import json, sys',
      'from pypdf import PdfReader',
      'paths = json.loads(sys.argv[1])',
      'texts = ["\\n".join(page.extract_text() or "" for page in PdfReader(path).pages) for path in paths]',
      'assert all(any("\\u4e00" <= char <= "\\u9fff" for char in text) for text in texts), "translated PDFs contain no Chinese text"',
      'print(json.dumps({"status":"passed","files":len(paths)}))',
    ].join('; '), JSON.stringify(outputs)], { env, timeout: 60000 });
    assert.equal(verify.code, 0, `Translated PDF validation failed: ${verify.stderr.slice(-1200)}`);
    report.free_translation = { status: 'success', outputs: 2, validation: JSON.parse(verify.stdout.trim().split(/\r?\n/).at(-1)) };
  } else {
    const failureEvent = translationEvents.find(event => event.type === 'error');
    const detail = String(failureEvent?.message || translation.stderr || translation.stdout || translation.signal || `exit ${translation.code}`).slice(-1800);
    const external = /(?:ECONN(?:REFUSED|RESET|TIMEDOUT)|connect(?:ion)?error|cannot connect|could not connect|connection (?:refused|reset|failed)|ENOTFOUND|EAI_AGAIN|network is unreachable|name or service not known|temporary failure in name resolution|could not resolve|SSL|TLS|certificate verify failed|HTTP\s*(?:4|5)\d{2}|\b(?:429|500|502|503|504)\b|status code.*\b(?:4|5)\d{2})/i.test(detail);
    const timedOut = translation.timedOut || /\b(?:timeout|timed out|timedout)\b/i.test(detail);
    const status = timedOut ? 'translation_timeout' : external ? 'external_service_unavailable' : 'failed';
    report.free_translation = { status, ...(timedOut ? { cause: 'undetermined' } : {}), detail };
    if (!timedOut && !external) throw new Error(`Free translation smoke failed outside a recognizable external-service failure: ${detail}`);
  }

  report.result = report.free_translation.status === 'success' ? 'passed' : 'core_checks_passed_translation_unverified';
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`MACOS_SMOKE_REPORT ${reportPath}`);
  console.log(JSON.stringify(report));
}

main().catch(error => {
  report.result = 'failed';
  report.failure = String(error.stack || error).slice(-3000);
  try {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch {}
  console.error(`MACOS_SMOKE_FAIL ${error.message}`);
  console.error(`MACOS_SMOKE_REPORT ${reportPath}`);
  process.exitCode = 1;
});
