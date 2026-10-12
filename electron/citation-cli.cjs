'use strict';

const path = require('node:path');
const { renderCitation } = require('./citation-service.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) { process.stderr.write('书目信息过大。'); process.exit(1); }
});
process.stdin.on('end', () => {
  try {
    const directory = process.env.WORKBENCH_CITATION_STYLES || path.join(__dirname, '../extensions/word/styles');
    process.stdout.write(JSON.stringify(renderCitation(JSON.parse(input), directory)));
  } catch (error) {
    process.stderr.write(error.message || '引用生成失败。');
    process.exitCode = 1;
  }
});
