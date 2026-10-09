const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CancellationError, CancellationToken } = require('builder-util-runtime');
const { NsisUpdater } = require('electron-updater');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { createTransportProvider, downloadUpdateWithFallback, isDownloadFallbackActive } = require('../electron/update-download.cjs');

const installer = 'https://github.com/G-mas66/folio/releases/download/v0.14.0-beta.4/Folio-0.14.0-beta.4-Windows-x64-Setup.exe';
const officialSha512 = 'trusted-official-sha512';
const testRoot = path.resolve(__dirname, '.tmp');

function makeTestTempDir(prefix) {
  fs.mkdirSync(testRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testRoot, prefix));
}

function removeTestTempDir(directory) {
  const resolved = path.resolve(directory);
  const relative = path.relative(testRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a path outside the update test temp directory.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function createProvider(info) {
  return {
    isUseMultipleRangeRequest: true,
    resolveFiles(updateInfo) {
      return updateInfo.files.map(file => ({ url: new URL(file.url), info: file }));
    },
    getBlockMapFiles(newUrl, oldVersion, newVersion) {
      const oldUrl = new URL(newUrl.href.replaceAll(newVersion, oldVersion) + '.blockmap');
      const newMapUrl = new URL(`${newUrl.href}.blockmap`);
      return [oldUrl, newMapUrl];
    },
  };
}

function createFixture({ cachedInstaller = false } = {}) {
  const info = { version: '0.14.0-beta.4', files: [{ url: installer, size: 100, sha512: officialSha512 }] };
  const provider = createProvider(info);
  const updater = new EventEmitter();
  updater.updateInfoAndProvider = { info, provider };
  updater.fullDownloads = [];
  updater.httpExecutor = {
    async download(url, _destination, options) {
      updater.fullDownloads.push({ url: String(url), sha512: options?.sha512 });
      return 'downloaded';
    },
  };
  if (cachedInstaller) {
    const cacheDir = makeTestTempDir('folio-update-cache-');
    fs.writeFileSync(path.join(cacheDir, 'installer.exe'), 'previous verified package');
    updater.downloadedUpdateHelper = { cacheDir };
    updater.cleanup = () => removeTestTempDir(cacheDir);
  }
  return updater;
}

test('normal differential attempt proxies only installer and blockmaps, keeps official info and single-range', async () => {
  const updater = createFixture();
  const original = updater.updateInfoAndProvider;
  const token = new CancellationToken();
  updater.downloadUpdate = async receivedToken => {
    assert.equal(receivedToken, token);
    const current = updater.updateInfoAndProvider;
    assert.equal(current.info, original.info);
    assert.equal(current.info.files[0].sha512, officialSha512);
    assert.equal(current.provider.isUseMultipleRangeRequest, false);
    const [file] = current.provider.resolveFiles(current.info);
    assert.equal(file.url.hostname, 'ghfast.top');
    assert.equal(file.info, current.info.files[0]);
    const maps = await current.provider.getBlockMapFiles(file.url, '0.14.0-beta.3', current.info.version);
    assert.deepEqual(maps.map(url => url.hostname), ['ghfast.top', 'ghfast.top']);
    assert.deepEqual(maps.map(url => url.pathname.endsWith('.blockmap')), [true, true]);
    return ['differential-update.exe'];
  };
  assert.deepEqual(await downloadUpdateWithFallback(updater, token), ['differential-update.exe']);
  assert.equal(updater.updateInfoAndProvider, original);
});

test('GitHubProvider blockmaps use the mirrored old and new release paths exactly once', async () => {
  const version = '0.14.0-beta.4';
  const provider = new GitHubProvider({ owner: 'G-mas66', repo: 'folio' }, {
    channel: 'beta', currentVersion: { raw: '0.14.0-beta.3' },
  }, { platform: 'win32', arch: 'x64', executor: {} });
  const info = {
    tag: `v${version}`,
    version,
    files: [{ url: `Folio-${version}-Windows-x64-Setup.exe`, sha512: officialSha512 }],
  };
  const proxied = createTransportProvider(provider, 'ghfast');
  const [file] = proxied.resolveFiles(info);
  const maps = await proxied.getBlockMapFiles(file.url, '0.14.0-beta.3', version);
  assert.deepEqual(maps.map(url => url.href), [
    'https://ghfast.top/https://github.com/G-mas66/folio/releases/download/v0.14.0-beta.3/Folio-0.14.0-beta.3-Windows-x64-Setup.exe.blockmap',
    'https://ghfast.top/https://github.com/G-mas66/folio/releases/download/v0.14.0-beta.4/Folio-0.14.0-beta.4-Windows-x64-Setup.exe.blockmap',
  ]);
  assert.ok(maps.every(url => !url.pathname.includes('ghfast.top')));
});

test('a missing installer cache allows a verified full package from the preferred proxy', async () => {
  const updater = createFixture();
  const token = new CancellationToken();
  updater.downloadUpdate = async receivedToken => {
    assert.equal(receivedToken, token);
    const [file] = updater.updateInfoAndProvider.provider.resolveFiles(updater.updateInfoAndProvider.info);
    await updater.httpExecutor.download(file.url, 'temp.exe', { cancellationToken: token, sha512: officialSha512 });
    return ['full-update.exe'];
  };
  await downloadUpdateWithFallback(updater, token);
  assert.equal(updater.fullDownloads.length, 1);
  assert.equal(new URL(updater.fullDownloads[0].url).hostname, 'ghfast.top');
  assert.equal(updater.fullDownloads[0].sha512, officialSha512);
});

test('a broken differential with a cached installer retries ghproxy then official GitHub without a proxy full package', async t => {
  const updater = createFixture({ cachedInstaller: true });
  const original = updater.updateInfoAndProvider
  t.after(updater.cleanup);
  const token = new CancellationToken();
  const seen = [];
  updater.downloadUpdate = async receivedToken => {
    assert.equal(receivedToken, token);
    const current = updater.updateInfoAndProvider;
    seen.push({ host: current.provider.resolveFiles(current.info)[0].url.hostname, sha512: current.info.files[0].sha512 });
    const [file] = current.provider.resolveFiles(current.info);
    await updater.httpExecutor.download(file.url, 'temp.exe', { cancellationToken: token, sha512: current.info.files[0].sha512 });
    return ['download.exe'];
  };
  await downloadUpdateWithFallback(updater, token);
  assert.deepEqual(seen.map(item => item.host), ['ghfast.top', 'ghproxy.net', 'github.com']);
  assert.ok(seen.every(item => item.sha512 === officialSha512));
  assert.deepEqual(updater.fullDownloads.map(item => new URL(item.url).hostname), ['github.com']);
  assert.equal(updater.updateInfoAndProvider, original);
});

test('cancellation stops retries and passes through unchanged', async () => {
  const updater = createFixture({ cachedInstaller: true });
  updater.cleanup();
  const token = new CancellationToken();
  let attempts = 0;
  updater.downloadUpdate = async receivedToken => {
    assert.equal(receivedToken, token);
    attempts += 1;
    token.cancel();
    throw new CancellationError();
  };
  await assert.rejects(downloadUpdateWithFallback(updater, token), CancellationError);
  assert.equal(attempts, 1);
});

test('hash failures are never accepted and official SHA-512 remains unchanged on every source', async () => {
  const updater = createFixture({ cachedInstaller: true });
  updater.cleanup();
  const token = new CancellationToken();
  const hashError = new Error('sha512 mismatch');
  let attempts = 0;
  updater.downloadUpdate = async () => {
    attempts += 1;
    const current = updater.updateInfoAndProvider;
    assert.equal(current.info.files[0].sha512, officialSha512);
    assert.equal(current.provider.resolveFiles(current.info)[0].info.sha512, officialSha512);
    throw hashError;
  };
  await assert.rejects(downloadUpdateWithFallback(updater, token), error => error === hashError);
  assert.equal(attempts, 3);
});

test('intermediate errors do not race the downloading state or cancel control', async () => {
  const updater = createFixture();
  const token = new CancellationToken();
  let state = 'downloading';
  let attempts = 0;
  updater.on('error', () => {
    if (!isDownloadFallbackActive(updater)) state = 'available';
  });
  updater.on('download-progress', () => { state = 'downloading'; });
  updater.downloadUpdate = async receivedToken => {
    assert.equal(receivedToken, token);
    attempts += 1;
    if (attempts === 1) {
      updater.emit('error', new Error('first mirror failed'));
      assert.equal(state, 'downloading');
      throw new Error('retry on backup');
    }
    assert.equal(state, 'downloading');
    assert.equal(token.cancelled, false);
    updater.emit('download-progress', { percent: 25 });
    return ['download.exe'];
  };
  await downloadUpdateWithFallback(updater, token);
  assert.equal(attempts, 2);
  assert.equal(state, 'downloading');
  assert.equal(isDownloadFallbackActive(updater), false);
});

test('electron-updater clears downloadPromise before the next transport attempt', async t => {
  const info = { version: '0.14.0-beta.4', files: [{ url: installer, size: 100, sha512: officialSha512 }] };
  const provider = createProvider(info);
  const cacheDir = makeTestTempDir('electron-updater-');
  t.after(() => removeTestTempDir(cacheDir));
  const updater = new NsisUpdater(null, { version: info.version, name: 'Folio', baseCachePath: cacheDir });
  updater.logger = { info() {}, warn() {}, error() {} };
  updater.computeRequestHeaders = () => ({});
  updater.httpExecutor = { async download() { return 'downloaded'; } };
  updater.updateInfoAndProvider = { info, provider };
  let attempts = 0;
  updater.doDownloadUpdate = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('preferred mirror unavailable');
    return ['downloaded'];
  };
  assert.deepEqual(await downloadUpdateWithFallback(updater, new CancellationToken()), ['downloaded']);
  assert.equal(attempts, 2);
  assert.equal(updater.downloadPromise, null);
});
