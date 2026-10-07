// Independent check of the actual packaged application, without running it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist/installer-0.11.0/win-unpacked/resources/app.asar');
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
assert.deepEqual(entries.filter(name => /(^|\/)(installer[^/]*|win-unpacked)(\/|$)/.test(name)), [], 'Build output must not be embedded in app.asar');
const bundled = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(bundled.version, '0.11.0');
assert.equal(bundled.dependencies.katex, '0.19.0');
assert.equal(bundled.dependencies['pdfjs-dist'], '6.2.108');
const files = ['electron/main.cjs', 'electron/preload.cjs', 'electron/storage-location.cjs'];
for (const folder of ['dist', 'dist/assets', 'assets']) {
  if (!fs.existsSync(path.join(root, folder))) continue;
  for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    if (entry.isFile()) files.push(`${folder}/${entry.name}`);
  }
}
for (const name of files) assert.ok(asar.extractFile(archive, path.normalize(name)).equals(fs.readFileSync(path.join(root, name))), `Source mismatch: ${name}`);
const katexPackages = entries.filter(name => /(^|\/)katex\/package\.json$/.test(name) && !name.includes('/@types/'));
assert.ok(katexPackages.length > 0);
for (const name of katexPackages) assert.equal(JSON.parse(asar.extractFile(archive, path.normalize(name))).version, '0.19.0');
const result = { version: bundled.version, bytes: fs.statSync(archive).size, source_files_equal: files.length, embedded_build_outputs: 0, katex_versions: ['0.19.0'], pdfjs_version: bundled.dependencies['pdfjs-dist'] };
fs.writeFileSync(path.join(root, '.review/app-archive-0.11.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
