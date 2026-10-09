'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
const context = vm.createContext({ module: compiledModule, exports: compiledModule.exports });
vm.runInContext(output, context, { filename: 'api.ts' });

const ipcError = vm.runInContext(
  "new Error(\"Error invoking remote method 'workbench:request': Error: HTTP 401\")",
  context,
);
assert.equal(compiledModule.exports.errorMessage(ipcError), 'HTTP 401');
assert.equal(compiledModule.exports.errorMessage(vm.runInContext("new Error('HTTP 403')", context)), 'HTTP 403');
assert.equal(compiledModule.exports.errorMessage('unknown'), '操作失败，请稍后重试。');
