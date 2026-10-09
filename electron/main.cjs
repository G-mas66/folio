const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { copyAndVerifyStorage, resolveLocationConfig, validateStorageTarget } = require('./storage-location.cjs');
const { releaseNotesText, selectMacUpdate } = require('./update-service.cjs');

const projectRoot = path.resolve(__dirname, '..');
const legacyWindowsRoot = 'D:\\个人工作台';
const defaultStorageRoot = process.platform === 'win32'
  ? legacyWindowsRoot
  : path.join(app.getPath('appData'), '阅川 Folio');
const defaultDataRoot = path.join(defaultStorageRoot, 'data');
const defaultLocationConfigPath = path.join(defaultStorageRoot, 'config', 'location.json');
let location;
let locationStartupError;
try {
  location = resolveLocationConfig(process.env.WORKBENCH_LOCATION_CONFIG, process.env, defaultDataRoot, defaultLocationConfigPath);
  if (location.configuredDataRoot && !fs.existsSync(location.dataRoot)) throw new Error('已配置的文献存储目录不存在，请连接原磁盘或恢复目录后重试。');
  fs.mkdirSync(location.dataRoot, { recursive: true });
  fs.mkdirSync(location.uiDataRoot, { recursive: true });
  app.setPath('userData', location.uiDataRoot);
  const cacheRoot = path.join(location.dataRoot, '.update-cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  app.setPath('cache', cacheRoot);
} catch (error) {
  locationStartupError = error;
}
const dataRoot = location?.dataRoot || path.resolve(process.env.WORKBENCH_DATA_DIR || defaultDataRoot);
const credentialRoot = location?.credentialRoot || path.resolve(process.env.WORKBENCH_CREDENTIAL_ROOT || dataRoot);
const uiDataRoot = location?.uiDataRoot || path.join(dataRoot, 'electron-userData');
const updateCacheRoot = path.join(dataRoot, '.update-cache');
const locationConfigPath = location?.locationConfigPath || path.resolve(process.env.WORKBENCH_LOCATION_CONFIG || defaultLocationConfigPath);
const themePreferencePath = path.join(uiDataRoot, 'theme-preference.json');

function readThemePreference() {
  try {
    const value = JSON.parse(fs.readFileSync(themePreferencePath, 'utf8'))?.theme;
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

nativeTheme.themeSource = readThemePreference();

let backend;
let backendStopping = false;
let backendStopPromise;
let storageMigrationInProgress = false;
let storageMigrationRestartPending = false;
let backendToken;
let backendBase;
let mainWindow;
let autoUpdater;
let CancellationToken;
let downloadCancellationToken;
let downloadCancelled = false;
let updateInstallInProgress = false;
let updateInstallRequest;
let updateState = {
  platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'unsupported',
  status: 'idle',
  currentVersion: app.getVersion(),
  enabled: app.isPackaged && ['win32', 'darwin'].includes(process.platform),
};
const chatStreams = new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const backendTempRoot = path.join(dataRoot, '.backend-temp');
if (!locationStartupError) fs.mkdirSync(backendTempRoot, { recursive: true });

function publishUpdateState(next) {
  updateState = { ...updateState, ...next, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('workbench:update-state', updateState);
  }
  return updateState;
}

function configureWindowsUpdater() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    ({ autoUpdater, CancellationToken } = require('electron-updater'));
    Object.defineProperty(autoUpdater.app, 'baseCachePath', { configurable: true, get: () => updateCacheRoot });
    if (autoUpdater.app.baseCachePath !== updateCacheRoot) throw new Error('更新缓存目录无效。');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.fullChangelog = false;
    const channel = /^\d+\.\d+\.\d+-(alpha|beta|rc)(?:[.-]|$)/.exec(app.getVersion())?.[1];
    if (channel) {
      autoUpdater.channel = channel;
      autoUpdater.allowPrerelease = true;
      autoUpdater.allowDowngrade = false;
    }
    autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking', message: '' }));
    autoUpdater.on('update-available', (info) => publishUpdateState({
      status: 'available', version: info.version, releaseNotes: releaseNotesText(info.releaseNotes), message: '',
    }));
    autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'not-available', version: '', releaseNotes: '', message: '' }));
    autoUpdater.on('download-progress', (progress) => publishUpdateState({
      status: 'downloading', percent: progress.percent, bytesPerSecond: progress.bytesPerSecond,
      total: progress.total, transferred: progress.transferred,
    }));
    autoUpdater.on('update-downloaded', (info) => {
      downloadCancellationToken = null;
      publishUpdateState({ status: 'downloaded', version: info.version, releaseNotes: releaseNotesText(info.releaseNotes), percent: 100, message: '' });
    });
    autoUpdater.on('update-cancelled', (info) => {
      downloadCancellationToken = null;
      publishUpdateState({ status: 'available', version: info.version, percent: undefined, transferred: undefined, total: undefined, message: '下载已取消，可以重新下载。' });
    });
    autoUpdater.on('error', () => {
      const downloading = updateState.status === 'downloading';
      publishUpdateState({ status: downloading ? 'available' : 'error', message: downloading ? '下载失败，可以重试。' : '检查更新失败，请检查网络后重试。' });
    });
  } catch {
    publishUpdateState({ status: 'error', message: '此安装包暂时无法检查更新。' });
  }
}

async function checkForUpdatesInternal() {
  if (storageMigrationInProgress || updateInstallInProgress) throw new Error('当前操作期间不能检查更新。');
  if (!app.isPackaged) return publishUpdateState({ status: 'error', message: '请使用已安装版本检查更新。' });
  if (process.platform === 'win32') {
    if (!autoUpdater) return publishUpdateState({ status: 'error', message: '此安装包暂时无法检查更新。' });
    if (['checking', 'downloading', 'downloaded'].includes(updateState.status)) return updateState;
    publishUpdateState({ status: 'checking', message: '' });
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      if (updateState.status === 'checking') publishUpdateState({ status: 'error', message: '检查更新失败，请检查网络后重试。' });
    }
    return updateState;
  }
  if (process.platform !== 'darwin') return publishUpdateState({ status: 'error', message: '此平台暂不提供更新检查。' });
  publishUpdateState({ status: 'checking', message: '' });
  try {
    const response = await fetch('https://api.github.com/repos/G-mas66/folio/releases?per_page=100', {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Folio updater' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('GitHub Releases request failed.');
    const selected = selectMacUpdate(await response.json(), app.getVersion(), process.arch);
    return selected
      ? publishUpdateState({ status: 'manual-available', ...selected, message: '' })
      : publishUpdateState({ status: 'not-available', version: '', releaseNotes: '', downloadUrl: '', releaseUrl: '', message: '' });
  } catch {
    return publishUpdateState({ status: 'error', message: '检查更新失败，请检查网络后重试。' });
  }
}

async function downloadUpdateInternal() {
  if (storageMigrationInProgress || updateInstallInProgress) throw new Error('当前操作期间不能下载更新。');
  if (!autoUpdater || updateState.status !== 'available') throw new Error('请先检查更新。');
  downloadCancelled = false;
  downloadCancellationToken = new CancellationToken();
  publishUpdateState({ status: 'downloading', percent: 0, transferred: 0, total: 0, message: '' });
  try {
    await autoUpdater.downloadUpdate(downloadCancellationToken);
    return updateState;
  } catch {
    if (updateState.status === 'downloading') {
      publishUpdateState({ status: 'available', message: downloadCancelled ? '下载已取消，可以重新下载。' : '下载失败，可以重试。' });
    }
    return updateState;
  } finally {
    downloadCancellationToken = null;
    downloadCancelled = false;
  }
}

function requestRendererUpdatePreparation() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return Promise.reject(new Error('阅读窗口已关闭。'));
  const requestId = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      updateInstallRequest = null;
      reject(new Error('笔记保存未能完成；更新安装已取消。'));
    }, 15000);
    updateInstallRequest = { requestId, resolve, reject, timer };
    mainWindow.webContents.send('workbench:update-install-prepare', requestId);
  });
}

async function pauseActiveTranslations() {
  const activeStatuses = new Set(['queued', 'translating', 'checking', 'waiting_api']);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const papers = await requestApi({ path: '/papers?folder_id=all' });
    const active = papers.filter((paper) => activeStatuses.has(paper.status));
    if (!active.length) return;
    await Promise.all(active.map(async (paper) => {
      if (!/^[a-f0-9]{32}$/.test(paper.id || '')) throw new Error('无法暂停文献翻译任务。');
      const response = await fetch(`${backendBase}/papers/${paper.id}/translation/stop`, {
        method: 'POST', headers: { Authorization: `Bearer ${backendToken}` }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok && response.status !== 409) throw new Error('无法暂停文献翻译任务。');
    }));
  }
  throw new Error('仍有翻译任务正在运行；更新安装已取消。');
}

async function installUpdateInternal() {
  if (storageMigrationInProgress || updateInstallInProgress) throw new Error('当前操作期间不能安装更新。');
  if (!autoUpdater || updateState.status !== 'downloaded') throw new Error('更新尚未下载完成。');
  updateInstallInProgress = true;
  try {
    await requestRendererUpdatePreparation();
    await Promise.all([...chatStreams.values()].map((stream) => cancelStream(stream)));
    await pauseActiveTranslations();
    await stopBackendProcess();
    autoUpdater.quitAndInstall(true, true);
    return true;
  } catch (error) {
    updateInstallInProgress = false;
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) {
      try { await startBackend(); } catch {}
    }
    throw error;
  }
}

function cleanupBackendTemp() {
  const root = path.resolve(backendTempRoot);
  if (root !== path.resolve(dataRoot, '.backend-temp')) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^_MEI\d+$/.test(entry.name)) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root) continue;
    try {
      const info = fs.lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }
}

function findPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function startBackend() {
  const port = await findPort();
  backendToken = !app.isPackaged && process.env.WORKBENCH_DEV_TOKEN
    ? process.env.WORKBENCH_DEV_TOKEN
    : crypto.randomBytes(32).toString('hex');
  backendBase = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    WORKBENCH_PORT: String(port),
    WORKBENCH_SESSION_TOKEN: backendToken,
    WORKBENCH_DATA_DIR: dataRoot,
    WORKBENCH_CREDENTIAL_ROOT: credentialRoot,
    PYTHONDONTWRITEBYTECODE: '1',
    TEMP: backendTempRoot,
    TMP: backendTempRoot,
    TMPDIR: backendTempRoot,
    WORKBENCH_PDF_ENGINE_BIN: app.isPackaged
      ? path.join(process.resourcesPath, 'pdf-engine', process.platform === 'win32' ? 'workbench-pdf-engine.exe' : 'workbench-pdf-engine')
      : process.platform === 'win32'
        ? path.join(projectRoot, '.venv-pdf-engine', 'Scripts', 'python.exe')
        : path.join(projectRoot, '.venv-pdf-engine-macos', 'bin', 'python'),
    WORKBENCH_PDF_ENGINE_ENTRY: app.isPackaged ? '' : path.join(projectRoot, 'backend', 'pdf_engine', 'entrypoint.py'),
    WORKBENCH_PDF_ENGINE_ASSETS: app.isPackaged
      ? path.join(process.resourcesPath, 'pdf-engine-assets', 'babeldoc')
      : path.join(projectRoot, 'backend', 'pdf_engine_assets', 'babeldoc'),
    WORKBENCH_PDF_ENGINE_HOME: path.join(dataRoot, '.pdf-engine-home'),
  };
  if (app.isPackaged) {
    backend = spawn(path.join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'workbench-service.exe' : 'workbench-service'), [], {
      cwd: dataRoot, env, windowsHide: true, stdio: 'ignore',
    });
  } else {
    const python = process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv-macos', 'bin', 'python');
    backend = spawn(python, ['-m', 'backend.server'], {
      cwd: projectRoot, env: { ...env, PYTHONPATH: projectRoot }, windowsHide: true, stdio: 'ignore',
    });
  }
  backend.on('error', () => {});
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (backend.exitCode !== null) throw new Error('本地文献服务未能启动。');
    try {
      const response = await fetch(`${backendBase}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('本地文献服务启动超时。');
}

function waitForBackendExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited || child.exitCode !== null || child.signalCode !== null);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopBackendProcess() {
  if (backendStopPromise) return backendStopPromise;
  const child = backend;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    backend = null;
    return;
  }
  backendStopping = true;
  backendStopPromise = (async () => {
    if (process.platform === 'win32') {
      const code = await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => resolve(1));
        killer.once('exit', (exitCode) => resolve(exitCode === 0 ? 0 : 1));
      });
      if (code !== 0 && child.exitCode === null) child.kill();
    } else {
      child.kill();
    }
    if (!await waitForBackendExit(child)) throw new Error('无法安全停止本地文献服务，迁移已取消。');
    if (backend === child) backend = null;
    cleanupBackendTemp();
  })();
  try {
    await backendStopPromise;
  } finally {
    backendStopPromise = null;
    backendStopping = false;
  }
}

async function requestApi(input) {
  if (storageMigrationInProgress) throw new Error('文献存储位置正在迁移，操作已暂时停用。');
  if (!input || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//')) {
    throw new Error('无效的本机服务请求。');
  }
  const noteFlushDuringInstall = updateInstallInProgress && input.method === 'PUT' && /^\/papers\/[a-f0-9]{32}\/notes$/.test(input.path);
  const translationCheckDuringInstall = updateInstallInProgress && input.method !== 'PUT' && input.path === '/papers?folder_id=all';
  if (updateInstallInProgress && !noteFlushDuringInstall && !translationCheckDuringInstall) throw new Error('应用正在准备安装更新，请稍候。');
  const response = await fetch(`${backendBase}${input.path}`, {
    method: input.method || 'GET',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (input.binary) {
    if (!response.ok) throw new Error('无法读取文献库中的 PDF。');
    return new Uint8Array(await response.arrayBuffer());
  }
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message || '本地请求失败。';
    throw new Error(message);
  }
  return payload;
}

function secureWindowOptions() {
  return {
    ...(process.platform === 'win32' ? { icon: path.join(app.getAppPath(), 'assets', 'folio-icon.ico') } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function loadRenderer(window) {
  if (process.env.WORKBENCH_DEV === '1') {
    return window.loadURL('http://127.0.0.1:5173/');
  }
  return window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...secureWindowOptions(),
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    title: 'Folio',
    backgroundColor: '#f6f5f1',
    show: false,
  });
  if (process.platform === 'win32') mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file:') && !target.startsWith('http://127.0.0.1:5173/')) event.preventDefault();
  });
  loadRenderer(mainWindow);
}

function sendChatEvent(stream, type, data) {
  const terminal = ['done', 'cancelled', 'error'].includes(type);
  if (terminal) stream.ended = true;
  if (!stream.webContents.isDestroyed()) {
    stream.webContents.send('workbench:chat-stream-event', { requestId: stream.requestId, type, data });
  }
}

function parseChatEvents(stream, chunk) {
  stream.buffer += chunk;
  let boundary;
  while ((boundary = stream.buffer.indexOf('\n\n')) >= 0) {
    const block = stream.buffer.slice(0, boundary).replace(/\r/g, '');
    stream.buffer = stream.buffer.slice(boundary + 2);
    let type = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try { sendChatEvent(stream, type, JSON.parse(data.join('\n'))); }
    catch { sendChatEvent(stream, 'error', { category: 'invalid_response', message: '本机服务返回了无法读取的流式数据。' }); }
  }
}

async function consumeChatStream(stream, pathName, body) {
  try {
    const response = await fetch(`${backendBase}${pathName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backendToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: stream.controller.signal,
    });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      const detail = payload?.detail;
      sendChatEvent(stream, 'error', {
        category: typeof detail === 'object' ? detail.category || 'service_error' : 'service_error',
        message: typeof detail === 'string' ? detail : detail?.message || 'AI 请求失败。',
      });
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('本机服务未返回流式数据。');
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parseChatEvents(stream, decoder.decode(value, { stream: true }));
      if (stream.ended) break;
    }
    if (!stream.ended && !stream.controller.signal.aborted) {
      const tail = decoder.decode();
      if (tail) parseChatEvents(stream, tail);
      if (!stream.ended) sendChatEvent(stream, 'error', { category: 'incomplete_response', message: '流式回答意外中断；部分内容已保留，未标记为完成。' });
    }
  } catch (error) {
    if (!stream.controller.signal.aborted) {
      sendChatEvent(stream, 'error', { category: 'network', message: error?.message || '无法连接本机流式服务。' });
    }
  } finally {
    chatStreams.delete(stream.requestId);
  }
}

function startChatStream(event, input) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window !== mainWindow || !/^[a-f0-9]{32}$/.test(input?.paperId || '')) {
    throw new Error('阅读窗口与当前文献不匹配。');
  }
  if (storageMigrationInProgress) throw new Error('文献存储位置正在迁移，暂时不能开始新请求。');
  if (updateInstallInProgress) throw new Error('应用正在准备安装更新，暂时不能开始新请求。');
  const requestId = input.requestId;
  if (!/^[a-f0-9]{32}$/.test(requestId || '') || chatStreams.has(requestId)) throw new Error('流式请求编号无效。');
  if (input.runId && !/^[a-f0-9]{32}$/.test(input.runId)) throw new Error('总结任务编号无效。');
  if (input.sessionId && !/^[a-f0-9]{32}$/.test(input.sessionId)) throw new Error('会话编号无效。');
  let pathName;
  let body;
  if (input.runId) {
    pathName = `/papers/${input.paperId}/analysis/${input.runId}/stream`;
    body = { request_id: requestId, session_id: input.sessionId };
  } else {
    pathName = `/papers/${input.paperId}/chat/stream`;
    body = {
      request_id: requestId,
      question: input.question,
      model: input.model,
      web_search: input.webSearch,
      session_id: input.sessionId,
    };
  }
  const stream = {
    requestId, paperId: input.paperId, webContents: event.sender,
    controller: new AbortController(), buffer: '', ended: false,
  };
  chatStreams.set(requestId, stream);
  void consumeChatStream(stream, pathName, body);
  return requestId;
}

async function cancelStream(stream) {
  try {
    await fetch(`${backendBase}/papers/${stream.paperId}/chat/stream/${stream.requestId}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${backendToken}` },
      signal: AbortSignal.timeout(2500),
    });
  } catch {}
  if (!stream.ended) {
    sendChatEvent(stream, 'cancelled', { status: 'cancelled', message: '已停止生成；部分内容已保留。' });
    stream.controller.abort();
  }
  return true;
}

async function cancelChatStream(event, requestId) {
  const stream = chatStreams.get(requestId);
  if (!stream || stream.webContents !== event.sender) return false;
  return cancelStream(stream);
}

async function cancelPaperStreams(event, paperId) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (owner !== mainWindow || !/^[a-f0-9]{32}$/.test(paperId || '')) throw new Error('文献编号无效。');
  const streams = [...chatStreams.values()].filter((stream) => stream.webContents === event.sender && stream.paperId === paperId);
  await Promise.all(streams.map((stream) => cancelStream(stream)));
  return streams.length;
}

ipcMain.handle('workbench:request', (_event, input) => requestApi(input));
ipcMain.handle('workbench:set-theme-preference', (event, preference) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的主题设置请求。');
  if (!['system', 'light', 'dark'].includes(preference)) throw new Error('无效的主题设置。');
  nativeTheme.themeSource = preference;
  fs.writeFileSync(themePreferencePath, JSON.stringify({ theme: preference }), 'utf8');
  return preference;
});
ipcMain.handle('workbench:reveal-paper-file', async (event, input) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow || !/^[a-f0-9]{32}$/.test(input?.paperId || '') || !['original', 'mono', 'dual'].includes(input?.kind)) throw new Error('文献文件位置无效。');
  const paper = await requestApi({ path: `/papers/${input.paperId}` });
  const name = input.kind === 'original' || paper.source_language === 'zh' ? paper.file_name : input.kind === 'mono' ? paper.mono_pdf_file_name : paper.dual_pdf_file_name;
  if (!name || path.basename(name) !== name) throw new Error('对应的 PDF 尚未生成。');
  const folder = path.join(dataRoot, 'papers', input.paperId);
  const target = path.join(folder, name);
  if (!fs.existsSync(target) || fs.realpathSync(folder) !== path.join(fs.realpathSync(path.join(dataRoot, 'papers')), input.paperId) || path.dirname(fs.realpathSync(target)) !== fs.realpathSync(folder)) throw new Error('文献库中的 PDF 不存在。');
  shell.showItemInFolder(target);
  return true;
});
ipcMain.handle('workbench:open-library-folder', async (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无法打开文献目录。');
  const folder = path.join(dataRoot, 'papers');
  fs.mkdirSync(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) throw new Error('无法打开文献目录。');
  return true;
});
ipcMain.handle('workbench:chat-stream-start', (event, input) => startChatStream(event, input));
ipcMain.handle('workbench:chat-stream-cancel', (event, requestId) => cancelChatStream(event, requestId));
ipcMain.handle('workbench:cancel-paper-streams', (event, paperId) => cancelPaperStreams(event, paperId));
ipcMain.handle('workbench:choose-pdfs', async (event) => {
  if (storageMigrationInProgress) throw new Error('文献存储位置正在迁移，暂时不能导入文献。');
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) throw new Error('无效的主窗口请求。');
  const result = await dialog.showOpenDialog(owner, {
    title: '导入 PDF 文献',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('workbench:get-app-info', () => ({ dataRoot, uiDataRoot, credentialRoot, locationConfigPath }));
ipcMain.handle('workbench:get-update-state', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的更新状态请求。');
  return updateState;
});
ipcMain.handle('workbench:update-check', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的更新请求。');
  return checkForUpdatesInternal();
});
ipcMain.handle('workbench:update-download', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的更新请求。');
  return downloadUpdateInternal();
});
ipcMain.handle('workbench:update-cancel-download', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的更新请求。');
  if (!downloadCancellationToken) return false;
  downloadCancelled = true;
  downloadCancellationToken.cancel();
  return true;
});
ipcMain.handle('workbench:update-install', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('无效的更新请求。');
  return installUpdateInternal();
});
ipcMain.handle('workbench:update-open-download', async (event) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow || process.platform !== 'darwin' || updateState.status !== 'manual-available' || !updateState.downloadUrl) throw new Error('没有可打开的 macOS 更新包。');
  await shell.openExternal(updateState.downloadUrl);
  return true;
});
ipcMain.on('workbench:update-install-ready', (event, value) => {
  const pending = updateInstallRequest;
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow || !pending || value?.requestId !== pending.requestId) return;
  clearTimeout(pending.timer);
  updateInstallRequest = null;
  if (typeof value.error === 'string' && value.error) pending.reject(new Error(value.error));
  else pending.resolve();
});
ipcMain.on('workbench:update-state-subscribe', (event) => {
  if (BrowserWindow.fromWebContents(event.sender) === mainWindow) event.sender.send('workbench:update-state', updateState);
});
ipcMain.handle('workbench:choose-storage-location', async (event) => {
  if (storageMigrationInProgress) throw new Error('文献存储位置正在迁移，请稍候。');
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) throw new Error('无效的主窗口请求。');
  const result = await dialog.showOpenDialog(owner, {
    title: '选择空的文献存储文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return validateStorageTarget(dataRoot, result.filePaths[0]).target;
});
ipcMain.handle('workbench:migrate-storage-location', async (event, input) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner !== mainWindow) throw new Error('无效的主窗口请求。');
  if (storageMigrationInProgress) throw new Error('文献存储位置正在迁移，请稍候。');
  if (updateInstallInProgress || ['checking', 'downloading', 'downloaded'].includes(updateState.status)) throw new Error('请先等待更新完成或取消下载，再迁移文献存储位置。');
  if (typeof input?.target !== 'string') throw new Error('目标文献目录无效。');
  const target = validateStorageTarget(dataRoot, input.target).target;
  const config = { dataRoot: target, credentialRoot, uiDataRoot };
  storageMigrationInProgress = true;
  const sendProgress = (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('workbench:storage-migration-progress', progress);
  };
  try {
    sendProgress({ phase: 'stopping', copiedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0 });
    await Promise.all([...chatStreams.values()].map((stream) => cancelStream(stream)));
    await stopBackendProcess();
    const result = await copyAndVerifyStorage(dataRoot, target, {
      configPath: locationConfigPath,
      config,
      uiDataRoot,
      onProgress: (progress) => sendProgress({ phase: 'copying', ...progress }),
    });
    delete process.env.WORKBENCH_DATA_DIR;
    delete process.env.WORKBENCH_CREDENTIAL_ROOT;
    storageMigrationRestartPending = true;
    sendProgress({ phase: 'complete', copiedFiles: result.copiedFiles, totalFiles: result.copiedFiles, copiedBytes: result.copiedBytes, totalBytes: result.copiedBytes });
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 400);
    return { ...result, restarting: true };
  } catch (error) {
    storageMigrationInProgress = false;
    if (!backend || backend.exitCode !== null) {
      try { await startBackend(); }
      catch { throw new Error(`${error.message || '文献存储迁移失败。'} 本地服务未能恢复；请重新启动应用以读取原目录。`); }
    }
    throw error;
  }
});
ipcMain.handle('workbench:open-external', async (_event, value) => {
  if (typeof value !== 'string') throw new Error('网页来源地址无效。');
  let url;
  try { url = new URL(value); } catch { throw new Error('网页来源地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('只允许打开安全的网页来源。');
  }
  await shell.openExternal(url.toString());
  return true;
});

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  if (process.platform === 'win32') Menu.setApplicationMenu(null);
  configureWindowsUpdater();
  try {
    if (locationStartupError) throw locationStartupError;
    await startBackend();
    createMainWindow();
    if (app.isPackaged && ['win32', 'darwin'].includes(process.platform)) setTimeout(() => void checkForUpdatesInternal().catch(() => {}), 2000).unref();
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: '工作台无法启动', message: error.message || '本地服务启动失败。' });
    app.quit();
  }
  });
}

app.on('before-quit', (event) => {
  if (storageMigrationInProgress && !storageMigrationRestartPending) {
    event.preventDefault();
    return;
  }
  if (backendStopping) {
    event.preventDefault();
    return;
  }
  if (!backend || backend.exitCode !== null) return;
  event.preventDefault();
  void stopBackendProcess().then(() => app.quit()).catch(() => {
    if (backend && backend.exitCode === null) backend.kill();
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
