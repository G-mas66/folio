'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'pdfjs-dist');
const destination = path.join(root, 'public', 'pdfjs');

fs.mkdirSync(destination, { recursive: true });
for (const directory of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
  fs.cpSync(path.join(source, directory), path.join(destination, directory), { recursive: true });
}
