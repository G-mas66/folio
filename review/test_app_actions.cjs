'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  appInfoFields,
  getUninstallerPath,
  isPathWithin,
  requestUninstall,
  submitFeedback,
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

test('feedback sends only trimmed user input and app version to the fixed provider endpoint', async () => {
  let request;
  const result = await submitFeedback({ message: '  App closes after import.  ', contact: '  QQ: folio-user  ', apiKey: 'never send' }, {
    version: '1.0.4',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return { success: true, message: 'accepted' }; } };
    },
  });
  assert.deepEqual(result, { requiresActivation: false });
  assert.equal(request.url, 'https://formsubmit.co/ajax/1791913726@qq.com');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(request.options.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: 'https://github.com/G-mas66/folio',
  });
  assert.deepEqual(JSON.parse(request.options.body), {
    message: 'App closes after import.',
    contact: 'QQ: folio-user',
    app_version: '1.0.4',
    _url: 'https://github.com/G-mas66/folio',
  });
  assert.equal(request.options.signal.aborted, false);
});

test('feedback accepts FormSubmit boolean or string success and reports activation staging', async () => {
  const activationResponse = {
    success: 'false',
    message: "This form needs Activation. We've sent an email containing an 'Activate Form' link.",
  };
  const result = await submitFeedback({ message: 'Please add keyboard shortcuts.' }, {
    version: '1.0.4',
    fetchImpl: async () => ({ ok: true, async json() { return activationResponse; } }),
  });
  assert.deepEqual(result, { requiresActivation: true });

  const accepted = await submitFeedback({ message: 'Thanks.' }, {
    version: '1.0.4',
    fetchImpl: async () => ({ ok: true, async json() { return { success: 'true', message: 'received' }; } }),
  });
  assert.deepEqual(accepted, { requiresActivation: false });
});

test('feedback rejects invalid input before contacting the provider', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, async json() { return { success: true }; } }; };
  const options = { version: '1.0.4', fetchImpl };
  for (const input of [null, {}, { message: '  ' }, { message: 'x'.repeat(5001) }, { message: 'valid', contact: 42 }, { message: 'valid', contact: 'x'.repeat(201) }]) {
    await assert.rejects(submitFeedback(input, options));
  }
  assert.equal(requests, 0);
});

test('feedback does not mistake HTTP, provider, or JSON errors for acceptance', async () => {
  const responses = [
    { ok: false, async json() { return { success: true }; } },
    { ok: true, async json() { return { success: 'false', message: 'rejected' }; } },
    { ok: true, async json() { throw new Error('not JSON'); } },
  ];
  for (const response of responses) {
    await assert.rejects(submitFeedback({ message: 'Retry me' }, {
      version: '1.0.4', fetchImpl: async () => response,
    }), /反馈提交失败，请检查网络后重试/);
  }
});

test('feedback aborts a stalled provider request at the timeout', async () => {
  let receivedSignal;
  await assert.rejects(submitFeedback({ message: 'Retry after timeout' }, {
    version: '1.0.4', timeoutMs: 10,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      receivedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), /反馈提交失败，请检查网络后重试/);
  assert.equal(receivedSignal.aborted, true);
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
