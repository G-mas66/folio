'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { NsisUpdater } = require('electron-updater');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { checkForUpdatesWithApiFallback } = require('../electron/update-api.cjs');

const manifestUrl = 'https://api.github.com/repos/G-mas66/folio/releases/assets/123';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(version = '1.0.3') {
  const installer = `Folio-${version}-Windows-x64-Setup.exe`;
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
  let manifest = Buffer.from(`version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: 1234\n`);
  const release = {
    tag_name: `v${version}`,
    name: `Folio ${version}`,
    body: 'Release notes',
    draft: false,
    prerelease: false,
    assets: [{ name: 'latest.yml', state: 'uploaded', size: manifest.length, digest: `sha256:${digest(manifest)}`, url: manifestUrl }],
  };
  const requests = [];
  const setManifest = bytes => {
    manifest = Buffer.from(bytes);
    release.assets[0].size = manifest.length;
    release.assets[0].digest = `sha256:${digest(manifest)}`;
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ url: url.href, headers: options.headers });
    if (url.href === 'https://api.github.com/repos/G-mas66/folio/releases/latest') {
      return { ok: true, status: 200, json: async () => release };
    }
    assert.equal(url.href, manifestUrl);
    return { ok: true, status: 200, arrayBuffer: async () => manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) };
  };
  const app = { version: '1.0.2', name: 'Folio', isPackaged: true, whenReady: async () => {} };
  const updater = new NsisUpdater(null, app);
  updater.logger = { info() {}, warn() {}, error() {} };
  updater.autoDownload = false;
  updater.on('error', () => {});
  const provider = new GitHubProvider({ owner: 'G-mas66', repo: 'folio' }, updater, {
    executor: { request() { throw new Error('fixture provider request must not run'); } },
    platform: 'win32', arch: 'x64', isUseMultipleRangeRequest: true,
  });
  updater.clientPromise = Promise.resolve(provider);
  updater.stagingUserIdPromise = { value: Promise.resolve('unused-without-staging-percentage') };
  return { updater, provider, release, requests, fetchImpl, setManifest, sha512, installer };
}

const networkError = () => Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { code: 'ERR_PROXY_CONNECTION_FAILED' });

test('transient provider failure feeds trusted API metadata through the real updater pipeline', async () => {
  const ctx = fixture();
  const originalMethod = ctx.provider.getLatestVersion;
  const logs = [];
  const events = [];
  ctx.updater.on('update-available', info => events.push(info));
  const result = await checkForUpdatesWithApiFallback({
    updater: ctx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: ctx.fetchImpl,
    log: event => logs.push(event),
  });

  assert.equal(result.isUpdateAvailable, true);
  assert.equal(result.updateInfo.version, '1.0.3');
  assert.equal(result.updateInfo.tag, 'v1.0.3');
  assert.equal(result.updateInfo.files[0].sha512, ctx.sha512);
  assert.equal(events.length, 1, 'the native update-available event is preserved');
  assert.equal(ctx.updater.updateInfoAndProvider.provider, ctx.provider, 'the original provider remains attached for native download');
  assert.equal(ctx.updater.updateInfoAndProvider.info, result.updateInfo);
  assert.equal(ctx.provider.resolveFiles(result.updateInfo)[0].url.href,
    'https://github.com/G-mas66/folio/releases/download/v1.0.3/Folio-1.0.3-Windows-x64-Setup.exe');
  assert.equal(ctx.provider.getLatestVersion, originalMethod, 'the provider method is restored after success');
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.requests[1].headers.Accept, 'application/octet-stream');
  assert.deepEqual(logs.map(event => event.result), ['started', 'succeeded']);
});

test('the real updater keeps equal versions unavailable after an API fallback', async () => {
  const ctx = fixture('1.0.2');
  let unavailable = 0;
  ctx.updater.on('update-not-available', () => { unavailable += 1; });
  const result = await checkForUpdatesWithApiFallback({
    updater: ctx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: ctx.fetchImpl,
  });

  assert.equal(result.isUpdateAvailable, false);
  assert.equal(result.updateInfo.version, '1.0.2');
  assert.equal(unavailable, 1);
  assert.equal(ctx.updater.updateInfoAndProvider, null);
});

test('invalid release payloads are rejected and the provider method is restored', async () => {
  const ctx = fixture();
  const originalMethod = ctx.provider.getLatestVersion;
  ctx.release.draft = true;

  await assert.rejects(checkForUpdatesWithApiFallback({
    updater: ctx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: ctx.fetchImpl,
  }), error => error.code === 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');

  assert.equal(ctx.requests.length, 1, 'invalid release metadata is rejected before requesting the manifest');
  assert.equal(ctx.provider.getLatestVersion, originalMethod);
  assert.equal(ctx.updater.updateInfoAndProvider, null);
});

test('manifest digest mismatch is rejected and the provider method is restored', async () => {
  const ctx = fixture();
  const originalMethod = ctx.provider.getLatestVersion;
  ctx.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;

  await assert.rejects(checkForUpdatesWithApiFallback({
    updater: ctx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: ctx.fetchImpl,
  }), error => error.code === 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');

  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.provider.getLatestVersion, originalMethod);
  assert.equal(ctx.updater.updateInfoAndProvider, null);
});

test('validly hashed manifests with wrong version, missing SHA512, or scalar YAML are rejected', async () => {
  const invalidManifests = [
    `version: 1.0.2\nfiles:\n  - url: Folio-1.0.3-Windows-x64-Setup.exe\n    sha512: ${crypto.createHash('sha512').update('installer').digest('base64')}\n    size: 1234\n`,
    'version: 1.0.3\nfiles:\n  - url: Folio-1.0.3-Windows-x64-Setup.exe\n    size: 1234\n',
    'null\n',
  ];
  for (const manifest of invalidManifests) {
    const ctx = fixture();
    const originalMethod = ctx.provider.getLatestVersion;
    ctx.setManifest(manifest);
    await assert.rejects(checkForUpdatesWithApiFallback({
      updater: ctx.updater,
      checkForUpdates: async () => { throw networkError(); },
      fetchImpl: ctx.fetchImpl,
    }), error => error.code === 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
    assert.equal(ctx.requests.length, 2, 'the API digest matches the fixture manifest bytes');
    assert.equal(ctx.provider.getLatestVersion, originalMethod);
    assert.equal(ctx.updater.updateInfoAndProvider, null);
  }
});

test('native fetch transport causes are normalized while HTTP responses retain their status', async () => {
  const timeoutCtx = fixture();
  const timeoutLogs = [];
  const timeout = new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  await assert.rejects(checkForUpdatesWithApiFallback({
    updater: timeoutCtx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: async () => { throw timeout; },
    log: event => timeoutLogs.push(event),
  }), error => error.code === 'ERR_CONNECTION_TIMED_OUT');
  assert.equal(timeoutLogs.at(-1).category, 'timeout');

  const httpCtx = fixture();
  const httpLogs = [];
  await assert.rejects(checkForUpdatesWithApiFallback({
    updater: httpCtx.updater,
    checkForUpdates: async () => { throw networkError(); },
    fetchImpl: async () => ({ ok: false, status: 403 }),
    log: event => httpLogs.push(event),
  }), error => error.code === 'HTTP_ERROR_403' && error.statusCode === 403);
  assert.equal(httpLogs.at(-1).category, 'http');
});

test('pre-release and non-official GitHub providers do not use the stable API fallback', async () => {
  for (const changeProvider of [
    updater => { updater.allowPrerelease = true; },
    updater => { updater.clientPromise = updater.clientPromise.then(provider => { provider.options.host = 'github.example'; return provider; }); },
  ]) {
    const ctx = fixture();
    const original = networkError();
    changeProvider(ctx.updater);
    await assert.rejects(checkForUpdatesWithApiFallback({
      updater: ctx.updater,
      checkForUpdates: async () => { throw original; },
      fetchImpl: ctx.fetchImpl,
    }), error => error === original);
    assert.equal(ctx.requests.length, 0);
  }
});

test('HTTP errors do not trigger the official API fallback', async () => {
  const ctx = fixture();
  const forbidden = Object.assign(new Error('HTTP 403'), { statusCode: 403 });

  await assert.rejects(checkForUpdatesWithApiFallback({
    updater: ctx.updater,
    checkForUpdates: async () => { throw forbidden; },
    fetchImpl: ctx.fetchImpl,
  }), error => error === forbidden);

  assert.equal(ctx.requests.length, 0);
});
