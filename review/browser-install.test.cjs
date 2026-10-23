const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { registerBrowserHost } = require('../electron/browser-install.cjs');

test('native registration only writes exact current-user browser keys and explicit identities', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-'));
  try {
    const executable = path.join(directory, 'host.exe');
    const originsFile = path.join(directory, 'origins.json');
    await fs.writeFile(executable, 'fixture');
    await fs.writeFile(originsFile, JSON.stringify({ development: ['chrome-extension://gdiemkjipojgcalgibamhjaffbbnpfco/'], production: [] }));
    const calls = [];
    const result = await registerBrowserHost({ executable, originsFile, directory, development: true, platform: 'win32', execute: async (...args) => calls.push(args) });
    assert.equal(result.installed, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(([command, args]) => command === 'reg.exe' && args[1].startsWith('HKCU\\Software\\') && args[1].endsWith('NativeMessagingHosts\\com.folio.browser_bridge')));
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'com.folio.browser_bridge.json')));
    assert.equal(manifest.path, executable);
    assert.deepEqual(manifest.allowed_origins, ['chrome-extension://gdiemkjipojgcalgibamhjaffbbnpfco/']);
    const production = await registerBrowserHost({ executable, originsFile, directory, platform: 'win32', execute: async () => assert.fail('production cannot register a dev identity') });
    assert.equal(production.installed, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'com.folio.browser_bridge.json'))).allowed_origins, ['chrome-extension://gdiemkjipojgcalgibamhjaffbbnpfco/']);
    await fs.writeFile(originsFile, JSON.stringify({ development: ['*'] }));
    await assert.rejects(registerBrowserHost({ executable, originsFile, directory, development: true, platform: 'win32', execute: async () => assert.fail('must not register wildcard') }));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'com.folio.browser_bridge.json'))).allowed_origins, ['chrome-extension://gdiemkjipojgcalgibamhjaffbbnpfco/']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('production registration permits the bundled stable extension and store identity only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-production-'));
  try {
    const executable = path.join(directory, 'host.exe');
    await fs.writeFile(executable, 'fixture');
    const extensionDirectory = path.join(__dirname, '../extensions/browser');
    const extension = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
    const extensionId = createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, digit => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16)));
    const originsFile = path.join(directory, 'origins.json');
    const configuration = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'native-host-allowed-origins.json'), 'utf8'));
    configuration.development.push('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
    await fs.writeFile(originsFile, JSON.stringify(configuration));
    const calls = [];
    const result = await registerBrowserHost({ executable, originsFile, directory, platform: 'win32', execute: async (...args) => calls.push(args) });
    assert.equal(result.installed, true);
    assert.equal(calls.length, 2);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'com.folio.browser_bridge.json'), 'utf8'));
    assert.ok(manifest.allowed_origins.includes(`chrome-extension://${extensionId}/`), 'packaged extension key must be trusted in production');
    assert.deepEqual(manifest.allowed_origins, [
      `chrome-extension://${extensionId}/`,
      'chrome-extension://gimnkmpfcblogmkkamdlpejgleeiidpb/',
    ]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
