const fs = require('node:fs');
const path = require('node:path');
const { CancellationError } = require('builder-util-runtime');

const fallbackActive = new WeakSet();
const mirrors = [
  { name: 'ghfast', host: 'ghfast.top' },
  { name: 'ghproxy', host: 'ghproxy.net' },
];

function asURL(value) {
  return value instanceof URL ? value : new URL(value);
}

function isGithubReleaseAsset(value) {
  let url;
  try { url = asURL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'github.com'
    && /^\/G-mas66\/folio\/releases\/download\//i.test(url.pathname);
}

function mirrorURL(value, mirror) {
  const url = asURL(value);
  if (!isGithubReleaseAsset(url)) return url;
  return new URL(`https://${mirror.host}/${url.href}`);
}

function createTransportProvider(provider, transport) {
  if (transport === 'github') return provider;
  const mirror = mirrors.find(item => item.name === transport);
  if (!mirror) throw new Error(`Unknown update transport: ${transport}`);
  const result = Object.create(provider);
  Object.defineProperty(result, 'isUseMultipleRangeRequest', { value: false });
  result.resolveFiles = updateInfo => provider.resolveFiles(updateInfo).map(file => (
    file.url.pathname.toLowerCase().endsWith('.exe') && isGithubReleaseAsset(file.url)
      ? { ...file, url: mirrorURL(file.url, mirror) }
      : file
  ));
  result.getBlockMapFiles = (...args) => {
    const mapURLs = provider.getBlockMapFiles(...args);
    const transform = urls => urls.map(url => mirrorURL(url, mirror));
    return Array.isArray(mapURLs) ? transform(mapURLs) : Promise.resolve(mapURLs).then(transform);
  };
  return result;
}

function hasCachedInstaller(updater) {
  const cacheDir = updater.downloadedUpdateHelper?.cacheDir;
  if (!cacheDir) return false;
  try { return fs.statSync(path.join(cacheDir, 'installer.exe')).isFile(); } catch { return false; }
}

function restoreDownloadMethod(executor, descriptor) {
  if (!executor) return;
  if (descriptor) Object.defineProperty(executor, 'download', descriptor);
  else delete executor.download;
}

function isDownloadFallbackActive(updater) {
  return fallbackActive.has(updater);
}

async function downloadUpdateWithFallback(updater, cancellationToken) {
  const source = updater.updateInfoAndProvider;
  if (!source?.provider || !source.info) throw new Error('Please check for updates before downloading.');
  const originalProvider = source.provider;
  const canMirror = originalProvider.resolveFiles(source.info).some(file => (
    file.url.pathname.toLowerCase().endsWith('.exe') && isGithubReleaseAsset(file.url)
  ));
  const transports = canMirror ? [...mirrors.map(mirror => mirror.name), 'github'] : ['github'];
  const executor = updater.httpExecutor;
  const downloadDescriptor = executor ? Object.getOwnPropertyDescriptor(executor, 'download') : null;
  const originalDownload = executor?.download;
  if (transports.length > 1) fallbackActive.add(updater);

  try {
    for (let index = 0; index < transports.length; index += 1) {
      if (cancellationToken?.cancelled) throw new CancellationError();
      const transport = transports[index];
      updater.updateInfoAndProvider = {
        ...source,
        provider: createTransportProvider(originalProvider, transport),
      };
      restoreDownloadMethod(executor, downloadDescriptor);
      if (transport !== 'github' && executor && typeof originalDownload === 'function') {
        executor.download = function downloadWithVerifiedMirror(url, destination, options) {
          const assetURL = asURL(url);
          if (assetURL.pathname.toLowerCase().endsWith('.exe') && mirrors.some(mirror => mirror.host === assetURL.hostname)
            && hasCachedInstaller(updater)) {
            if (cancellationToken?.cancelled || options?.cancellationToken?.cancelled) throw new CancellationError();
            const error = new Error('Differential transfer failed; trying the next update source.');
            error.code = 'ERR_UPDATER_MIRROR_DIFFERENTIAL_FAILED';
            throw error;
          }
          return originalDownload.call(this, url, destination, options);
        };
      }
      try {
        return await updater.downloadUpdate(cancellationToken);
      } catch (error) {
        if (cancellationToken?.cancelled || error instanceof CancellationError || error?.name === 'CancellationError') {
          throw new CancellationError();
        }
        if (index === transports.length - 1) throw error;
      } finally {
        restoreDownloadMethod(executor, downloadDescriptor);
      }
    }
  } finally {
    updater.updateInfoAndProvider = source;
    restoreDownloadMethod(executor, downloadDescriptor);
    fallbackActive.delete(updater);
  }
}

module.exports = { createTransportProvider, downloadUpdateWithFallback, isDownloadFallbackActive };