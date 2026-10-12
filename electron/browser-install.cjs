'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const hostName = 'com.folio.browser_bridge';

async function registerBrowserHost({ executable, originsFile, directory, development = false, platform = process.platform, execute = run }) {
  if (platform !== 'win32') return { installed: false, message: '自动连接目前支持 Windows。' };
  await fs.access(executable);
  const configuration = JSON.parse(await fs.readFile(originsFile, 'utf8'));
  const origins = [...new Set(configuration[development ? 'development' : 'production'] || [])];
  if (origins.some(origin => !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin))) throw new Error('浏览器扩展身份配置无效。');
  await fs.mkdir(directory, { recursive: true });
  const manifest = path.join(directory, `${hostName}.json`);
  await fs.writeFile(manifest, JSON.stringify({ name: hostName, description: 'Folio 本机文献收藏连接', path: path.resolve(executable), type: 'stdio', allowed_origins: origins }, null, 2));
  if (!origins.length) return { installed: false, message: '尚未配置商店扩展 ID，浏览器自动连接未注册。开发版可通过开发预览入口启动。' };
  for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) {
    await execute('reg.exe', ['add', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${hostName}`, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { windowsHide: true });
  }
  return { installed: true, message: 'Chrome／Edge 自动连接已就绪，无需填写凭证。' };
}

module.exports = { registerBrowserHost };
