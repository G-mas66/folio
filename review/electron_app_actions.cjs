const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const executable = process.env.REVIEW_EXECUTABLE;
assert.ok(executable && fs.existsSync(executable), 'Set REVIEW_EXECUTABLE to an isolated Folio build');
const output = path.join(root, '.review', `app-actions-${Date.now()}`);
const dataRoot = path.join(output, 'data');
const credentialRoot = path.join(output, 'credentials');
const locationConfig = path.join(output, 'location.json');
const userProfile = path.join(output, 'user-profile');
const temp = path.join(output, 'temp');
const appData = path.join(userProfile, 'AppData', 'Roaming');
const localAppData = path.join(userProfile, 'AppData', 'Local');
for (const directory of [dataRoot, path.join(dataRoot, 'ui'), credentialRoot, temp, appData, localAppData]) fs.mkdirSync(directory, { recursive: true });

const checks = [];
let application;

(async () => {
  const env = {
    ...process.env,
    WORKBENCH_DATA_DIR: dataRoot,
    WORKBENCH_CREDENTIAL_ROOT: credentialRoot,
    WORKBENCH_LOCATION_CONFIG: locationConfig,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: userProfile,
    TEMP: temp,
    TMP: temp,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WORKBENCH_DEV;

  try {
    application = await _electron.launch({ executablePath: executable, args: [], cwd: root, env, timeout: 90000 });
    const page = await application.firstWindow();
    await page.locator('.topbar').waitFor();
    await application.evaluate(({ shell, dialog }) => {
      const trace = globalThis.__folioNativeActionTrace = { external: [], paths: [], dialogs: 0, feedback: [] };
      const openExternal = async url => { trace.external.push(url); };
      const openPath = async filePath => { trace.paths.push(filePath); return 'Review blocked external process launch'; };
      const showMessageBox = async () => { trace.dialogs += 1; return { response: 0 }; };
      const realFetch = globalThis.fetch;
      const feedbackEndpoint = 'https://formsubmit.co/ajax/1791913726@qq.com';
      const reviewFetch = async (url, options = {}) => {
        if (String(url) !== feedbackEndpoint) return realFetch(url, options);
        trace.feedback.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
        return { ok: true, async json() { return { success: 'true', message: 'accepted' }; } };
      };
      shell.openExternal = openExternal;
      shell.openPath = openPath;
      dialog.showMessageBox = showMessageBox;
      globalThis.fetch = reviewFetch;
      if (shell.openExternal !== openExternal || shell.openPath !== openPath || dialog.showMessageBox !== showMessageBox || globalThis.fetch !== reviewFetch) {
        throw new Error('Could not install safe shell/dialog stubs; refusing native action checks.');
      }
    });

    assert.equal(await page.locator('.topbar-new-tab').count(), 0, 'The utilitybar new-tab plus is removed');
    for (const testId of ['theme-toggle', 'eye-comfort-toggle', 'settings-tab']) {
      assert.equal(await page.getByTestId(testId).isVisible(), true, `${testId} stays visible`);
    }
    assert.equal(await page.getByRole('button', { name: '新建文件夹', exact: true }).isVisible(), true, 'Folder creation remains available');
    assert.equal(await page.locator('.import-button').isVisible(), true, 'PDF import remains available');
    checks.push('utilitybar plus removed; theme, eye, settings, folder and import controls remain');

    await page.getByRole('button', { name: '意见反馈', exact: true }).click();
    await page.getByRole('textbox', { name: '反馈内容' }).fill('Native feedback IPC smoke check');
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.locator('.success-notice').waitFor();
    const nativeFeedback = await application.evaluate(() => ({
      requests: globalThis.__folioNativeActionTrace.feedback,
      external: globalThis.__folioNativeActionTrace.external,
    }));
    assert.equal(nativeFeedback.requests.length, 1);
    assert.equal(nativeFeedback.requests[0].url, 'https://formsubmit.co/ajax/1791913726@qq.com');
    assert.equal(nativeFeedback.requests[0].method, 'POST');
    assert.equal(nativeFeedback.requests[0].headers.Referer, 'https://github.com/G-mas66/folio');
    assert.deepEqual(JSON.parse(nativeFeedback.requests[0].body), {
      message: 'Native feedback IPC smoke check',
      app_version: '1.0.4',
      _url: 'https://github.com/G-mas66/folio',
    });
    assert.deepEqual(nativeFeedback.external, [], 'Feedback must not open an external mail app');
    checks.push('real feedback IPC submitted only message/version to the fixed FormSubmit endpoint stub');

    const nativeAppInfo = await page.evaluate(() => window.workbench.getAppInfo());
    assert.equal(nativeAppInfo.platform, 'windows');
    assert.equal(nativeAppInfo.isPackaged, true);
    assert.equal(nativeAppInfo.canUninstall, false, 'The win-unpacked candidate has no NSIS uninstaller');
    const nativeUninstall = await page.evaluate(async () => {
      try { return { value: await window.workbench.uninstallApp() }; }
      catch (error) { return { error: error?.message || String(error) }; }
    });
    assert.match(nativeUninstall.error, /未找到 Windows 卸载程序/);
    const nativeGuards = await application.evaluate(() => ({ paths: globalThis.__folioNativeActionTrace.paths, dialogs: globalThis.__folioNativeActionTrace.dialogs }));
    assert.deepEqual(nativeGuards, { paths: [], dialogs: 0 }, 'Portable uninstaller rejection must not open a dialog or a real executable');
    checks.push('real getAppInfo/uninstall IPC reports portable uninstall unavailable before dialog or shell launch');

    await page.getByTestId('settings-tab').click();
    const nativeUninstallSection = page.getByRole('region', { name: '应用卸载' });
    await nativeUninstallSection.waitFor();
    assert.equal(await page.getByTestId('uninstall-app').isDisabled(), true);
    assert.equal(await nativeUninstallSection.innerText().then(text => text.includes('当前无法从应用内启动卸载，请检查安装与存储位置。')), true);
    await page.screenshot({ path: path.join(output, 'settings-native-uninstall-unavailable.png') });
    checks.push('native portable metadata renders disabled uninstall guidance');

    await application.evaluate(({ ipcMain }) => {
      const state = globalThis.__folioUiReview = {
        calls: [],
        feedbackInput: null,
        info: {
          dataRoot: 'REVIEW_DATA_ROOT',
          uiDataRoot: 'REVIEW_UI_ROOT',
          credentialRoot: 'REVIEW_CREDENTIAL_ROOT',
          locationConfigPath: 'REVIEW_LOCATION_CONFIG',
          platform: 'windows',
          isPackaged: true,
          canUninstall: true,
        },
        uninstallResult: false,
        uninstallFailure: '',
      };
      for (const channel of ['workbench:get-app-info', 'workbench:submit-feedback', 'workbench:uninstall-app']) ipcMain.removeHandler(channel);
      ipcMain.handle('workbench:get-app-info', () => ({ ...state.info }));
      ipcMain.handle('workbench:submit-feedback', (_event, input) => {
        state.calls.push('feedback');
        state.feedbackInput = input;
        return { requiresActivation: false };
      });
      ipcMain.handle('workbench:uninstall-app', () => {
        state.calls.push('uninstall');
        if (state.uninstallFailure) throw new Error(state.uninstallFailure);
        return state.uninstallResult;
      });
    });

    await page.getByTestId('library-tab').click();
    await page.getByRole('button', { name: '意见反馈', exact: true }).click();
    await page.getByRole('textbox', { name: '反馈内容' }).fill('UI feedback dialog check');
    await page.getByRole('button', { name: '提交反馈', exact: true }).click();
    await page.locator('.success-notice').filter({ hasText: '反馈服务已接收，感谢你的建议。' }).waitFor();
    const uiFeedback = await application.evaluate(() => ({
      calls: globalThis.__folioUiReview.calls,
      input: globalThis.__folioUiReview.feedbackInput,
    }));
    assert.deepEqual(uiFeedback.calls, ['feedback']);
    assert.deepEqual(uiFeedback.input, { message: 'UI feedback dialog check', contact: '' });
    checks.push('feedback dialog submits its text through the mocked bridge and shows the success notice');

    await page.getByTestId('settings-tab').click();
    const uninstallSection = page.getByRole('region', { name: '应用卸载' });
    await uninstallSection.waitFor();
    assert.equal(await page.getByTestId('uninstall-app').isEnabled(), true);
    assert.equal(await uninstallSection.innerText().then(text => text.includes('打开卸载程序，文献库保留。')), true);

    await page.getByTestId('uninstall-app').click();
    assert.equal(await page.getByRole('alert').count(), 0, 'Cancelling native confirmation is not shown as an error');
    await application.evaluate(() => { globalThis.__folioUiReview.uninstallResult = true; });
    await page.getByTestId('uninstall-app').click();
    assert.equal(await page.getByRole('alert').count(), 0, 'Successful dispatch is not shown as an error');
    await application.evaluate(() => { globalThis.__folioUiReview.uninstallFailure = 'Synthetic uninstall failure'; });
    await page.getByTestId('uninstall-app').click();
    assert.match(await page.getByRole('alert').innerText(), /Synthetic uninstall failure/);
    checks.push('available uninstall renders, cancellation is quiet, dispatch succeeds and errors are surfaced');

    await page.getByTestId('library-tab').click();
    await application.evaluate(() => {
      globalThis.__folioUiReview.info.canUninstall = false;
      globalThis.__folioUiReview.uninstallFailure = '';
    });
    await page.getByTestId('settings-tab').click();
    await uninstallSection.waitFor();
    assert.equal(await page.getByTestId('uninstall-app').isDisabled(), true);
    assert.equal(await uninstallSection.innerText().then(text => text.includes('当前无法从应用内启动卸载，请检查安装与存储位置。')), true);
    await page.screenshot({ path: path.join(output, 'settings-uninstall-unavailable.png') });
    checks.push('unavailable uninstall is disabled with the recovery guidance');

    await page.getByTestId('library-tab').click();
    await application.evaluate(() => { globalThis.__folioUiReview.info.platform = 'macos'; });
    await page.getByTestId('settings-tab').click();
    assert.equal(await page.getByRole('region', { name: '应用卸载' }).count(), 0, 'Uninstall section is hidden outside Windows');
    checks.push('uninstall section is hidden outside Windows');

    const result = { passed: true, checks, output };
    fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (application) {
      try { await (await application.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }); } catch {}
    }
    const result = { passed: false, checks, output, error: error.stack || String(error) };
    fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (application) await application.close().catch(() => undefined);
  }
})();
