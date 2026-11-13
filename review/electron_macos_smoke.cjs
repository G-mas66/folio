'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const semver = require('semver');
const { _electron } = require('playwright');
const { selectMacUpdate } = require('../electron/update-service.cjs');
const { resolveLocationConfig } = require('../electron/storage-location.cjs');

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

function translationFailureStatus(detail) {
  if (/(?:certificate|CERTIFICATE_VERIFY_FAILED|\bSSL\b|\bTLS\b|TLSv\d+|CERT_(?:AUTHORITY|COMMON_NAME|DATE)_INVALID)/i.test(detail)) return 'tls_failure';
  if (/(?:\bdlopen\b|Symbol not found|Library not loaded|image not found|DLL load failed)/i.test(detail)) return 'failed';
  if (/(?:timeout|timed out|timedout)/i.test(detail)) return 'translation_timeout';
  if (/(?:ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|cannot connect|could not connect|connection (?:refused|reset|failed)|network is unreachable|name or service not known|could not resolve|HTTP\s*[45]\d{2}|\b(?:429|500|502|503|504)\b)/i.test(detail)) return 'external_service_unavailable';
  return 'failed';
}

async function smokeApi(page, input, evidence) {
  evidence.requests.push({ method: input.method || 'GET', path: input.path, at: new Date().toISOString() });
  return page.evaluate(async input => {
    const result = await window.workbench.request(input);
    return input.binary ? Array.from(result) : result;
  }, input);
}

async function waitForTranslation(page, id, evidence, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const paper = await smokeApi(page, { path: '/papers/' + id }, evidence);
    const snapshot = { status: paper.status, progress: paper.pdf_progress, error: paper.error || '', chinese_title: paper.chinese_title };
    if (JSON.stringify(evidence.states.at(-1)) !== JSON.stringify(snapshot)) evidence.states.push(snapshot);
    evidence.final_paper = paper;
    if (paper.status === 'completed') {
      assert.equal(paper.can_read, true, 'Backend completed state must expose readable translated PDFs.');
      assert.equal(paper.pdf_progress, 100);
      assert.ok(paper.mono_pdf_file_name && paper.dual_pdf_file_name, 'Backend must commit both translated PDF names.');
      return paper;
    }
    if (['error', 'waiting_api', 'needs_title', 'needs_attention', 'needs_ocr', 'stopped'].includes(paper.status)) {
      throw new Error('Backend translation stopped at ' + paper.status + ': ' + (paper.error || 'no error detail'));
    }
    assert.ok(['queued', 'translating', 'checking'].includes(paper.status), 'Unexpected backend translation status: ' + paper.status);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Packaged backend translation timed out before validated Chinese and bilingual PDFs were ready.');
}

async function checkBackendTranslation(page, source, python, env) {
  const evidence = report.free_translation = {
    status: 'running', route: 'packaged_electron_ipc_to_frozen_backend_to_packaged_engine',
    backend, engine, source_sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), cases: [],
  };
  try {
    // Import paused: no direct engine invocation and no live database edits.
    const first = { name: 'empty_chinese_title', requests: [], states: [] };
    evidence.cases.push(first);
    const imported = await smokeApi(page, { method: 'POST', path: '/papers/import', body: { paths: [source], defer_translation: true } }, first);
    assert.equal(imported.results.length, 1);
    assert.equal(imported.results[0].duplicate, false, 'Translation must not reuse outputs from a previous smoke run.');
    const initial = imported.results[0].paper;
    first.imported_paper = initial;
    assert.notEqual(initial.source_language, 'zh', 'English fixture must take the translation path.');
    assert.equal(initial.chinese_title, '');
    assert.equal(initial.mono_pdf_file_name, '');
    assert.equal(initial.dual_pdf_file_name, '');
    const id = initial.id;
    const title = initial.english_title.trim() || 'A Short Synthetic Measurement Study';
    const outputRoot = path.join(runRoot, 'backend-translation-evidence');
    fs.mkdirSync(outputRoot, { recursive: true });
    for (const [index, chineseTitle] of ['', '合成测量研究中文标题'].entries()) {
      const item = index === 0 ? first : { name: 'supplied_chinese_title', requests: [], states: [] };
      if (index) evidence.cases.push(item);
      const previous = index ? evidence.cases[0].final_paper : initial;
      // Title PATCH schedules both title-translation and prefilled-title branches.
      item.title_request = { english_title: title, chinese_title: chineseTitle };
      item.started_paper = await smokeApi(page, { method: 'PATCH', path: '/papers/' + id + '/title', body: item.title_request }, item);
      const paper = await waitForTranslation(page, id, item);
      assert.match(paper.chinese_title, /[\u4e00-\u9fff]/, 'Translated title must contain Chinese.');
      if (chineseTitle) assert.equal(paper.chinese_title, chineseTitle);
      assert.notEqual(paper.mono_pdf_file_name, previous.mono_pdf_file_name, 'A new engine run must commit fresh output names.');
      assert.notEqual(paper.dual_pdf_file_name, previous.dual_pdf_file_name);
      item.artifacts = [];
      for (const kind of ['original', 'mono', 'dual']) {
        const bytes = Buffer.from(await smokeApi(page, { path: '/papers/' + id + '/pdf?kind=' + kind, binary: true }, item));
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'Backend response must be a PDF.');
        const file = path.join(outputRoot, item.name + '-' + kind + '.pdf');
        fs.writeFileSync(file, bytes);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (kind === 'original') assert.equal(sha256, evidence.source_sha256, 'Backend must preserve source bytes.');
        item.artifacts.push({ kind, path: file, bytes: bytes.length, sha256 });
      }
      // completed + can_read is only committed after frozen backend validate_pdf_outputs.
      // Independently inspect downloaded bytes, never engine scratch files.
      const verify = await run(python, ['-c', [
        'import json, sys',
        'from pypdf import PdfReader',
        'paths = json.loads(sys.argv[1])',
        'readers = [PdfReader(p, strict=True) for p in paths]',
        'assert all(len(r.pages) == int(sys.argv[2]) for r in readers), "PDF page count mismatch"',
        'texts = ["\\n".join(p.extract_text() or "" for p in r.pages) for r in readers]',
        'assert all(any("\\u4e00" <= c <= "\\u9fff" for c in t) for t in texts[1:]), "translated PDFs contain no Chinese text"',
        'assert "137" in texts[2], "bilingual PDF lost original sample-count evidence"',
        'print(json.dumps({"status":"passed","files":len(paths),"pages":[len(r.pages) for r in readers],"chinese_in_both_outputs":True,"bilingual_original_evidence":True}))',
      ].join('; '), JSON.stringify(item.artifacts.map(file => file.path)), String(paper.page_count)], { env, timeout: 60000 });
      assert.equal(verify.code, 0, 'Backend PDF validation failed: ' + verify.stderr.slice(-1200));
      item.validation = JSON.parse(verify.stdout.trim().split(/\r?\n/).at(-1));
      item.backend_validation = 'completed_can_read_after_validate_pdf_outputs';
      item.status = 'success';
    }
    evidence.status = 'success';
    evidence.outputs = 4;
  } catch (error) {
    evidence.status = translationFailureStatus(String(error.message || error));
    evidence.detail = String(error.stack || error).slice(-2400);
    // External outages are diagnostic categories, never release-gate exceptions.
    throw new Error('Packaged backend translation release gate failed (' + evidence.status + '): ' + error.message);
  }
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
  assert.equal(executable, path.join(contents, 'MacOS', 'Folio'), 'Smoke must launch the executable inside the packaged .app.');
  assert.ok(fs.statSync(executable).isFile(), `Packaged executable not found: ${executable}`);
  assert.ok(fs.statSync(backend).isFile() && fs.statSync(engine).isFile(), 'Frozen backend and PDF engine must be packaged.');

  const updateVersion = semver.inc(report.version, 'patch');
  assert.ok(updateVersion, `Could not derive an update fixture from ${report.version}.`);
  const updateRelease = {
    tag_name: `v${updateVersion}`,
    draft: false,
    body: 'Architecture-specific manual update fixture.',
    assets: ['arm64', 'x64'].map(value => ({ name: `Folio-${updateVersion}-macOS-${value}.zip`, state: 'uploaded' })),
  };
  const selectedUpdate = selectMacUpdate([updateRelease], report.version, arch);
  assert.equal(selectedUpdate?.architecture, arch);
  assert.equal(selectedUpdate?.version, updateVersion);
  assert.equal(selectedUpdate?.downloadUrl, `https://github.com/G-mas66/folio/releases/download/v${updateVersion}/Folio-${updateVersion}-macOS-${arch}.zip`);
  const wrongArchitectureRelease = { ...updateRelease, assets: updateRelease.assets.filter(asset => !asset.name.endsWith(`-${arch}.zip`)) };
  assert.equal(selectMacUpdate([wrongArchitectureRelease], report.version, arch), null, 'macOS update selection must never fall back to the other architecture.');
  const channelRelease = (version) => ({ tag_name: `v${version}`, draft: false, assets: [{ name: `Folio-${version}-macOS-${arch}.zip`, state: 'uploaded' }] });
  const stableCurrentVersion = semver.coerce(report.version)?.version;
  assert.ok(stableCurrentVersion, `Could not derive a stable channel fixture from ${report.version}.`);
  const stableUpdateVersion = semver.inc(stableCurrentVersion, 'patch');
  const betaCurrentVersion = `${stableCurrentVersion}-beta.1`;
  const betaUpdateVersion = semver.inc(betaCurrentVersion, 'prerelease');
  assert.ok(stableUpdateVersion && betaUpdateVersion, 'Could not derive stable and beta channel fixtures.');
  assert.equal(selectMacUpdate([channelRelease(`${stableUpdateVersion}-alpha.1`)], stableCurrentVersion, arch), null, 'stable installs must not receive alpha updates.');
  assert.equal(selectMacUpdate([channelRelease(`${stableUpdateVersion}-beta.1`)], stableCurrentVersion, arch), null, 'stable installs must not receive beta updates.');
  assert.equal(selectMacUpdate([channelRelease(`${stableUpdateVersion}-alpha.1`)], betaCurrentVersion, arch), null, 'beta installs must not receive alpha updates.');
  assert.equal(selectMacUpdate([channelRelease(betaUpdateVersion)], betaCurrentVersion, arch)?.version, betaUpdateVersion, 'beta installs may receive a newer beta update.');
  assert.equal(selectMacUpdate([channelRelease(stableUpdateVersion)], stableCurrentVersion, arch)?.version, stableUpdateVersion, 'stable installs may receive newer stable updates.');
  assert.equal(selectMacUpdate([channelRelease(stableUpdateVersion)], betaCurrentVersion, arch)?.version, stableUpdateVersion, 'beta installs may receive stable updates.');
  report.checks.manual_update_asset = { architecture: arch, version: selectedUpdate.version, exact_asset: path.basename(selectedUpdate.downloadUrl), wrong_architecture_rejected: true };
  report.checks.update_channel_filter = { beta_rejects_alpha: true, stable_rejects_alpha: true, stable_rejects_beta: true, beta_accepts_beta: true, beta_accepts_stable: true, stable_accepts_stable: true };

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
  const isolatedAppRoot = fs.mkdtempSync(path.join(runRoot, 'app-run-'));
  env.WORKBENCH_DATA_DIR = path.join(isolatedAppRoot, 'data');
  env.WORKBENCH_LOCATION_CONFIG = path.join(isolatedAppRoot, 'location.json');
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
  const cryptographyNativeTest = engineTestEvents.find(event => event.type === 'cryptography_native_self_test');
  assert.equal(cryptographyNativeTest?.status, 'ok', 'Packaged PDF engine did not pass its cryptography/OpenSSL native self-test.');
  report.checks.cryptography_native_self_test = cryptographyNativeTest.version;
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
  const browserDiagnostics = [];
  const failedRequests = [];
  let smokeFailure;
  let readerPage;
  let readerPaperId;
  try {
    application = await _electron.launch({ executablePath: executable, args: [], cwd: root, env, timeout: 60000 });
    const library = await application.firstWindow();
    library.on('pageerror', error => browserErrors.push(error.message));
    library.on('console', message => {
      if (message.type() === 'warning' || message.type() === 'error') {
        browserDiagnostics.push({ type: message.type(), text: message.text().slice(0, 800) });
      }
    });
    library.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'unknown' }));
    await library.getByRole('button', { name: '设置', exact: true }).waitFor();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), report.version);
    const appInfo = await library.evaluate(() => window.workbench.getAppInfo());
    const appDataRoot = await application.evaluate(({ app }) => app.getPath('appData'));
    const expectedDataRoot = path.join(appDataRoot, '阅川 Folio', 'data');
    // Check default-path resolution without opening a real user's location file or library.
    const defaultConfig = path.join(appDataRoot, '阅川 Folio', 'config', 'location.json');
    const defaults = resolveLocationConfig(path.join(runRoot, `absent-default-${crypto.randomUUID()}.json`), {}, expectedDataRoot, defaultConfig);
    assert.equal(defaults.dataRoot, path.resolve(expectedDataRoot));
    assert.equal(defaults.uiDataRoot, path.join(path.resolve(expectedDataRoot), 'electron-userData'));
    assert.equal(path.resolve(appInfo.dataRoot), env.WORKBENCH_DATA_DIR, 'Packaged smoke must use only the isolated library.');
    assert.equal(path.resolve(appInfo.uiDataRoot), path.join(env.WORKBENCH_DATA_DIR, 'electron-userData'));
    assert.equal(path.resolve(appInfo.locationConfigPath), env.WORKBENCH_LOCATION_CONFIG);
    report.checks.default_paths = { dataRoot: defaults.dataRoot, uiDataRoot: defaults.uiDataRoot, locationConfigPath: defaultConfig, validation: 'resolver_only_no_user_data_access' };
    report.checks.isolated_paths = appInfo;

    const feedbackMessage = 'macOS packaged feedback IPC smoke check';
    try {
      await application.evaluate(({ shell }) => {
        const state = globalThis.__folioMacFeedbackSmoke = {
          originalFetch: globalThis.fetch, originalOpenExternal: shell.openExternal,
          requests: [], external: [],
        };
        globalThis.fetch = async (url, options) => {
          if (url !== 'https://formsubmit.co/ajax/1791913726@qq.com') return state.originalFetch(url, options);
          state.requests.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
          return { ok: true, json: async () => ({ success: 'true' }) };
        };
        shell.openExternal = async url => { state.external.push(url); };
      });
      await library.getByRole('button', { name: '意见反馈', exact: true }).click();
      await library.getByLabel('反馈内容', { exact: true }).fill(feedbackMessage);
      await library.getByRole('button', { name: '提交反馈', exact: true }).click();
      await library.getByText('反馈服务已接收，感谢你的建议。', { exact: true }).waitFor();
      const trace = await application.evaluate(() => ({
        requests: globalThis.__folioMacFeedbackSmoke.requests,
        external: globalThis.__folioMacFeedbackSmoke.external,
      }));
      assert.equal(trace.requests.length, 1);
      assert.equal(trace.requests[0].method, 'POST');
      assert.equal(trace.requests[0].headers.Referer, 'https://github.com/G-mas66/folio');
      assert.deepEqual(trace.requests[0].body, {
        message: feedbackMessage, app_version: report.version, _url: 'https://github.com/G-mas66/folio',
      });
      assert.deepEqual(trace.external, [], 'Feedback must not open an external mail app.');
      report.checks.feedback = { request_count: 1, app_version: report.version, external_mail_app_launches: 0 };
    } finally {
      await application.evaluate(({ shell }) => {
        const state = globalThis.__folioMacFeedbackSmoke;
        if (state) {
          globalThis.fetch = state.originalFetch;
          shell.openExternal = state.originalOpenExternal;
        }
      });
    }

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
    await library.getByRole('button', { name: /导入 PDF/ }).click();
    const papers = await waitForPaper(library, items => items.some(item => item.source_name === path.basename(chinesePdf) && item.can_read));
    const paper = papers.find(item => item.source_name === path.basename(chinesePdf));
    readerPaperId = paper.id;
    assert.equal(paper.source_language, 'zh');
    assert.equal(paper.status, 'completed');
    assert.equal(paper.mono_pdf_file_name, '');
    assert.equal(paper.dual_pdf_file_name, '');
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(chinesePdf)).digest('hex');
    const storedPdf = path.join(appInfo.dataRoot, 'papers', paper.id, paper.file_name);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(storedPdf)).digest('hex'), sourceHash, 'Import must preserve the synthetic source PDF bytes.');
    report.checks.chinese_import = { status: 'readable_without_translation', source_sha256: sourceHash };

    const paperRow = library.getByTestId(`paper-row-${paper.id}`);
    await paperRow.click();
    await library.getByTestId('paper-inspector').waitFor();
    await library.locator('[data-testid="paper-inspector"] .paper-thumbnail.loaded').waitFor();
    assert.equal(await library.getByTestId(`paper-tab-${paper.id}`).count(), 0, 'Selecting a paper must show details without opening a reader.');
    await library.getByTestId(`paper-favorite-${paper.id}`).click();
    await library.getByTestId(`paper-favorite-${paper.id}`).waitFor({ state: 'visible' });
    await waitForPaper(library, items => items.find(item => item.id === paper.id)?.is_favorite === true);
    await library.getByTestId('folder-nav-favorites').click();
    await library.getByTestId(`paper-row-${paper.id}`).waitFor();
    report.checks.compact_library = { selection_opens_details: true, cover_rendered: true, favorites_filter: 'passed' };
    await library.getByTestId(`paper-read-${paper.id}`).click();
    const reader = library;
    readerPage = reader;
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
    await reader.getByRole('button', { name: '编辑', exact: true }).click();
    await reader.getByTestId('reader-note-editor').fill(note);
    await reader.getByRole('button', { name: '保存', exact: true }).click();
    await reader.waitForFunction(async ({ id, note }) => (await window.workbench.request({ path: `/papers/${id}/notes` })).text === note, { id: paper.id, note }, { polling: 100 });
    const saved = await reader.evaluate(id => window.workbench.request({ path: `/papers/${id}/notes` }), paper.id);
    assert.equal(saved.text, note);
    report.checks.notes = 'saved_and_read_back';
    await library.getByTestId('library-tab').click();
    await library.getByTestId('folder-nav-recent').click();
    await library.getByTestId(`paper-row-${paper.id}`).waitFor();
    report.checks.recent_reading = 'passed';
    await checkBackendTranslation(library, translationPdf, python, env);
    assert.deepEqual(browserErrors, []);
  } catch (error) {
    smokeFailure = error;
    report.diagnostics = {
      browser_console: browserDiagnostics.slice(-40),
      failed_requests: failedRequests.slice(-40),
    };
    if (readerPage) {
      try {
        report.diagnostics.reader_canvas = await readerPage.evaluate(id => {
          const canvas = document.querySelector(`[data-testid="reader-tab-panel-${id}"] canvas`);
          if (!canvas) return { present: false };
          const context = canvas.getContext('2d');
          if (!context) return { present: true, context: false, width: canvas.width, height: canvas.height };
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let sampled = 0;
          let nontransparent = 0;
          let darkInk = 0;
          for (let index = 0; index < pixels.length; index += 64) {
            sampled += 1;
            if (pixels[index + 3] > 0) nontransparent += 1;
            if (pixels[index + 3] > 0 && pixels[index] < 200 && pixels[index + 1] < 200 && pixels[index + 2] < 200) darkInk += 1;
          }
          return { present: true, context: true, width: canvas.width, height: canvas.height, sampled, nontransparent, darkInk };
        }, readerPaperId);
      } catch (error) {
        report.diagnostics.reader_canvas_error = error.message;
      }
      try {
        const screenshot = path.join(runRoot, `pdf-reader-failure-${arch}.png`);
        await readerPage.screenshot({ path: screenshot, fullPage: true });
        report.diagnostics.screenshot = screenshot;
      } catch (error) {
        report.diagnostics.screenshot_error = error.message;
      }
    }
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

  assert.equal(report.free_translation.status, 'success', 'Release requires successful packaged backend translation.');
  report.result = 'passed';
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
