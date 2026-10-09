const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { restoreInstallerCache, finalizeInstalledUpdateCache } = require('../electron/update-cache.cjs');

const testRoot = path.resolve(__dirname, '../.review/update-cache-fixtures');
const installed = Buffer.from('verified installed current package');
const currentVersion = '0.14.0-beta.4';
const installerInfo = { version: currentVersion, fileName: `Folio-${currentVersion}-Windows-x64-Setup.exe`,
  size: installed.length, sha512: crypto.createHash('sha512').update(installed).digest('base64') };

async function fixture(run) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'fixture-'));
  const dataRoot = path.join(root, 'custom-data');
  const cacheDir = path.join(dataRoot, '.update-cache/paper-workbench-updater');
  const legacyCacheDir = path.join(root, 'localappdata/paper-workbench-updater');
  const pending = path.join(cacheDir, 'pending');
  await fs.mkdir(pending, { recursive: true });
  await fs.mkdir(legacyCacheDir, { recursive: true });
  const options = { dataRoot, legacyCacheDir, currentVersion, installerInfo };
  const target = path.join(cacheDir, 'installer.exe');
  const legacy = path.join(legacyCacheDir, 'installer.exe');
  try { await run({ options, root, cacheDir, pending, target, legacy }); }
  finally {
    const resolved = await fs.realpath(root);
    const parent = await fs.realpath(testRoot);
    assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('fixture-'));
    await fs.rm(resolved, { recursive: true });
  }
}

test('missing custom data-root cache restores only verified current installer and removes duplicate', () => fixture(async ({ options, target, legacy }) => {
  await fs.writeFile(legacy, installed);
  const result = await restoreInstallerCache(options);
  assert.equal(result.status, 'restored');
  assert.deepEqual(await fs.readFile(target), installed);
  await assert.rejects(fs.access(legacy), { code: 'ENOENT' });
}));

test('legacy restoration discards root blockmap left by another version', () => fixture(async ({ options, target, legacy, cacheDir }) => {
  await fs.writeFile(legacy, installed);
  const oldMap = path.join(cacheDir, 'current.blockmap');
  await fs.writeFile(oldMap, 'map from a different installer');
  assert.equal((await restoreInstallerCache(options)).status, 'restored');
  assert.deepEqual(await fs.readFile(target), installed);
  await assert.rejects(fs.access(oldMap), { code: 'ENOENT' });
}));

test('manual upgrade replaces the previous installer and discards its old root map', () => fixture(async ({ options, target, legacy, cacheDir }) => {
  await fs.writeFile(target, 'previous installed installer');
  await fs.writeFile(legacy, installed);
  const oldMap = path.join(cacheDir, 'current.blockmap');
  await fs.writeFile(oldMap, 'previous installed map');
  assert.equal((await finalizeInstalledUpdateCache(options)).status, 'finalized');
  assert.deepEqual(await fs.readFile(target), installed);
  await assert.rejects(fs.access(oldMap), { code: 'ENOENT' });
}));

test('invalid legacy hash or wrong version is preserved and never adopted', () => fixture(async ({ options, target, legacy }) => {
  await fs.writeFile(legacy, Buffer.alloc(installed.length, 65));
  assert.equal((await restoreInstallerCache(options)).reason, 'legacy-installer-unverified');
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await fs.access(legacy);
  await fs.writeFile(legacy, installed);
  assert.equal((await restoreInstallerCache({ ...options, currentVersion: '0.14.0-beta.3' })).reason, 'current-version-metadata-required');
  await fs.access(legacy);
}));

test('restore never overwrites existing cache installer', () => fixture(async ({ options, target, legacy }) => {
  const old = Buffer.from('existing package');
  await fs.writeFile(target, old);
  await fs.writeFile(legacy, installed);
  assert.equal((await restoreInstallerCache(options)).reason, 'installer-exists');
  assert.deepEqual(await fs.readFile(target), old);
  await fs.access(legacy);
}));

test('uninstalled pending update survives while its prematurely promoted root map is discarded', () => fixture(async ({ options, target, legacy, pending, cacheDir }) => {
  const next = 'Folio-0.14.0-beta.5-Windows-x64-Setup.exe';
  await fs.writeFile(legacy, installed);
  await fs.writeFile(path.join(pending, next), 'next package');
  const metadata = JSON.stringify({ fileName: next, sha512: 'next-checksum' });
  await fs.writeFile(path.join(pending, 'update-info.json'), metadata);
  await fs.writeFile(path.join(pending, 'current.blockmap'), 'next-map');
  await fs.writeFile(path.join(cacheDir, 'current.blockmap'), 'next-map');
  await fs.writeFile(target, installed);
  assert.equal((await finalizeInstalledUpdateCache(options)).status, 'finalized');
  assert.deepEqual(await fs.readFile(target), installed);
  assert.equal(await fs.readFile(path.join(pending, 'update-info.json'), 'utf8'), metadata);
  assert.equal(await fs.readFile(path.join(pending, next), 'utf8'), 'next package');
  assert.equal(await fs.readFile(path.join(pending, 'current.blockmap'), 'utf8'), 'next-map');
  await assert.rejects(fs.access(path.join(cacheDir, 'current.blockmap')), { code: 'ENOENT' });
}));

test('successful upgrade retains one current installer and removes only identified duplicate files', () => fixture(async ({ options, target, legacy, cacheDir, pending }) => {
  await fs.writeFile(target, 'old installed installer');
  await fs.writeFile(legacy, installed);
  await fs.writeFile(path.join(pending, installerInfo.fileName), installed);
  await fs.writeFile(path.join(pending, `temp-${installerInfo.fileName}`), installed);
  await fs.writeFile(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: installerInfo.fileName, sha512: installerInfo.sha512 }));
  await fs.writeFile(path.join(pending, 'current.blockmap'), 'current-map');
  await fs.writeFile(path.join(cacheDir, 'current.blockmap'), 'current-map');
  await fs.writeFile(path.join(pending, 'unrelated.txt'), 'leave alone');
  assert.equal((await finalizeInstalledUpdateCache(options)).status, 'finalized');
  assert.deepEqual(await fs.readFile(target), installed);
  await assert.rejects(fs.access(legacy), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(pending), ['unrelated.txt']);
  await assert.rejects(fs.access(path.join(cacheDir, 'current.blockmap')), { code: 'ENOENT' });
}));

test('failed installer verification retains old baseline/map and pending metadata/package', () => fixture(async ({ options, target, legacy, pending, cacheDir }) => {
  await fs.writeFile(target, 'previous baseline');
  await fs.writeFile(path.join(cacheDir, 'current.blockmap'), 'previous map');
  await fs.writeFile(legacy, 'wrong seed');
  await fs.writeFile(path.join(pending, installerInfo.fileName), 'wrong pending');
  const metadata = JSON.stringify({ fileName: installerInfo.fileName, sha512: installerInfo.sha512 });
  await fs.writeFile(path.join(pending, 'update-info.json'), metadata);
  assert.equal((await finalizeInstalledUpdateCache(options)).reason, 'installed-installer-unverified');
  assert.equal(await fs.readFile(target, 'utf8'), 'previous baseline');
  assert.equal(await fs.readFile(path.join(cacheDir, 'current.blockmap'), 'utf8'), 'previous map');
  assert.equal(await fs.readFile(path.join(pending, installerInfo.fileName), 'utf8'), 'wrong pending');
  assert.equal(await fs.readFile(path.join(pending, 'update-info.json'), 'utf8'), metadata);
  await fs.access(legacy);
}));

test('linked pending cache is rejected without deleting outside files', () => fixture(async ({ options, root, pending, legacy }) => {
  await fs.rmdir(pending);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, pending, 'junction');
  await fs.writeFile(legacy, installed);
  await assert.rejects(finalizeInstalledUpdateCache(options), /Linked update cache/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
}));
