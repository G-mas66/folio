'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  appInfoFields,
  getUninstallerPath,
  isPathWithin,
  openFeedback,
  requestUninstall,
} = require('../electron/app-actions.cjs');

const executablePath = 'D:\\个人工作台\\应用\\Folio\\paper-workbench\\阅川 Folio.exe';
const installDir = path.win32.dirname(executablePath);
const uninstallerPath = path.win32.join(installDir, 'Uninstall 阅川 Folio.exe');
const safeRoots = {
  dataRoot: 'D:\\个人工作台\\data',
  credentialRoot: 'D:\\个人工作台\\data',
  uiDataRoot: 'D:\\个人工作台\\data\\electron-userData',
};
const statInstalledUninstaller = candidate => ({ isFile: () => candidate === uninstallerPath });

function uninstallOptions(overrides = {}) {
  return {
    platform: 'win32',
    isPackaged: true,
    executablePath,
    ...safeRoots,
    statSync: statInstalledUninstaller,
    realpathSync: value => value,
    ...overrides,
  };
}

test('feedback opens only the fixed mailto draft and does not send it', async () => {
  const opened = [];
  await openFeedback({ openExternal: async value => { opened.push(value); } });
  assert.deepEqual(opened, ['mailto:1791913726@qq.com']);
});

test('uninstaller resolution is limited to the known packaged Windows filename', () => {
  const checked = [];
  const resolved = getUninstallerPath({
    platform: 'win32', isPackaged: true, executablePath,
    statSync: candidate => { checked.push(candidate); return statInstalledUninstaller(candidate); },
  });
  assert.equal(resolved, uninstallerPath);
  assert.deepEqual(checked, [uninstallerPath]);
  assert.equal(getUninstallerPath({ platform: 'darwin', isPackaged: true, executablePath, statSync: statInstalledUninstaller }), null);
  assert.equal(getUninstallerPath({ platform: 'win32', isPackaged: false, executablePath, statSync: statInstalledUninstaller }), null);
});

test('install containment is case-insensitive and respects directory boundaries', () => {
  assert.equal(isPathWithin('D:\\Apps\\Folio', 'd:\\apps\\folio\\data', 'win32'), true);
  assert.equal(isPathWithin('D:\\Apps\\Folio', 'D:\\Apps\\Folio', 'win32'), true);
  assert.equal(isPathWithin('D:\\Apps\\Folio', 'D:\\Apps\\Folio-old\\data', 'win32'), false);
  assert.equal(isPathWithin('D:\\Apps\\Folio', 'D:\\Data', 'win32'), false);
});

test('app info reports platform, packaging, and actual safe uninstaller availability', () => {
  assert.deepEqual(appInfoFields(uninstallOptions()), {
    platform: 'windows', isPackaged: true, canUninstall: true,
  });
  assert.equal(appInfoFields(uninstallOptions({ platform: 'darwin' })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ isPackaged: false })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ busy: true })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ statSync: () => { throw new Error('missing'); } })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ dataRoot: path.win32.join(installDir, 'library') })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ credentialRoot: path.win32.join(installDir, 'credentials') })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({ uiDataRoot: path.win32.join(installDir, 'profile') })).canUninstall, false);
});

test('junction aliases into the install directory and unresolved roots conservatively block uninstall', () => {
  const externalAlias = 'D:\\External\\Folio-data';
  const installAlias = path.win32.join(installDir, 'junction-data');
  const resolveWithJunction = value => value === externalAlias
    ? path.win32.join(installDir, 'junction-data')
    : value;
  assert.equal(appInfoFields(uninstallOptions({
    dataRoot: externalAlias,
    realpathSync: resolveWithJunction,
  })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({
    dataRoot: installAlias,
    realpathSync: value => value === installAlias ? 'D:\\External\\Folio-data' : value,
  })).canUninstall, false);
  assert.equal(appInfoFields(uninstallOptions({
    realpathSync: () => { throw new Error('unresolvable'); },
  })).canUninstall, false);
});

test('canceling the native uninstall confirmation returns false without dispatching the uninstaller', async () => {
  let dialogs = 0;
  let launches = 0;
  const owner = {};
  const cancelled = await requestUninstall({
    owner,
    dialog: { async showMessageBox(receivedOwner, options) {
      dialogs += 1;
      assert.equal(receivedOwner, owner);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      return { response: 0 };
    } },
    shell: { async openPath() { launches += 1; return ''; } },
    ...uninstallOptions(),
  });
  assert.equal(cancelled, false);
  assert.equal(dialogs, 1);
  assert.equal(launches, 0);
});

test('confirmation dispatches only the known interactive uninstaller through the stub', async () => {
  let openedPath;
  let dialogOptions;
  const started = await requestUninstall({
    owner: {},
    dialog: { async showMessageBox(_owner, options) { dialogOptions = options; return { response: 1 }; } },
    shell: { async openPath(value) { openedPath = value; return ''; } },
    ...uninstallOptions(),
  });
  assert.equal(started, true);
  assert.equal(openedPath, uninstallerPath);
  assert.deepEqual(dialogOptions.buttons, ['取消', '继续卸载']);
});

test('state is revalidated after confirmation before dispatch', async () => {
  let reads = 0;
  let launches = 0;
  await assert.rejects(requestUninstall({
    owner: {},
    dialog: { async showMessageBox() { return { response: 1 }; } },
    shell: { async openPath() { launches += 1; return ''; } },
    getOptions: () => uninstallOptions({ busy: ++reads > 1 }),
  }), /迁移或更新正在进行/);
  assert.equal(reads, 2);
  assert.equal(launches, 0);
});

test('unsafe data roots and busy state reject before confirmation or dispatch', async () => {
  for (const options of [
    uninstallOptions({ dataRoot: path.win32.join(installDir, 'library') }),
    uninstallOptions({ credentialRoot: path.win32.join(installDir, 'credentials') }),
    uninstallOptions({ uiDataRoot: path.win32.join(installDir, 'profile') }),
    uninstallOptions({ busy: true }),
  ]) {
    let dialogs = 0;
    let launches = 0;
    await assert.rejects(requestUninstall({
      owner: {},
      dialog: { async showMessageBox() { dialogs += 1; return { response: 1 }; } },
      shell: { async openPath() { launches += 1; return ''; } },
      ...options,
    }));
    assert.equal(dialogs, 0);
    assert.equal(launches, 0);
  }
});

test('openPath errors are reported without invoking another uninstall path', async () => {
  await assert.rejects(requestUninstall({
    owner: {},
    dialog: { async showMessageBox() { return { response: 1 }; } },
    shell: { async openPath(value) { assert.equal(value, uninstallerPath); return 'open failed'; } },
    ...uninstallOptions(),
  }), /无法启动 Windows 卸载程序/);
});
