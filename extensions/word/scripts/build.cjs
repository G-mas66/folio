'use strict';

var fs = require('fs');
var path = require('path');
var esbuild = require('esbuild');
var babel = require('@babel/core');
var presetEnv = require('@babel/preset-env');

var root = path.resolve(__dirname, '..');
var output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'styles'), { recursive: true });
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
['taskpane.html', 'taskpane.css', 'manifest.xml'].forEach(function (name) {
  fs.copyFileSync(path.join(root, name), path.join(output, name));
});
fs.copyFileSync(path.join(root, 'public', 'folio-icon.png'), path.join(output, 'assets', 'folio-icon.png'));
fs.readdirSync(path.join(root, 'styles')).forEach(function (name) {
  fs.copyFileSync(path.join(root, 'styles', name), path.join(output, 'styles', name));
});
var bundle = esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'taskpane.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['esnext'],
  charset: 'utf8',
  legalComments: 'none',
  write: false
});
var compiled = babel.transformSync(bundle.outputFiles[0].text, {
  babelrc: false,
  configFile: false,
  comments: false,
  presets: [[presetEnv, { targets: { ie: '11' }, modules: false }]]
});
fs.writeFileSync(path.join(output, 'taskpane.js'), compiled.code, 'utf8');
