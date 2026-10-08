'use strict';

const assert = require('node:assert/strict');
const { selectMacUpdate } = require('../electron/update-service.cjs');

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
assert.equal(selectMacUpdate([release('0.14.1', ['arm64'])], '0.14.0-beta.1', 'x64'), null, 'does not fall back to another architecture.');
assert.equal(selectMacUpdate([release('0.14.1', ['arm64'], true)], '0.14.0-beta.1', 'arm64'), null, 'ignores draft releases.');
assert.equal(selectMacUpdate([release('0.14.1')], '0.14.1', 'arm64'), null, 'does not reoffer the current version.');
assert.equal(selectMacUpdate([release('0.14.2')], 'invalid', 'arm64'), null, 'rejects invalid installed versions.');

console.log('Update service channel and asset selection checks passed.');
