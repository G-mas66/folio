'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FEEDBACK_URL = 'mailto:1791913726@qq.com';
const UNINSTALLER_NAME = 'Uninstall 阅川 Folio.exe';

function appPlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'unsupported';
}

function isPathWithin(parent, child, platform = process.platform) {
  if (typeof parent !== 'string' || !parent || typeof child !== 'string' || !child) return false;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function getUninstallerPath({ platform = process.platform, isPackaged = false, executablePath = process.execPath, statSync = fs.statSync } = {}) {
  if (platform !== 'win32' || !isPackaged || typeof executablePath !== 'string' || !path.win32.isAbsolute(executablePath)) return null;
  const candidate = path.win32.join(path.win32.dirname(executablePath), UNINSTALLER_NAME);
  try { return statSync(candidate).isFile() ? candidate : null; } catch { return null; }
}

function getUninstallStatus(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const executablePath = options.executablePath || process.execPath;
  const installDir = typeof executablePath === 'string' ? pathApi.dirname(executablePath) : '';
  const uninstallerPath = getUninstallerPath({ ...options, platform, executablePath });
  const storageRoots = [options.dataRoot, options.credentialRoot, options.uiDataRoot];

  let reason = '';
  if (platform !== 'win32' || !options.isPackaged) reason = '当前环境不支持卸载。';
  else if (options.busy) reason = '文献存储迁移或更新正在进行，请稍后再卸载。';
  else {
    const realpathSync = options.realpathSync || fs.realpathSync.native;
    try {
      const realInstallDir = realpathSync(installDir);
      if (storageRoots.some(root => {
        if (typeof root !== 'string' || !root) throw new Error('Storage path is unavailable.');
        return isPathWithin(installDir, root, platform) || isPathWithin(realInstallDir, realpathSync(root), platform);
      })) {
        reason = '文献数据、凭据或界面数据位于应用安装目录内，请先迁移存储位置后再卸载。';
      }
    } catch {
      reason = '无法确认应用或数据目录的位置，暂时不能卸载。';
    }
    if (!reason && !uninstallerPath) reason = '未找到 Windows 卸载程序。';
  }

  return { canUninstall: !reason, uninstallerPath, reason };
}

function appInfoFields(options = {}) {
  return {
    platform: appPlatform(options.platform || process.platform),
    isPackaged: Boolean(options.isPackaged),
    canUninstall: getUninstallStatus(options).canUninstall,
  };
}

async function openFeedback(shell) {
  await shell.openExternal(FEEDBACK_URL);
}

async function requestUninstall({ owner, dialog, shell, getOptions, ...options }) {
  const status = getUninstallStatus(getOptions ? getOptions() : options);
  if (!status.canUninstall) throw new Error(status.reason);
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '卸载 Folio',
    message: '确定打开 Folio 卸载程序吗？',
    detail: '卸载程序由 Windows 交互运行。文献库、凭据和界面数据会保留。',
    buttons: ['取消', '继续卸载'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return false;
  const finalStatus = getUninstallStatus(getOptions ? getOptions() : options);
  if (!finalStatus.canUninstall) throw new Error(finalStatus.reason);
  const error = await shell.openPath(finalStatus.uninstallerPath);
  if (error) throw new Error('无法启动 Windows 卸载程序。');
  return true;
}

module.exports = { appInfoFields, appPlatform, getUninstallerPath, getUninstallStatus, isPathWithin, openFeedback, requestUninstall };
