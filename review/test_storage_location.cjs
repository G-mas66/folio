// Independent filesystem cases; no personal library/config is read or changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../electron/storage-location.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `storage-contract-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = [];
const test = async (name, run) => {
  const directory = path.join(output, name);
  fs.mkdirSync(directory);
  await run(directory);
  rows.push({ name, result: 'passed' });
};
const source = directory => {
  const folder = path.join(directory, 'source');
  fs.mkdirSync(path.join(folder, 'papers', 'paper-one'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'electron-userData'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.backend-temp'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'workbench.sqlite'), 'isolated DB snapshot');
  fs.writeFileSync(path.join(folder, 'workbench.sqlite-wal'), 'isolated WAL snapshot');
  fs.writeFileSync(path.join(folder, 'workbench.sqlite-shm'), 'isolated SHM snapshot');
  fs.writeFileSync(path.join(folder, 'papers', 'paper-one', 'source.pdf'), '%PDF-1.7\noriginal bytes\n');
  fs.writeFileSync(path.join(folder, 'electron-userData', 'LOCK'), 'locked UI state must stay');
  fs.writeFileSync(path.join(folder, '.backend-temp', 'temporary'), 'transient file');
  return folder;
};
const copyOptions = (directory, src) => ({
  configPath: path.join(directory, 'location.json'),
  uiDataRoot: path.join(src, 'electron-userData'),
  config: { dataRoot: src, credentialRoot: src, uiDataRoot: path.join(src, 'electron-userData') },
});

(async () => {
  try {
    await test('legacy-default', directory => {
      const fallback = path.join(directory, 'legacy-data');
      const cfg = path.join(directory, 'config.json');
      const value = storage.resolveLocationConfig(cfg, {}, fallback);
      assert.equal(value.dataRoot, fallback);
      assert.equal(value.credentialRoot, fallback);
      assert.equal(value.uiDataRoot, path.join(fallback, 'electron-userData'));
      assert.equal(fs.existsSync(cfg), false, 'Looking up default must not persist a new setting');
    });
    await test('configured-library', async directory => {
      const old = path.join(directory, 'old');
      const target = path.join(directory, 'new');
      fs.mkdirSync(old);
      fs.mkdirSync(target);
      const cfg = path.join(directory, 'location.json');
      const value = { dataRoot: target, credentialRoot: old, uiDataRoot: path.join(old, 'electron-userData') };
      await storage.writeLocationConfigAtomic(cfg, value);
      const loaded = storage.resolveLocationConfig(cfg, {}, old);
      for (const key of Object.keys(value)) assert.equal(loaded[key], value[key]);
    });
    await test('explicit-env-isolation', async directory => {
      const old = path.join(directory, 'existing');
      const custom = path.join(directory, 'test-data');
      fs.mkdirSync(old);
      fs.mkdirSync(custom);
      const cfg = path.join(directory, 'location.json');
      await storage.writeLocationConfigAtomic(cfg, { dataRoot: old, credentialRoot: old, uiDataRoot: path.join(old, 'electron-userData') });
      const value = storage.resolveLocationConfig(cfg, { WORKBENCH_DATA_DIR: custom }, old);
      assert.equal(value.dataRoot, custom);
      assert.equal(value.credentialRoot, custom, 'Explicit fixture data must never reuse another library credentials');
      assert.equal(value.uiDataRoot, path.join(custom, 'electron-userData'));
    });
    await test('corrupt-config', directory => {
      const cfg = path.join(directory, 'location.json');
      fs.writeFileSync(cfg, '{invalid JSON');
      assert.throws(() => storage.resolveLocationConfig(cfg, {}, path.join(directory, 'legacy')), 'Corrupt configuration must not silently open a different library');
      assert.equal(fs.readFileSync(cfg, 'utf8'), '{invalid JSON');
    });
    await test('same-and-nested-paths', directory => {
      const src = source(directory);
      for (const target of [src, directory, path.join(src, 'child')]) {
        assert.throws(() => storage.validateStorageTarget(src, target));
      }
    });
    await test('nonempty-target', directory => {
      const src = source(directory);
      const target = path.join(directory, 'other-library');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'Do not overwrite');
      assert.throws(() => storage.validateStorageTarget(src, target));
      assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'Do not overwrite');
    });
    await test('file-target', directory => {
      const src = source(directory);
      const target = path.join(directory, 'file.txt');
      fs.writeFileSync(target, 'Keep file');
      assert.throws(() => storage.validateStorageTarget(src, target));
    });
    await test('junction-ancestor', directory => {
      const src = source(directory);
      const real = path.join(directory, 'real');
      const link = path.join(directory, 'linked');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link, 'junction');
      try {
        assert.throws(() => storage.validateStorageTarget(src, path.join(link, 'destination')));
      } finally { fs.unlinkSync(link); }
    });
    await test('source-escaping-link', async directory => {
      const src = source(directory);
      const external = path.join(directory, 'unrelated');
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, 'keep.txt'), 'Outside source');
      const link = path.join(src, 'escape');
      fs.symlinkSync(external, link, 'junction');
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      try {
        await assert.rejects(async () => storage.copyAndVerifyStorage(src, target, copyOptions(directory, src)));
        assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'Outside source');
      } finally { fs.unlinkSync(link); }
    });
    await test('verified-copy-keeps-source', async directory => {
      const src = source(directory);
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      const files = ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm', path.join('papers', 'paper-one', 'source.pdf')];
      const before = Object.fromEntries(files.map(file => [file, hash(path.join(src, file))]));
      const result = await storage.copyAndVerifyStorage(src, target, copyOptions(directory, src));
      for (const file of files) {
        assert.equal(hash(path.join(src, file)), before[file]);
        assert.equal(hash(path.join(target, file)), before[file]);
      }
      assert.equal(fs.existsSync(path.join(target, 'electron-userData')), false);
      assert.equal(fs.existsSync(path.join(target, '.backend-temp')), false);
      assert.equal(fs.readFileSync(path.join(src, 'electron-userData', 'LOCK'), 'utf8'), 'locked UI state must stay');
      assert.ok(result, 'Successful verified copy returns a result');
    });
    await test('copy-corruption-rolls-back', async directory => {
      const src = source(directory);
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      const originalCopy = fs.promises.copyFile;
      fs.promises.copyFile = async (from, to, ...options) => {
        await originalCopy(from, to, ...options);
        fs.writeFileSync(to, 'corrupt test copy');
      };
      try {
        await assert.rejects(() => storage.copyAndVerifyStorage(src, target, copyOptions(directory, src)), /校验/);
        assert.equal(fs.readdirSync(target).length, 0);
        assert.equal(fs.existsSync(path.join(directory, 'location.json')), false);
        assert.equal(fs.readFileSync(path.join(src, 'workbench.sqlite'), 'utf8'), 'isolated DB snapshot');
        assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('.folio-storage-')).length, 0);
      } finally { fs.promises.copyFile = originalCopy; }
    });
    await test('config-write-failure-rolls-back-target', async directory => {
      const src = source(directory);
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      const options = copyOptions(directory, src);
      fs.mkdirSync(options.configPath);
      fs.writeFileSync(path.join(options.configPath, 'keep.txt'), 'Keep unrelated entry');
      await assert.rejects(() => storage.copyAndVerifyStorage(src, target, options));
      assert.equal(fs.readdirSync(target).length, 0);
      assert.equal(fs.readFileSync(path.join(options.configPath, 'keep.txt'), 'utf8'), 'Keep unrelated entry');
      assert.equal(fs.readFileSync(path.join(src, 'workbench.sqlite'), 'utf8'), 'isolated DB snapshot');
      assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('.folio-storage-')).length, 0);
    });
    await test('same-size-source-change-rejected', async directory => {
      const src = source(directory);
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      const options = copyOptions(directory, src);
      let changed = false;
      options.onProgress = () => {
        if (changed) return;
        changed = true;
        const file = path.join(src, 'papers', 'paper-one', 'source.pdf');
        const bytes = fs.readFileSync(file);
        bytes[bytes.length - 2] ^= 1;
        fs.writeFileSync(file, bytes);
      };
      await assert.rejects(() => storage.copyAndVerifyStorage(src, target, options), /变化|校验/);
      assert.equal(fs.readdirSync(target).length, 0);
      assert.equal(fs.existsSync(options.configPath), false);
    });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'passed', cases: rows.length, rows }, null, 2));
    console.log(JSON.stringify({ result: 'passed', cases: rows.length, output }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    throw error;
  }
})();
