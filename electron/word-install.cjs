'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const PROG_ID = 'Folio.WordAddin';
const CLSID = '{BF4750C7-9CA5-4C9D-93B7-0DB7349E2F3A}';
const ADDIN_NAME = 'Folio Word Add-in';
const MARKER_NAME = '.folio-word-plugin.json';
const ASSEMBLY_NAME = 'Folio.WordAddin.dll';
const VIEWS = ['32', '64'];

function runReg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}

const systemRegistry = {
  get(key, name, view) {
    const args = ['query', key];
    if (name === '') args.push('/ve');
    else args.push('/v', name);
    if (view) args.push(`/reg:${view}`);
    const result = runReg(args);
    if (result.status !== 0) return undefined;
    const line = result.stdout.split(/\r?\n/).find((entry) => /\sREG_[A-Z0-9_]+\s/.test(entry));
    if (!line) return undefined;
    const match = line.match(/\s(REG_[A-Z0-9_]+)\s+([\s\S]*)$/);
    if (!match) return undefined;
    return { type: match[1], value: match[2].trim() };
  },
  set(key, name, value, type, view) {
    const args = ['add', key];
    if (name === '') args.push('/ve');
    else args.push('/v', name);
    args.push('/t', type || 'REG_SZ', '/d', String(value), '/f');
    if (view) args.push(`/reg:${view}`);
    const result = runReg(args);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Registry write failed: ${key}`);
  },
  deleteTree(key, view) {
    const args = ['delete', key, '/f'];
    if (view) args.push(`/reg:${view}`);
    const result = runReg(args);
    if (result.status !== 0 && !/unable to find/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(result.stderr || result.stdout || `Registry removal failed: ${key}`);
    }
  },
  deleteValue(key, name, view) {
    const args = ['delete', key, name === '' ? '/ve' : '/v', ...(name === '' ? [] : [name]), '/f'];
    if (view) args.push(`/reg:${view}`);
    const result = runReg(args);
    if (result.status !== 0 && !/unable to find/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(result.stderr || result.stdout || `Registry value removal failed: ${key}`);
    }
  },
};

function installedWordPath(registry) {
  const candidates = [
    ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE', '', '64'],
    ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE', '', '32'],
    ['HKLM\\SOFTWARE\\Microsoft\\Office\\16.0\\Word\\InstallRoot', 'Path', '64'],
    ['HKLM\\SOFTWARE\\Microsoft\\Office\\16.0\\Word\\InstallRoot', 'Path', '32'],
  ];
  for (const [key, name, view] of candidates) {
    const value = registry.get(key, name, view)?.value;
    if (!value) continue;
    const candidate = name === 'Path' ? path.join(value, 'WINWORD.EXE') : value;
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const candidate = path.join(root, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function isWordRunning() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', windowsHide: true,
  });
  return result.status === 0 && /"WINWORD\.EXE"/i.test(result.stdout || '');
}

function localInstallRoot(options) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('找不到当前 Windows 用户的 LocalAppData 目录。');
  return path.join(localAppData, 'Folio', 'Word', 'native');
}

function markerPath(installRoot) {
  return path.join(installRoot, MARKER_NAME);
}

function markerFromDisk(installRoot) {
  try {
    const stat = fs.lstatSync(markerPath(installRoot));
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath(installRoot), 'utf8'));
    return marker && marker.version === 1 && Array.isArray(marker.files) ? marker : null;
  } catch {
    return null;
  }
}

function registrationKeys() {
  return {
    clsid: `HKCU\\Software\\Classes\\CLSID\\${CLSID}`,
    progId: `HKCU\\Software\\Classes\\${PROG_ID}`,
    addin: `HKCU\\Software\\Microsoft\\Office\\Word\\Addins\\${PROG_ID}`,
  };
}

function codeBaseFor(filename) {
  return pathToFileURL(filename).toString();
}

function registryNumber(value) {
  if (value && typeof value.value === 'number') return value.value;
  if (!value || typeof value.value !== 'string') return NaN;
  const text = value.value.trim();
  return /^0x[0-9a-f]+$/i.test(text) ? parseInt(text.slice(2), 16) : Number(text);
}

function executableBitness(filename) {
  if (!filename) return null;
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const dos = Buffer.alloc(64);
    if (fs.readSync(descriptor, dos, 0, dos.length, 0) < 64 || dos.toString('ascii', 0, 2) !== 'MZ') return null;
    const offset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (fs.readSync(descriptor, pe, 0, pe.length, offset) !== pe.length || pe.toString('ascii', 0, 4) !== 'PE\0\0') return null;
    const machine = pe.readUInt16LE(4);
    return machine === 0x8664 || machine === 0xaa64 ? 'x64' : machine === 0x14c ? 'x86' : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
}

function isOwnedCodeBase(value, installRoot) {
  if (typeof value !== 'string' || !value.startsWith('file:///')) return false;
  let filename;
  try { filename = fileURLToPath(value); } catch { return false; }
  const relative = path.relative(path.resolve(installRoot), path.resolve(filename));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function getRegistrationStatus(options = {}) {
  const registry = options.registry || systemRegistry;
  const installRoot = localInstallRoot(options);
  const marker = markerFromDisk(installRoot);
  const wordPath = installedWordPath(registry);
  const views = process.platform === 'win32' && (process.env.PROCESSOR_ARCHITECTURE === 'x86'
    && !process.env.PROCESSOR_ARCHITEW6432 ? ['32'] : VIEWS);
  const keys = registrationKeys();
  const registered = views.filter((view) => {
    const addin = registry.get(keys.addin, 'LoadBehavior', view);
    const codeBase = registry.get(`${keys.clsid}\\InprocServer32`, 'CodeBase', view)?.value;
    const dll = marker?.files.map((file) => path.resolve(installRoot, file))
      .find((candidate) => codeBase && codeBase.toLowerCase() === codeBaseFor(candidate).toLowerCase());
    return registryNumber(addin) === 3 && Boolean(dll && fs.existsSync(dll));
  });
  const wordRunning = (options.isWordRunning || isWordRunning)();
  const installed = registered.length > 0;
  const state = installed ? (wordRunning ? 'restart_required' : 'installed') : 'not_installed';
  return {
    installed,
    state,
    wordFound: Boolean(wordPath),
    wordPath: wordPath || null,
    wordBitness: executableBitness(wordPath),
    wordRunning,
    restartRequired: installed && wordRunning,
    views: registered,
    installRoot: fs.existsSync(installRoot) ? installRoot : null,
    unsigned: true,
    message: !wordPath
      ? '未检测到桌面版 Microsoft Word。安装将在 Word 下次启动时生效。'
      : installed && wordRunning
        ? 'Folio Word 插件已注册；Word 正在运行，请在下次启动 Word 时使用。组织策略可能会阻止未签名插件。'
        : installed
          ? 'Folio Word 插件已注册。组织策略可能会阻止未签名插件。'
          : '尚未安装 Word 插件。安装只会写入当前用户的注册表。',
  };
}

function assertOwnedOrEmpty(registry, key, name, view, installRoot) {
  const existing = registry.get(key, name, view);
  if (existing === undefined) return;
  if (name === 'CodeBase' && isOwnedCodeBase(existing.value, installRoot)) return;
  if (name === 'LoadBehavior' && existing.type === 'REG_DWORD'
      && isOwnedCodeBase(registry.get(`${registrationKeys().clsid}\\InprocServer32`, 'CodeBase', view)?.value, installRoot)) return;
  throw new Error(`Word 注册项 ${key} 已被其他组件使用，安装已停止。`);
}

function writeView(registry, view, filename, installRoot) {
  const keys = registrationKeys();
  const clsidInproc = `${keys.clsid}\\InprocServer32`;
  const codeBase = codeBaseFor(filename);
  assertOwnedOrEmpty(registry, `${keys.addin}`, 'LoadBehavior', view, installRoot);
  assertOwnedOrEmpty(registry, clsidInproc, 'CodeBase', view, installRoot);
  const values = [
    [keys.clsid, '', ADDIN_NAME, 'REG_SZ'],
    [clsidInproc, '', 'mscoree.dll', 'REG_SZ'],
    [clsidInproc, 'ThreadingModel', 'Both', 'REG_SZ'],
    [clsidInproc, 'Class', 'Connect', 'REG_SZ'],
    [clsidInproc, 'Assembly', 'Folio.WordAddin, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null', 'REG_SZ'],
    [clsidInproc, 'RuntimeVersion', 'v4.0.30319', 'REG_SZ'],
    [clsidInproc, 'CodeBase', codeBase, 'REG_SZ'],
    [`${keys.clsid}\\ProgID`, '', PROG_ID, 'REG_SZ'],
    [`${keys.clsid}\\VersionIndependentProgID`, '', PROG_ID, 'REG_SZ'],
    [keys.progId, '', ADDIN_NAME, 'REG_SZ'],
    [`${keys.progId}\\CLSID`, '', CLSID, 'REG_SZ'],
    [`${keys.progId}\\CurVer`, '', PROG_ID, 'REG_SZ'],
    [keys.addin, 'FriendlyName', ADDIN_NAME, 'REG_SZ'],
    [keys.addin, 'Description', '在 Word 中搜索 Folio 文献并管理文中引用和参考文献。', 'REG_SZ'],
    [keys.addin, 'LoadBehavior', 3, 'REG_DWORD'],
  ];
  const applied = [];
  try {
    for (const [key, name, value, type] of values) {
      const previous = registry.get(key, name, view);
      registry.set(key, name, value, type, view);
      applied.push({ key, name, previous });
    }
  } catch (error) {
    rollbackView(registry, view, applied);
    throw error;
  }
  return applied;
}

function rollbackView(registry, view, applied) {
  for (const entry of [...applied].reverse()) {
    try {
      if (entry.previous) registry.set(entry.key, entry.name, entry.previous.value, entry.previous.type, view);
      else registry.deleteValue(entry.key, entry.name, view);
    } catch {}
  }
}

function writeMarker(installRoot, files) {
  fs.mkdirSync(installRoot, { recursive: true });
  const filename = markerPath(installRoot);
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, progId: PROG_ID, clsid: CLSID, files }, null, 2), 'utf8');
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function installWordPlugin(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    throw new Error('桌面版 Word COM 插件仅支持 Windows。');
  }
  const registry = options.registry || systemRegistry;
  const installRoot = localInstallRoot(options);
  const bundledRoot = options.bundledRoot;
  if (typeof bundledRoot !== 'string' || !bundledRoot) throw new TypeError('bundledRoot is required');
  const paths = [];
  for (const [folder, view] of [['win-x86', '32'], ['win-x64', '64']]) {
    if (view === '64' && process.env.PROCESSOR_ARCHITECTURE === 'x86' && !process.env.PROCESSOR_ARCHITEW6432) continue;
    const relative = path.join(folder, ASSEMBLY_NAME);
    const source = path.join(bundledRoot, relative);
    if (!fs.existsSync(source)) throw new Error(`缺少 Word 插件文件：${relative}`);
    paths.push({ relative, source, view });
  }
  const registryKeys = registrationKeys();
  for (const item of paths) {
    assertOwnedOrEmpty(registry, registryKeys.addin, 'LoadBehavior', item.view, installRoot);
    assertOwnedOrEmpty(registry, `${registryKeys.clsid}\\InprocServer32`, 'CodeBase', item.view, installRoot);
  }
  const hadMarker = Boolean(markerFromDisk(installRoot));
  const installRootExisted = fs.existsSync(installRoot);
  const wordRunning = (options.isWordRunning || isWordRunning)();
  const hasOwnedRegistration = VIEWS.some((view) => isOwnedCodeBase(
    registry.get(`${registryKeys.clsid}\\InprocServer32`, 'CodeBase', view)?.value, installRoot));
  if (wordRunning && (hasOwnedRegistration || hadMarker)) {
    throw new Error('Word 正在运行；请关闭 Word 后再修复本机插件，现有安装文件未更改。');
  }

  const backups = paths.map((item) => {
    const destination = path.join(installRoot, item.relative);
    const directory = path.dirname(destination);
    const directoryExisted = fs.existsSync(directory);
    try {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Word 插件目标文件不是普通文件：${item.relative}`);
      const codeBase = registry.get(`${registryKeys.clsid}\\InprocServer32`, 'CodeBase', item.view)?.value;
      const registeredFile = typeof codeBase === 'string' && codeBase.toLowerCase() === codeBaseFor(destination).toLowerCase();
      if (!hadMarker && !registeredFile) throw new Error(`Word 插件文件已存在但缺少 Folio 所有权标记：${item.relative}`);
      return { destination, directory, directoryExisted, contents: fs.readFileSync(destination) };
    } catch (error) {
      if (error.code === 'ENOENT') return { destination, directory, directoryExisted, contents: null };
      throw error;
    }
  });
  const files = [];
  const transactions = [];
  try {
    for (const item of paths) {
      const destination = path.join(installRoot, item.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(item.source, destination);
      files.push(item.relative);
    }
    for (const item of paths) {
      transactions.push({ view: item.view, applied: writeView(registry, item.view, path.join(installRoot, item.relative), installRoot) });
    }
    writeMarker(installRoot, files);
  } catch (error) {
    for (const transaction of [...transactions].reverse()) {
      rollbackView(registry, transaction.view, transaction.applied);
    }
    for (const backup of [...backups].reverse()) {
      try {
        if (backup.contents) fs.writeFileSync(backup.destination, backup.contents);
        else fs.unlinkSync(backup.destination);
      } catch {}
    }
    for (const backup of [...backups].reverse()) if (!backup.directoryExisted) try { fs.rmdirSync(backup.directory); } catch {}
    if (!installRootExisted) try { fs.rmdirSync(installRoot); } catch {}
    throw error;
  }
  return getRegistrationStatus(options);
}

function repairWordPlugin(options = {}) {
  return installWordPlugin(options);
}

function removeOwnedFiles(installRoot, marker) {
  const kept = [];
  for (const relative of marker?.files || []) {
    if (!['win-x86/Folio.WordAddin.dll', 'win-x64/Folio.WordAddin.dll'].includes(relative.replace(/\\/g, '/'))) continue;
    const filename = path.resolve(installRoot, relative);
    const inside = path.relative(path.resolve(installRoot), filename);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) continue;
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fs.unlinkSync(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') kept.push(relative);
    }
  }
  return kept;
}

function uninstallWordPlugin(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    throw new Error('桌面版 Word COM 插件仅支持 Windows。');
  }
  const registry = options.registry || systemRegistry;
  const installRoot = localInstallRoot(options);
  const marker = markerFromDisk(installRoot);
  const keys = registrationKeys();
  const views = process.platform === 'win32' && process.env.PROCESSOR_ARCHITECTURE === 'x86'
    && !process.env.PROCESSOR_ARCHITEW6432 ? ['32'] : VIEWS;
  for (const view of views) {
    const codeBase = registry.get(`${keys.clsid}\\InprocServer32`, 'CodeBase', view)?.value;
    if (!isOwnedCodeBase(codeBase, installRoot)) continue;
    registry.deleteTree(keys.addin, view);
    registry.deleteTree(keys.progId, view);
    registry.deleteTree(keys.clsid, view);
  }
  const wordRunning = (options.isWordRunning || isWordRunning)();
  const kept = wordRunning ? (marker?.files || []) : removeOwnedFiles(installRoot, marker);
  if (!wordRunning && marker) {
    try { fs.unlinkSync(markerPath(installRoot)); } catch {}
    try { fs.rmdirSync(path.join(installRoot, 'win-x86')); } catch {}
    try { fs.rmdirSync(path.join(installRoot, 'win-x64')); } catch {}
    try { fs.rmdirSync(installRoot); } catch {}
  }
  return {
    installed: false,
    state: wordRunning ? 'restart_required' : 'not_installed',
    wordFound: Boolean(installedWordPath(registry)),
    wordRunning,
    restartRequired: wordRunning,
    cleanupPending: kept.length > 0,
    message: wordRunning
      ? 'Word 正在运行；已移除插件注册项并保留其本地文件。关闭 Word 后再次选择“卸载”以清理文件。'
      : '已移除 Folio Word 插件注册项和本机插件文件；文档及其引用快照未更改。',
  };
}

module.exports = {
  getWordPluginStatus: getRegistrationStatus,
  installWordPlugin,
  repairWordPlugin,
  uninstallWordPlugin,
  constants: { PROG_ID, CLSID, ADDIN_NAME, ASSEMBLY_NAME },
};
