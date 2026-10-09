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

const htmlEntities = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function htmlToText(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol|blockquote|pre)\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, name) => {
      const key = name.toLowerCase();
      if (key.startsWith('#')) {
        const hex = key.startsWith('#x');
        const codePoint = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
      }
      return htmlEntities[key] ?? entity;
    })
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function releaseNotesText(value) {
  if (typeof value === 'string') return htmlToText(value).slice(0, 12000);
  if (!Array.isArray(value)) return '';
  const notes = value.map((item) => [item.version, item.note].filter(Boolean).join('\n')).join('\n\n');
  return htmlToText(notes).slice(0, 12000);
}

module.exports = { releaseNotesText, selectMacUpdate };
