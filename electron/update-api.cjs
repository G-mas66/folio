'use strict';

const crypto = require('node:crypto');
const semver = require('semver');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');
const { classifyUpdateError } = require('./update-check.cjs');

const RELEASE_API_URL = 'https://api.github.com/repos/G-mas66/folio/releases/latest';
const CHANNEL_FILE = 'latest.yml';
const NATIVE_FETCH_CODES = new Map([
  ['UND_ERR_CONNECT_TIMEOUT', 'ERR_CONNECTION_TIMED_OUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'ERR_CONNECTION_TIMED_OUT'],
  ['UND_ERR_SOCKET', 'ERR_CONNECTION_RESET'],
]);

function apiError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function isFolioStableProvider(updater, provider) {
  const options = provider?.options;
  const channel = updater.channel;
  return provider?.constructor?.name === 'GitHubProvider'
    && options?.owner === 'G-mas66'
    && options?.repo === 'folio'
    && (!options.host || options.host === 'github.com')
    && !updater.allowPrerelease
    && !semver.prerelease(updater.currentVersion)
    && (!channel || channel === 'latest');
}

async function nativeFetch(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    if (error?.name === 'TimeoutError') throw apiError('GitHub API request timed out.', 'ERR_CONNECTION_TIMED_OUT');
    const causeCode = error?.cause?.code;
    if (typeof causeCode !== 'string') throw error;
    const code = NATIVE_FETCH_CODES.get(causeCode) || causeCode;
    if (!classifyUpdateError({ code }).retryDirect) throw error;
    throw apiError('GitHub API request failed.', code);
  }
}

async function requestJson(fetchImpl, url) {
  const response = await nativeFetch(fetchImpl, url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Folio updater',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw apiError('GitHub Releases request failed.', `HTTP_ERROR_${response.status}`, response.status);
  return response.json();
}

async function requestManifest(fetchImpl, release) {
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
    throw apiError('GitHub release metadata is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }
  const version = semver.valid(release.tag_name);
  if (!version || semver.prerelease(version)) {
    throw apiError('GitHub release tag is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }

  const assets = Array.isArray(release.assets)
    ? release.assets.filter(asset => asset?.name === CHANNEL_FILE)
    : [];
  if (assets.length !== 1) {
    throw apiError('GitHub release manifest is missing or ambiguous.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }
  const [asset] = assets;
  let assetUrl;
  try { assetUrl = new URL(asset.url); } catch {}
  if (asset.state !== 'uploaded'
    || !Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || asset.size > 1024 * 1024
    || assetUrl?.origin !== 'https://api.github.com'
    || !/^\/repos\/G-mas66\/folio\/releases\/assets\/\d+$/.test(assetUrl.pathname)
    || typeof asset.digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
    throw apiError('GitHub release manifest metadata is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }

  const response = await nativeFetch(fetchImpl, assetUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Folio updater',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw apiError('GitHub release manifest request failed.', `HTTP_ERROR_${response.status}`, response.status);
  const manifestBytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestBytes.length !== asset.size || digest !== asset.digest.slice('sha256:'.length).toLowerCase()) {
    throw apiError('GitHub release manifest integrity check failed.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }

  const channelUrl = new URL(`/G-mas66/folio/releases/download/${encodeURIComponent(release.tag_name)}/${CHANNEL_FILE}`, 'https://github.com');
  let info;
  try {
    info = parseUpdateInfo(manifestBytes.toString('utf8'), CHANNEL_FILE, channelUrl);
  } catch {
    throw apiError('GitHub release manifest is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }
  if (!info || typeof info !== 'object' || Array.isArray(info) || !Array.isArray(info.files) || info.files.length !== 1) {
    throw apiError('GitHub release manifest is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }
  const installerName = `Folio-${version}-Windows-x64-Setup.exe`;
  const installers = info.files.filter(file => file?.url === installerName);
  if (info.version !== version || installers.length !== 1) {
    throw apiError('GitHub release manifest does not match its release.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }
  const [installer] = installers;
  if (!Number.isSafeInteger(installer.size) || installer.size <= 0
    || typeof installer.sha512 !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(installer.sha512)
    || Buffer.from(installer.sha512, 'base64').length !== 64) {
    throw apiError('GitHub release installer metadata is invalid.', 'ERR_UPDATER_API_FALLBACK_INVALID_RELEASE');
  }

  return {
    ...info,
    tag: release.tag_name,
    ...(info.releaseName == null && typeof release.name === 'string' ? { releaseName: release.name } : {}),
    ...(info.releaseNotes == null && typeof release.body === 'string' ? { releaseNotes: release.body } : {}),
  };
}

async function checkForUpdatesWithApiFallback({ updater, checkForUpdates, log = () => {}, fetchImpl = globalThis.fetch }) {
  try {
    return await checkForUpdates();
  } catch (originalError) {
    if (!classifyUpdateError(originalError).retryDirect || typeof fetchImpl !== 'function') throw originalError;
    let provider;
    try { provider = await updater.clientPromise; } catch { throw originalError; }
    if (!isFolioStableProvider(updater, provider) || typeof provider.getLatestVersion !== 'function') throw originalError;

    const methodDescriptor = Object.getOwnPropertyDescriptor(provider, 'getLatestVersion');
    const originalMethod = provider.getLatestVersion;
    log({ event: 'attempt', route: 'github-api', result: 'started' });
    provider.getLatestVersion = async () => requestManifest(fetchImpl, await requestJson(fetchImpl, RELEASE_API_URL));
    try {
      const result = await updater.checkForUpdates();
      log({ event: 'attempt', route: 'github-api', result: 'succeeded' });
      return result;
    } catch (error) {
      const failure = classifyUpdateError(error);
      log({ event: 'attempt', route: 'github-api', result: 'failed', category: failure.category, code: failure.code, status: failure.status });
      throw error;
    } finally {
      if (methodDescriptor) Object.defineProperty(provider, 'getLatestVersion', methodDescriptor);
      else delete provider.getLatestVersion;
      if (provider.getLatestVersion !== originalMethod) {
        throw apiError('Could not restore the GitHub update provider.', 'ERR_UPDATER_API_FALLBACK_RESTORE_FAILED');
      }
    }
  }
}

module.exports = { checkForUpdatesWithApiFallback, requestManifest };
