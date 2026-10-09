'use strict';

const assert = require('node:assert/strict');
const { releaseNotesText, selectMacUpdate } = require('../electron/update-service.cjs');

function release(version, architectures = ['arm64', 'x64'], draft = false) {
  return {
    tag_name: `v${version}`,
    draft,
    body: `Release ${version}`,
    assets: architectures.map((architecture) => ({
      name: `Folio-${version}-macOS-${architecture}.zip`,
      state: 'uploaded',
    })),
  };
}

const beta = selectMacUpdate([
  release('0.14.1-beta.2'),
  release('0.14.1-beta.10'),
  release('0.14.2-alpha.1'),
], '0.14.0-beta.1', 'x64');
assert.equal(beta?.version, '0.14.1-beta.10', 'selects the highest compatible prerelease using SemVer ordering.');
assert.match(beta?.downloadUrl || '', /Folio-0\.14\.1-beta\.10-macOS-x64\.zip$/);
assert.equal(selectMacUpdate([release('0.14.1-alpha.1')], '0.14.0-beta.1', 'arm64'), null, 'beta installs reject alpha releases.');
assert.equal(selectMacUpdate([release('0.14.1-beta.1')], '0.14.0', 'arm64'), null, 'stable installs reject prerelease releases.');
assert.equal(selectMacUpdate([release('0.14.1')], '0.14.0-beta.1', 'arm64')?.version, '0.14.1', 'beta installs can move to a newer stable release.');
assert.equal(selectMacUpdate([release('0.14.1')], '0.14.0', 'arm64')?.version, '0.14.1', 'stable installs receive newer stable releases.');
const macMarkdown = '## Changes\n\n- Keep **Markdown** intact.';
const markdownRelease = release('0.14.1');
markdownRelease.body = macMarkdown;
assert.equal(selectMacUpdate([markdownRelease], '0.14.0', 'arm64')?.releaseNotes, macMarkdown, 'keeps macOS release API Markdown unchanged.');
assert.equal(selectMacUpdate([release('0.14.1', ['arm64'])], '0.14.0-beta.1', 'x64'), null, 'does not fall back to another architecture.');
assert.equal(selectMacUpdate([release('0.14.1', ['arm64'], true)], '0.14.0-beta.1', 'arm64'), null, 'ignores draft releases.');
assert.equal(selectMacUpdate([release('0.14.1')], '0.14.1', 'arm64'), null, 'does not reoffer the current version.');
assert.equal(selectMacUpdate([release('0.14.2')], 'invalid', 'arm64'), null, 'rejects invalid installed versions.');

const htmlNotes = '<h3>安装器 &amp; 更新</h3><p>下载完成时显示&nbsp;100&#37;。<br>保留 &quot;稍后&quot; 选项。</p><ul><li>检查 &lt;Release&gt; 文件。</li><li>引用 &#39;GitHub&#39; 说明。</li></ul>';
assert.equal(releaseNotesText('Progress: 1 < 2 > 0'), 'Progress: 1 < 2 > 0', 'preserves plain text comparisons.');
assert.equal(releaseNotesText('Invalid &#99999999;'), 'Invalid &#99999999;', 'invalid numeric entities do not interrupt update checks.');
assert.equal(
  releaseNotesText(htmlNotes),
  '安装器 & 更新\n下载完成时显示 100%。\n保留 "稍后" 选项。\n- 检查 <Release> 文件。\n- 引用 \'GitHub\' 说明。',
  'converts HTML release notes, common entities, paragraphs, and list items to readable plain text.'
);
assert.equal(
  releaseNotesText([{ version: '0.14.0-beta.2', note: '<p>修复 &amp; 改进</p>' }, { version: '0.14.0-beta.1', note: '旧版说明' }]),
  '0.14.0-beta.2\n修复 & 改进\n\n0.14.0-beta.1\n旧版说明',
  'preserves versioned release notes while converting HTML inside notes.'
);
assert.equal(releaseNotesText('x'.repeat(12005)).length, 12000, 'caps release notes at 12,000 characters.');
assert.equal(releaseNotesText([{ version: '0.14.0-beta.2', note: 'x'.repeat(12005) }]).length, 12000, 'caps versioned release notes at 12,000 characters.');
console.log('Update service channel and asset selection checks passed.');
