const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

const cacheName = 'paper-workbench-updater';

async function regularFile(file) {
  try { return (await fs.lstat(file)).isFile(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function matches(file, info) {
  if (!await regularFile(file) || (await fs.stat(file)).size !== info.size) return false;
  const hash = crypto.createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64') === info.sha512;
}

async function context(options) {
  const { currentVersion, installerInfo: info } = options;
  if (!info || info.version !== currentVersion || info.fileName !== `Folio-${currentVersion}-Windows-x64-Setup.exe`
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(currentVersion)
    || !Number.isSafeInteger(info.size) || info.size <= 0
    || typeof info.sha512 !== 'string' || Buffer.from(info.sha512, 'base64').length !== 64) return null;
  const dataRoot = path.resolve(options.dataRoot);
  const cacheDir = path.join(dataRoot, '.update-cache', cacheName);
  const legacyDir = options.legacyCacheDir ? path.resolve(options.legacyCacheDir) : null;
  if (legacyDir && path.basename(legacyDir) !== cacheName) throw new Error('Unexpected legacy update cache directory.');
  // Only these cache directories and exact regular files may be changed.
  for (const directory of [path.join(dataRoot, '.update-cache'), cacheDir, legacyDir, path.join(cacheDir, 'pending')]) {
    if (!directory) continue;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked update cache directories are unsupported.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(cacheDir, { recursive: true });
  return { info, cacheDir, target: path.join(cacheDir, 'installer.exe'),
    legacy: legacyDir ? path.join(legacyDir, 'installer.exe') : null };
}

async function commit(source, target, info, overwrite) {
  const temporary = path.join(path.dirname(target), `installer-${crypto.randomUUID()}.tmp`);
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    if (!await matches(temporary, info)) throw new Error('Copied installer checksum mismatch.');
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    if (overwrite) await fs.rename(temporary, target);
    else await fs.link(temporary, target); // Atomic no-overwrite publication.
    if (!await matches(target, info)) throw new Error('Committed installer checksum mismatch.');
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function removeVerified(file, info, target) {
  if (file && path.resolve(file) !== path.resolve(target) && await matches(file, info)) {
    await fs.unlink(file);
    return file;
  }
  return null;
}

async function removeCurrentBlockmap(cacheDir) {
  const file = path.join(cacheDir, 'current.blockmap');
  if (!await regularFile(file)) return null;
  await fs.unlink(file);
  return file;
}

// installerInfo must come from trusted metadata for the running app version.
async function restoreInstallerCache(options) {
  const ctx = await context(options);
  if (!ctx) return { status: 'skipped', reason: 'current-version-metadata-required' };
  try { await fs.lstat(ctx.target); return { status: 'skipped', reason: 'installer-exists' }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ctx.legacy || !await matches(ctx.legacy, ctx.info)) return { status: 'skipped', reason: 'legacy-installer-unverified' };
  await commit(ctx.legacy, ctx.target, ctx.info, false);
  // A cached map has no version marker and may belong to an uninstalled update.
  const mapRemoved = await removeCurrentBlockmap(ctx.cacheDir);
  const removed = await removeVerified(ctx.legacy, ctx.info, ctx.target);
  return { status: 'restored', installer: ctx.target, removed: [mapRemoved, removed].filter(Boolean) };
}

// Call on the new version's startup, before checking or downloading another update.
async function finalizeInstalledUpdateCache(options) {
  const ctx = await context(options);
  if (!ctx) return { status: 'skipped', reason: 'current-version-metadata-required' };
  const pending = path.join(ctx.cacheDir, 'pending');
  const infoFile = path.join(pending, 'update-info.json');
  let pendingInfo;
  if (await regularFile(infoFile)) {
    try { pendingInfo = JSON.parse(await fs.readFile(infoFile, 'utf8')); } catch { /* Preserve unreadable metadata. */ }
  }
  const installedPending = pendingInfo?.fileName === ctx.info.fileName && pendingInfo?.sha512 === ctx.info.sha512;
  const pendingInstaller = path.join(pending, ctx.info.fileName);
  if (!await matches(ctx.target, ctx.info)) {
    let source;
    if (installedPending && await matches(pendingInstaller, ctx.info)) source = pendingInstaller;
    else if (ctx.legacy && await matches(ctx.legacy, ctx.info)) source = ctx.legacy;
    if (!source) return { status: 'skipped', reason: 'installed-installer-unverified' };
    try {
      const targetStat = await fs.lstat(ctx.target);
      if (!targetStat.isFile()) return { status: 'skipped', reason: 'installer-not-regular-file' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await commit(source, ctx.target, ctx.info, true);
  }
  const removed = [];
  const pendingMap = path.join(pending, 'current.blockmap');
  const currentMap = path.join(ctx.cacheDir, 'current.blockmap');
  const mapsMatch = installedPending && await regularFile(pendingMap) && await regularFile(currentMap)
    && (await fs.readFile(pendingMap)).equals(await fs.readFile(currentMap));
  // Fetch the running version's old map from its release on the next download.
  // Download completion can overwrite this map before installation succeeds.
  const mapRemoved = await removeCurrentBlockmap(ctx.cacheDir);
  if (mapRemoved) removed.push(mapRemoved);
  const legacyRemoved = await removeVerified(ctx.legacy, ctx.info, ctx.target);
  if (legacyRemoved) removed.push(legacyRemoved);
  if (installedPending) {
    const pendingRemoved = await removeVerified(pendingInstaller, ctx.info, ctx.target);
    if (pendingRemoved) {
      removed.push(pendingRemoved);
      await fs.unlink(infoFile);
      removed.push(infoFile);
      if (mapsMatch) {
        await fs.unlink(pendingMap);
        removed.push(pendingMap);
      }
    }
    const tempRemoved = await removeVerified(path.join(pending, `temp-${ctx.info.fileName}`), ctx.info, ctx.target);
    if (tempRemoved) removed.push(tempRemoved);
  }
  return { status: 'finalized', installer: ctx.target, removed };
}

module.exports = { restoreInstallerCache, finalizeInstalledUpdateCache };
