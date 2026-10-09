const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { HttpExecutor, CancellationToken, CancellationError, configureRequestOptionsFromUrl } = require('builder-util-runtime');
const { NsisUpdater } = require('electron-updater');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { DownloadedUpdateHelper } = require('electron-updater/out/DownloadedUpdateHelper');
const { downloadUpdateWithFallback } = require('../electron/update-download.cjs');

const testRoot = path.resolve(__dirname, '../.review/update-download-runtime-fixtures');
const oldVersion = '0.14.0-beta.3';
const newVersion = '0.14.0-beta.4';
const fileName = `Folio-${newVersion}-Windows-x64-Setup.exe`;
const oldBytes = Buffer.concat([Buffer.alloc(4096, 65), Buffer.alloc(4096, 66), Buffer.alloc(4096, 67)]);
const newBytes = Buffer.concat([Buffer.alloc(4096, 65), Buffer.alloc(4096, 88), Buffer.alloc(4096, 67)]);
const digest = bytes => crypto.createHash('sha512').update(bytes).digest('base64');
const makeMap = bytes => zlib.gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
  sizes: [4096, 4096, 4096], checksums: [0, 4096, 8192].map(offset => digest(bytes.subarray(offset, offset + 4096))) }] }));

class LoopbackExecutor extends HttpExecutor {
  constructor(port, requests) { super(); this.port = port; this.requests = requests; }
  createRequest(options, callback) {
    assert.ok(['github.com', 'ghfast.top', 'ghproxy.net'].includes(options.hostname), 'External requests forbidden');
    const range = options.headers?.range || options.headers?.Range;
    this.requests.push({ host: options.hostname, path: options.path, range });
    return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: this.port, agent: false,
      headers: { ...options.headers, 'x-fixture-source': options.hostname } }, callback);
  }
  addRedirectHandlers() { /* Fixture has no redirects; original URLs remain recorded. */ }
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      this.doDownload(configureRequestOptionsFromUrl(url, { headers: options.headers }), {
        destination, options, onCancel, callback: error => error ? reject(error) : resolve(destination),
      }, 0);
    });
  }
}

async function fixture(settings, run) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'fixture-'));
  const requests = [];
  const token = new CancellationToken();
  const trustedInfo = { version: newVersion, tag: `v${newVersion}`,
    files: [{ url: fileName, size: newBytes.length, sha512: digest(newBytes) }] };
  const snapshot = JSON.stringify(trustedInfo);
  const server = http.createServer((request, response) => {
    const host = request.headers['x-fixture-source'];
    const originalPath = request.url.replace(/^\/https:\/\/github\.com/, '');
    if (settings.fail?.includes(host)) { response.writeHead(503); response.end('fixture unavailable'); return; }
    let body = originalPath.endsWith('.blockmap') ? makeMap(originalPath.includes(oldVersion) ? oldBytes : newBytes) : newBytes;
    if (settings.tamper?.includes(host) && !originalPath.endsWith('.blockmap')) body = Buffer.alloc(body.length, 90);
    const range = request.headers.range;
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    let status = 200;
    if (range) {
      assert.match(range, /^bytes=\d+-\d+$/, 'Expected a single Range');
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      body = body.subarray(Number(start), Number(end) + 1);
      status = 206;
    }
    headers['Content-Length'] = body.length;
    response.writeHead(status, headers);
    if (settings.cancel) {
      response.write(body.subarray(0, 1));
      token.cancel();
      response.end(body.subarray(1));
    } else response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executor = new LoopbackExecutor(server.address().port, requests);
  const updater = new NsisUpdater(null, { version: oldVersion, name: 'RuntimeFixture', baseCachePath: root });
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  updater.httpExecutor = executor;
  updater.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: 'fixture-updater' }) };
  const cache = path.join(root, 'fixture-updater');
  await fs.mkdir(cache);
  if (settings.cached !== false) await fs.writeFile(path.join(cache, 'installer.exe'), oldBytes);
  updater.downloadedUpdateHelper = new DownloadedUpdateHelper(cache);
  const provider = new GitHubProvider({ owner: 'G-mas66', repo: 'folio' }, updater,
    { executor, platform: 'win32', arch: 'x64', isUseMultipleRangeRequest: true });
  updater.updateInfoAndProvider = { provider, info: trustedInfo };
  updater.on('error', () => {});
  updater.on('download-progress', () => {});
  try {
    await run({ updater, token, requests, cache });
    assert.equal(JSON.stringify(trustedInfo), snapshot, 'Trusted original metadata must not change');
    assert.equal(updater.updateInfoAndProvider.provider, provider, 'Original GitHub provider restored');
    assert.equal(updater.downloadPromise, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    const resolved = await fs.realpath(root);
    assert.ok(resolved.startsWith(await fs.realpath(testRoot) + path.sep) && path.basename(resolved).startsWith('fixture-'));
    await fs.rm(resolved, { recursive: true });
  }
}

async function verifyDownload(ctx, host, differential) {
  const [file] = await downloadUpdateWithFallback(ctx.updater, ctx.token);
  assert.deepEqual(await fs.readFile(file), newBytes);
  const assets = ctx.requests.filter(request => request.path.endsWith('.exe'));
  assert.equal(assets.at(-1).host, host);
  assert.equal(Boolean(assets.at(-1).range), differential);
  if (differential) assert.equal(assets.at(-1).range, 'bytes=4096-8191');
  const saved = JSON.parse(await fs.readFile(path.join(ctx.cache, 'pending/update-info.json')));
  assert.equal(saved.sha512, digest(newBytes));
  assert.equal(saved.fileName, fileName);
}

test('real NsisUpdater and GitHubProvider reconstruct SHA512-verified bytes through primary proxy single Range', () => fixture({}, async ctx => {
  await verifyDownload(ctx, 'ghfast.top', true);
  assert.ok(ctx.requests.every(request => request.host === 'ghfast.top'));
  assert.equal(ctx.requests.filter(request => request.path.endsWith('.blockmap')).length, 2);
}));

test('primary failure retries backup with actual differential reconstruction', () => fixture({ fail: ['ghfast.top'] }, async ctx => {
  await verifyDownload(ctx, 'ghproxy.net', true);
  assert.deepEqual([...new Set(ctx.requests.map(request => request.host))], ['ghfast.top', 'ghproxy.net']);
  assert.ok(!ctx.requests.some(request => request.host === 'ghfast.top' && request.path.endsWith('.exe')));
}));

test('both proxies failing fall back to original GitHub and complete a real differential', () => fixture({ fail: ['ghfast.top', 'ghproxy.net'] }, async ctx => {
  await verifyDownload(ctx, 'github.com', true);
  assert.deepEqual([...new Set(ctx.requests.map(request => request.host))], ['ghfast.top', 'ghproxy.net', 'github.com']);
}));

test('missing old installer cache permits a SHA512-verified full package through the primary proxy', () => fixture({ cached: false }, async ctx => {
  await verifyDownload(ctx, 'ghfast.top', false);
  assert.ok(ctx.requests.every(request => request.host === 'ghfast.top'));
}));

test('cancellation during real request does not switch download source', () => fixture({ cancel: true }, async ctx => {
  await assert.rejects(downloadUpdateWithFallback(ctx.updater, ctx.token), CancellationError);
  assert.ok(ctx.requests.length > 0);
  assert.ok(ctx.requests.every(request => request.host === 'ghfast.top'));
  assert.equal(ctx.updater.downloadedUpdateHelper.file, null);
}));

test('malicious package bytes fail real SHA512 validation on every source and are never marked downloaded', () => fixture({ cached: false, tamper: ['ghfast.top', 'ghproxy.net', 'github.com'] }, async ctx => {
  await assert.rejects(downloadUpdateWithFallback(ctx.updater, ctx.token), /checksum mismatch/);
  assert.deepEqual([...new Set(ctx.requests.map(request => request.host))], ['ghfast.top', 'ghproxy.net', 'github.com']);
  assert.equal(ctx.updater.downloadedUpdateHelper.file, null);
  assert.deepEqual(await fs.readdir(path.join(ctx.cache, 'pending')), []);
}));
