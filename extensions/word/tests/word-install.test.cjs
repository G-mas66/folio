'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const installer = require('../../../electron/word-install.cjs');

class MemoryRegistry {
  constructor(wordPath) {
    this.values = new Map();
    this.wordPath = wordPath;
  }
  key(key, name, view) { return `${view}:${key.toLowerCase()}:${name}`; }
  get(key, name, view) {
    if (/app paths\\winword\.exe/i.test(key)) return this.wordPath ? { type: 'REG_SZ', value: this.wordPath } : undefined;
    return this.values.get(this.key(key, name, view));
  }
  set(key, name, value, type, view) { this.values.set(this.key(key, name, view), { type, value: String(value) }); }
  deleteValue(key, name, view) { this.values.delete(this.key(key, name, view)); }
  deleteTree(key, view) {
    const prefix = `${view}:${key.toLowerCase()}`;
    for (const item of this.values.keys()) if (item === prefix || item.startsWith(`${prefix}:`) || item.startsWith(`${prefix}\\`)) this.values.delete(item);
  }
}

function peFile(filename, machine) {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write('PE\0\0', 128, 'ascii');
  bytes.writeUInt16LE(machine, 132);
  fs.writeFileSync(filename, bytes);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-word-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundledRoot = path.join(root, 'bundled');
  for (const name of ['win-x86', 'win-x64']) {
    const directory = path.join(bundledRoot, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'Folio.WordAddin.dll'), name, 'utf8');
  }
  const wordPath = path.join(root, 'WINWORD.EXE');
  peFile(wordPath, 0x8664);
  const userDocument = path.join(root, 'documents', 'paper.docx');
  fs.mkdirSync(path.dirname(userDocument), { recursive: true });
  fs.writeFileSync(userDocument, 'untouched document');
  const localAppData = path.join(root, 'LocalAppData');
  const registry = new MemoryRegistry(wordPath);
  return { root, bundledRoot, wordPath, userDocument, localAppData, registry };
}

test('install registers owned per-user x86/x64 COM and Word add-in entries', (t) => {
  const context = fixture(t);
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => true };
  const status = installer.installWordPlugin(options);
  const keys = [
    'HKCU\\Software\\Classes\\CLSID\\{BF4750C7-9CA5-4C9D-93B7-0DB7349E2F3A}\\InprocServer32',
    'HKCU\\Software\\Classes\\Folio.WordAddin\\CLSID',
    'HKCU\\Software\\Microsoft\\Office\\Word\\Addins\\Folio.WordAddin',
  ];

  assert.equal(status.installed, true);
  assert.equal(status.state, 'restart_required');
  assert.equal(status.wordBitness, 'x64');
  assert.deepEqual(status.views.sort(), ['32', '64']);
  for (const view of ['32', '64']) {
    assert.ok(context.registry.get(keys[0], 'CodeBase', view).value.endsWith(`/win-${view === '64' ? 'x64' : 'x86'}/Folio.WordAddin.dll`));
    assert.equal(context.registry.get(keys[0], 'Class', view).value, 'Connect');
    assert.equal(context.registry.get(keys[1], '', view).value, installer.constants.CLSID);
    assert.equal(context.registry.get(keys[2], 'LoadBehavior', view).value, '3');
  }
  assert.equal(fs.readFileSync(context.userDocument, 'utf8'), 'untouched document');
  assert.equal([...context.registry.values.keys()].some((key) => /TrustCenter|Trusted Locations|Security/i.test(key)), false);
});

test('uninstall removes only Folio registration and owned DLLs after Word exits', (t) => {
  const context = fixture(t);
  let running = true;
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => running };
  installer.installWordPlugin(options);
  const installRoot = path.join(context.localAppData, 'Folio', 'Word', 'native');
  const dll = path.join(installRoot, 'win-x64', 'Folio.WordAddin.dll');
  const keep = path.join(installRoot, 'user-notes.txt');
  fs.writeFileSync(keep, 'not installed by Folio');

  const pending = installer.uninstallWordPlugin(options);
  assert.equal(pending.state, 'restart_required');
  assert.equal(pending.cleanupPending, true);
  assert.equal(fs.existsSync(dll), true);
  assert.equal(fs.readFileSync(context.userDocument, 'utf8'), 'untouched document');
  assert.equal(context.registry.values.size, 0);

  running = false;
  const removed = installer.uninstallWordPlugin(options);
  assert.equal(removed.state, 'not_installed');
  assert.equal(fs.existsSync(dll), false);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'not installed by Folio');
  assert.equal(fs.readFileSync(context.userDocument, 'utf8'), 'untouched document');
});

test('install refuses an existing non-Folio COM registration before copying files', (t) => {
  const context = fixture(t);
  const key = `HKCU\\Software\\Classes\\CLSID\\${installer.constants.CLSID}\\InprocServer32`;
  context.registry.set(key, 'CodeBase', 'file:///C:/OtherPlugin/Other.dll', 'REG_SZ', '32');
  context.registry.set('HKCU\\Software\\Microsoft\\Office\\Word\\Addins\\Folio.WordAddin', 'LoadBehavior', 3, 'REG_DWORD', '32');
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => false };
  assert.throws(() => installer.installWordPlugin(options), /其他组件/);
  assert.equal(fs.existsSync(path.join(context.localAppData, 'Folio', 'Word', 'native')), false);
});

test('repair refuses to replace registered files while Word is running', (t) => {
  const context = fixture(t);
  let running = false;
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => running };
  installer.installWordPlugin(options);
  const dll = path.join(context.localAppData, 'Folio', 'Word', 'native', 'win-x64', 'Folio.WordAddin.dll');
  const installed = fs.readFileSync(dll);
  fs.writeFileSync(path.join(context.bundledRoot, 'win-x64', 'Folio.WordAddin.dll'), 'updated add-in');
  running = true;
  assert.throws(() => installer.repairWordPlugin(options), /关闭 Word/);
  assert.deepEqual(fs.readFileSync(dll), installed);
});

test('a pending uninstall cannot be overwritten while Word still holds the installed add-in', (t) => {
  const context = fixture(t);
  let running = false;
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => running };
  installer.installWordPlugin(options);
  const installRoot = path.join(context.localAppData, 'Folio', 'Word', 'native');
  const dll = path.join(installRoot, 'win-x64', 'Folio.WordAddin.dll');
  const installed = fs.readFileSync(dll);
  running = true;
  assert.equal(installer.uninstallWordPlugin(options).cleanupPending, true);
  fs.writeFileSync(path.join(context.bundledRoot, 'win-x64', 'Folio.WordAddin.dll'), 'new add-in');
  assert.throws(() => installer.installWordPlugin(options), /关闭 Word/);
  assert.deepEqual(fs.readFileSync(dll), installed);
});

test('failed repair restores existing assemblies and prior registrations', (t) => {
  const context = fixture(t);
  const options = { ...context, registry: context.registry, platform: 'win32', isWordRunning: () => false };
  installer.installWordPlugin(options);
  const installRoot = path.join(context.localAppData, 'Folio', 'Word', 'native');
  const files = ['win-x86', 'win-x64'].map((folder) => path.join(installRoot, folder, 'Folio.WordAddin.dll'));
  const previousFiles = files.map((filename) => fs.readFileSync(filename));
  const previousMarker = fs.readFileSync(path.join(installRoot, '.folio-word-plugin.json'));
  for (const folder of ['win-x86', 'win-x64']) {
    fs.writeFileSync(path.join(context.bundledRoot, folder, 'Folio.WordAddin.dll'), 'updated ' + folder);
  }

  const set = context.registry.set.bind(context.registry);
  let failed = false;
  context.registry.set = (key, name, value, type, view) => {
    if (!failed && view === '64' && /\\InprocServer32$/i.test(key) && name === 'Class') {
      failed = true;
      throw new Error('simulated registry failure');
    }
    set(key, name, value, type, view);
  };
  assert.throws(() => installer.repairWordPlugin(options), /simulated registry failure/);
  assert.deepEqual(files.map((filename) => fs.readFileSync(filename)), previousFiles);
  assert.deepEqual(fs.readFileSync(path.join(installRoot, '.folio-word-plugin.json')), previousMarker);
  assert.equal(installer.getWordPluginStatus(options).installed, true);
});
