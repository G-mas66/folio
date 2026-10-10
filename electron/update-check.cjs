'use strict';

const TRANSIENT_ERROR_CODES = new Map([
  ['ERR_PROXY_CONNECTION_FAILED', 'proxy'],
  ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy'],
  ['ERR_NO_SUPPORTED_PROXIES', 'proxy'],
  ['ERR_CONNECTION_TIMED_OUT', 'timeout'],
  ['ERR_TIMED_OUT', 'timeout'],
  ['ETIMEDOUT', 'timeout'],
  ['ERR_NAME_NOT_RESOLVED', 'connection'],
  ['ENOTFOUND', 'connection'],
  ['EAI_AGAIN', 'connection'],
  ['ERR_CONNECTION_REFUSED', 'connection'],
  ['ERR_CONNECTION_RESET', 'connection'],
  ['ERR_CONNECTION_CLOSED', 'connection'],
  ['ERR_CONNECTION_ABORTED', 'connection'],
  ['ERR_NETWORK_CHANGED', 'connection'],
  ['ERR_INTERNET_DISCONNECTED', 'connection'],
  ['ERR_ADDRESS_UNREACHABLE', 'connection'],
  ['ERR_SOCKET_NOT_CONNECTED', 'connection'],
  ['ECONNREFUSED', 'connection'],
  ['ECONNRESET', 'connection'],
  ['EHOSTUNREACH', 'connection'],
  ['ENETUNREACH', 'connection'],
]);

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '';
}

function classifyUpdateError(error) {
  const code = safeErrorCode(error);
  if (code === 'ERR_UPDATER_PROXY_RESTORE_FAILED') return { category: 'proxy', retryDirect: false, code };
  const message = String(error?.message || '');
  const diagnosticMessage = code === 'ERR_UPDATER_INVALID_RELEASE_FEED'
    ? message.split('\nXML:\n', 1)[0]
    : message;
  const statusMatch = /^HTTP_ERROR_(\d{3})$/i.exec(code)
    || /(?:HttpError:\s*|HTTP_ERROR_)(\d{3})\b/i.exec(diagnosticMessage);
  const status = Number(error?.statusCode || error?.response?.statusCode || error?.response?.status || statusMatch?.[1]);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return { category: 'http', retryDirect: false, code, status };
  }
  if (code.startsWith('ERR_UPDATER_')
    && code !== 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
    && code !== 'ERR_UPDATER_INVALID_RELEASE_FEED') {
    return { category: 'service', retryDirect: false, code };
  }

  const candidates = [code, ...Array.from(diagnosticMessage.matchAll(/\b(?:net::)?([A-Z][A-Z0-9_]{2,63})\b/g), match => match[1])];
  for (const candidate of candidates) {
    const category = TRANSIENT_ERROR_CODES.get(candidate.toUpperCase());
    if (category) return { category, retryDirect: true, code: candidate };
  }

  if (/\b(?:request timed out|timed out|timeout)\b/i.test(diagnosticMessage)) {
    return { category: 'timeout', retryDirect: true, code };
  }
  return { category: 'service', retryDirect: false, code };
}

function updateCheckErrorMessage(classification) {
  if (classification.category === 'http') {
    return `更新检查失败：更新服务返回 HTTP ${classification.status}。`;
  }
  if (classification.category === 'proxy') {
    return '更新检查失败：无法连接代理或更新服务，请检查网络和代理设置后重试。';
  }
  if (classification.category === 'connection' || classification.category === 'timeout') {
    return '更新检查失败：连接更新服务超时或中断，请检查网络或代理后重试。';
  }
  return '更新检查失败：更新服务响应异常，请稍后重试。';
}

function createUpdateChecker({ session, checkForUpdates, log = () => {} }) {
  let inFlight;
  const writeLog = event => {
    try { log(event); } catch {}
  };

  return function checkWithProxyFallback() {
    if (inFlight) return inFlight;
    const operation = (async () => {
      writeLog({ event: 'attempt', route: 'system', result: 'started' });
      try {
        const result = await checkForUpdates();
        writeLog({ event: 'attempt', route: 'system', result: 'succeeded' });
        return result;
      } catch (systemError) {
        const systemFailure = classifyUpdateError(systemError);
        writeLog({
          event: 'attempt', route: 'system', result: 'failed', category: systemFailure.category,
          code: systemFailure.code, status: systemFailure.status,
        });
        if (!systemFailure.retryDirect) throw systemError;

        try {
          await session.setProxy({ mode: 'direct' });
          await session.closeAllConnections();
          writeLog({ event: 'attempt', route: 'direct', result: 'started' });
          try {
            const result = await checkForUpdates();
            writeLog({ event: 'attempt', route: 'direct', result: 'succeeded' });
            return result;
          } catch (directError) {
            const directFailure = classifyUpdateError(directError);
            writeLog({
              event: 'attempt', route: 'direct', result: 'failed', category: directFailure.category,
              code: directFailure.code, status: directFailure.status,
            });
            throw directError;
          }
        } finally {
          let restoreError;
          try { await session.setProxy({ mode: 'system' }); } catch (error) { restoreError = error; }
          try { await session.closeAllConnections(); } catch (error) { restoreError ||= error; }
          if (restoreError) {
            writeLog({ event: 'proxy', route: 'system', result: 'restore-failed' });
            const error = new Error('Unable to restore the system proxy after update check.');
            error.code = 'ERR_UPDATER_PROXY_RESTORE_FAILED';
            throw error;
          }
          writeLog({ event: 'proxy', route: 'system', result: 'restored' });
        }
      }
    })();
    inFlight = operation.finally(() => {
      if (inFlight === wrappedOperation) inFlight = null;
    });
    const wrappedOperation = inFlight;
    return inFlight;
  };
}

module.exports = { classifyUpdateError, createUpdateChecker, updateCheckErrorMessage };
