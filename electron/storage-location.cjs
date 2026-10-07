'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA_ROOT = 'D:\\个人工作台\\data';
const DEFAULT_LOCATION_CONFIG = 'D:\\个人工作台\\config\\location.json';

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label}必须是绝对路径。`);
  }
  return path.resolve(value);
}

function resolveLocationConfig(configPath, env = process.env, defaultDataRoot = DEFAULT_DATA_ROOT, defaultConfigPath = DEFAULT_LOCATION_CONFIG) {
  const filePath = absolutePath(configPath || env.WORKBENCH_LOCATION_CONFIG || defaultConfigPath, '配置文件路径');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('存储位置配置格式无效。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const envDataRoot = env.WORKBENCH_DATA_DIR;
  const dataRoot = absolutePath(envDataRoot || saved.dataRoot || defaultDataRoot, '文献存储位置');
  const credentialRoot = absolutePath(env.WORKBENCH_CREDENTIAL_ROOT || (!envDataRoot && saved.credentialRoot) || dataRoot, '凭据身份位置');
  const uiDataRoot = absolutePath((!envDataRoot && saved.uiDataRoot) || path.join(dataRoot, 'electron-userData'), '界面数据位置');
  return {
    dataRoot,
    credentialRoot,
    uiDataRoot,
    locationConfigPath: filePath,
    configuredDataRoot: !envDataRoot && Boolean(saved.dataRoot),
  };
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireNoReparsePoints(value, label) {
  const absolute = absolutePath(value, label);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch { throw new Error(`${label}中的路径不存在或不可访问。`); }
    if (info.isSymbolicLink()) throw new Error(`${label}不能包含符号链接或 junction。`);
  }
  const finalInfo = fs.lstatSync(absolute);
  if (!finalInfo.isDirectory()) throw new Error(`${label}必须是文件夹。`);
  return fs.realpathSync.native(absolute);
}

function validateStorageTarget(source, target) {
  const sourcePath = requireNoReparsePoints(source, '当前文献目录');
  const targetPath = requireNoReparsePoints(target, '目标文献目录');
  if (normalizedPath(sourcePath) === normalizedPath(targetPath)) throw new Error('目标必须与当前文献目录不同。');
  if (isWithin(sourcePath, targetPath) || isWithin(targetPath, sourcePath)) {
    throw new Error('目标目录不能是当前文献目录的上级或下级。');
  }
  if (path.dirname(targetPath) === targetPath) throw new Error('不能将磁盘根目录用作文献存储位置。');
  if (fs.readdirSync(targetPath).length !== 0) throw new Error('目标文件夹必须为空；现有文件不会被覆盖。');
  return { source: sourcePath, target: targetPath };
}

function listStorageFiles(source, uiDataRoot) {
  const files = [];
  const directories = [];
  function visit(relative) {
    const current = path.join(source, relative);
    for (const name of fs.readdirSync(current)) {
      if (!relative && name === '.backend-temp') continue;
      const entry = path.join(current, name);
      const entryRelative = relative ? path.join(relative, name) : name;
      if (uiDataRoot && isWithin(uiDataRoot, entry)) continue;
      const info = fs.lstatSync(entry);
      if (info.isSymbolicLink()) throw new Error('文献目录中包含符号链接或 junction，已停止迁移。');
      if (info.isDirectory()) {
        directories.push(entryRelative);
        visit(entryRelative);
      } else if (info.isFile()) {
        files.push({ relative: entryRelative, size: info.size });
      } else {
        throw new Error('文献目录包含无法安全复制的文件类型。');
      }
    }
  }
  visit('');
  return { files, directories };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function removeOwnedStage(stagePath, targetParent) {
  if (path.dirname(stagePath) !== targetParent || !/^\.folio-storage-stage-[a-f0-9-]+$/i.test(path.basename(stagePath))) return;
  try {
    const info = fs.lstatSync(stagePath);
    if (info.isDirectory() && !info.isSymbolicLink()) fs.rmSync(stagePath, { recursive: true, force: true });
  } catch {}
}

function writeLocationConfigAtomic(configPath, config) {
  const destination = absolutePath(configPath, '配置文件路径');
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  requireNoReparsePoints(parent, '配置文件目录');
  try {
    if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('配置文件不能是符号链接或 junction。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `.location-${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { if (path.dirname(temporary) === parent) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function copyAndVerifyStorage(source, target, options = {}) {
  const { configPath, config, onProgress } = options;
  if (!configPath || !config || typeof config !== 'object') throw new Error('迁移配置无效。');
  const paths = validateStorageTarget(source, target);
  const configFile = absolutePath(configPath, '配置文件路径');
  if (isWithin(paths.source, configFile) || isWithin(paths.target, configFile)) throw new Error('位置配置必须保存在文献目录之外。');
  const uiRoot = options.uiDataRoot ? fs.realpathSync.native(absolutePath(options.uiDataRoot, '界面数据位置')) : null;
  if (uiRoot && isWithin(uiRoot, paths.source)) throw new Error('界面数据位置不能包含当前文献目录。');

  const plan = listStorageFiles(paths.source, uiRoot);
  const totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
  const id = crypto.randomUUID();
  const parent = path.dirname(paths.target);
  const stage = path.join(parent, `.folio-storage-stage-${id}`);
  const emptyBackup = path.join(parent, `.folio-storage-empty-${id}`);
  let targetMoved = false;
  let stageMoved = false;
  let configWritten = false;
  let copiedBytes = 0;
  const copiedHashes = [];

  try {
    fs.mkdirSync(stage);
    for (const relative of plan.directories.sort((a, b) => a.length - b.length)) {
      fs.mkdirSync(path.join(stage, relative));
    }
    for (let index = 0; index < plan.files.length; index += 1) {
      const file = plan.files[index];
      const original = path.join(paths.source, file.relative);
      const copy = path.join(stage, file.relative);
      await fs.promises.copyFile(original, copy);
      const [originalHash, copyHash] = await Promise.all([hashFile(original), hashFile(copy)]);
      const originalAfter = fs.statSync(original);
      const copyInfo = fs.statSync(copy);
      if (originalHash !== copyHash || originalAfter.size !== file.size || copyInfo.size !== file.size) {
        throw new Error(`文件校验失败：${file.relative}`);
      }
      copiedHashes.push(originalHash);
      copiedBytes += file.size;
      if (onProgress) onProgress({ copiedFiles: index + 1, totalFiles: plan.files.length, copiedBytes, totalBytes });
    }
    const after = listStorageFiles(paths.source, uiRoot).files;
    if (after.length !== plan.files.length || after.some((file, index) => file.relative !== plan.files[index].relative || file.size !== plan.files[index].size)) {
      throw new Error('迁移期间源目录发生变化；没有切换存储位置。');
    }
    for (let index = 0; index < plan.files.length; index += 1) {
      const relative = plan.files[index].relative;
      const [sourceHash, stagedHash] = await Promise.all([
        hashFile(path.join(paths.source, relative)),
        hashFile(path.join(stage, relative)),
      ]);
      if (sourceHash !== copiedHashes[index] || stagedHash !== copiedHashes[index]) {
        throw new Error(`校验期间文件发生变化：${relative}`);
      }
    }

    fs.renameSync(paths.target, emptyBackup);
    targetMoved = true;
    fs.renameSync(stage, paths.target);
    stageMoved = true;
    writeLocationConfigAtomic(configFile, { ...config, dataRoot: paths.target });
    configWritten = true;
    try { fs.rmdirSync(emptyBackup); } catch { /* leave only the original empty destination if cleanup is blocked */ }
    return { dataRoot: paths.target, copiedFiles: plan.files.length, copiedBytes };
  } catch (error) {
    if (!configWritten) {
      try {
        if (stageMoved && fs.existsSync(paths.target)) fs.renameSync(paths.target, stage);
        if (targetMoved && fs.existsSync(emptyBackup)) fs.renameSync(emptyBackup, paths.target);
      } catch {
        throw new Error('迁移未完成；原文献目录和旧配置仍保留，但目标目录回滚失败，请勿删除临时目录。');
      }
    }
    removeOwnedStage(stage, parent);
    try {
      if (path.dirname(emptyBackup) === parent && /^\.folio-storage-empty-[a-f0-9-]+$/i.test(path.basename(emptyBackup))) fs.rmdirSync(emptyBackup);
    } catch {}
    throw error;
  }
}

module.exports = {
  DEFAULT_DATA_ROOT,
  DEFAULT_LOCATION_CONFIG,
  resolveLocationConfig,
  validateStorageTarget,
  copyAndVerifyStorage,
  writeLocationConfigAtomic,
};
