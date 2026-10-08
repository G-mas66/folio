'use strict';

const semver = require('semver');

function channelOf(version) {
  return semver.prerelease(version)?.[0] || null;
}

function isChannelCompatible(currentVersion, candidateVersion) {
  const current = channelOf(currentVersion);
  const candidate = channelOf(candidateVersion);
  if (!current) return !candidate;
  if (current === 'alpha') return !candidate || candidate === 'alpha' || candidate === 'beta';
  if (current === 'beta') return !candidate || candidate === 'beta';
  return !candidate || candidate === current;
}

function selectMacUpdate(releases, currentVersion, architecture) {
  if (!semver.valid(currentVersion) || !Array.isArray(releases) || !['arm64', 'x64'].includes(architecture)) return null;
  const candidates = releases
    .filter((release) => {
      const version = semver.valid(release?.tag_name);
      return !release?.draft && Array.isArray(release?.assets) && version
        && semver.gt(version, currentVersion) && isChannelCompatible(currentVersion, version);
    })
    .sort((left, right) => semver.rcompare(left.tag_name, right.tag_name));
  for (const release of candidates) {
    const version = semver.valid(release.tag_name);
    const fileName = `Folio-${version}-macOS-${architecture}.zip`;
    const asset = release.assets.find((item) => item?.name === fileName && item.state !== 'new');
    if (!asset) continue;
    const tag = `v${version}`;
    return {
      version,
      architecture,
      releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '',
      releaseUrl: `https://github.com/G-mas66/folio/releases/tag/${encodeURIComponent(tag)}`,
      downloadUrl: `https://github.com/G-mas66/folio/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`,
    };
  }
  return null;
}

module.exports = { selectMacUpdate };
