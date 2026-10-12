const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'com.folio.browser_bridge.json'))).allowed_origins, []);
    await fs.writeFile(originsFile, JSON.stringify({ development: ['*'] }));
    await assert.rejects(registerBrowserHost({ executable, originsFile, directory, development: true, platform: 'win32', execute: async () => assert.fail('must not register wildcard') }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
