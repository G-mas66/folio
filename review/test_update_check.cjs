'use strict';

const assert = require('node:assert/strict');
const {
  classifyUpdateError,
  createUpdateChecker,
  updateCheckErrorMessage,
} = require('../electron/update-check.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mockSession() {
  return {
    mode: 'system',
    proxyChanges: [],
    closeCount: 0,
    async setProxy(config) {
      this.mode = config.mode;
      this.proxyChanges.push(config.mode);
    },
    async closeAllConnections() { this.closeCount += 1; },
  };
}

async function main() {
  const available = { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } };

  {
    const session = mockSession();
    let checks = 0;
    const checker = createUpdateChecker({ session, checkForUpdates: async () => { checks += 1; return available; } });
    assert.equal(await checker(), available);
    assert.equal(checks, 1);
    assert.deepEqual(session.proxyChanges, [], 'the default system proxy is left alone when it works.');
    assert.equal(session.closeCount, 0);
  }

  {
    const session = mockSession();
    const attempts = [];
    const logs = [];
    const error = Object.assign(new Error('Unable to find latest version: net::ERR_PROXY_CONNECTION_FAILED https://github.com/releases.atom?token=private'), {
      code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    });
    const checker = createUpdateChecker({
      session,
      log: event => logs.push(event),
      checkForUpdates: async () => {
        attempts.push(session.mode);
        if (attempts.length === 1) throw error;
        return available;
      },
    });
    assert.equal(await checker(), available);
    assert.deepEqual(attempts, ['system', 'direct']);
    assert.deepEqual(session.proxyChanges, ['direct', 'system']);
    assert.equal(session.mode, 'system', 'the system proxy is restored before success is returned.');
    assert.equal(session.closeCount, 2);
    assert.equal(JSON.stringify(logs).includes('private'), false, 'logs do not retain raw updater error text or URLs.');
    assert.equal(logs.some(event => event.route === 'direct' && event.result === 'succeeded'), true);
    assert.equal(logs.find(event => event.route === 'system' && event.result === 'failed').code, 'ERR_PROXY_CONNECTION_FAILED');
  }

  {
    const session = mockSession();
    const attempts = [];
    const first = Object.assign(new Error('net::ERR_CONNECTION_TIMED_OUT'), { code: 'ERR_CONNECTION_TIMED_OUT' });
    const second = Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ERR_CONNECTION_RESET' });
    const checker = createUpdateChecker({
      session,
      checkForUpdates: async () => {
        attempts.push(session.mode);
        throw attempts.length === 1 ? first : second;
      },
    });
    await assert.rejects(checker(), error => error === second);
    assert.deepEqual(attempts, ['system', 'direct']);
    assert.deepEqual(session.proxyChanges, ['direct', 'system']);
    assert.equal(session.mode, 'system', 'the system proxy is restored even when both attempts fail.');
    assert.equal(session.closeCount, 2);
  }

  {
    const session = mockSession();
    const httpError = Object.assign(new Error('Unable to find latest version: HttpError: 403 Forbidden https://github.com/releases.atom?token=private'), {
      code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    });
    assert.deepEqual(classifyUpdateError(httpError), {
      category: 'http', retryDirect: false, code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', status: 403,
    });
    assert.match(updateCheckErrorMessage(classifyUpdateError(httpError)), /HTTP 403/);
    let checks = 0;
    const checker = createUpdateChecker({ session, checkForUpdates: async () => { checks += 1; throw httpError; } });
    await assert.rejects(checker(), error => error === httpError);
    assert.equal(checks, 1, 'HTTP failures are not retried through direct access.');
    assert.deepEqual(session.proxyChanges, []);
  }

  {
    const session = mockSession();
    const notFound = Object.assign(new Error('HttpError: 404 Not Found'), { code: 'HTTP_ERROR_404', statusCode: 404 });
    const checker = createUpdateChecker({ session, checkForUpdates: async () => { throw notFound; } });
    await assert.rejects(checker(), error => error === notFound);
    assert.deepEqual(session.proxyChanges, [], 'HTTP 404 is not retried through direct access.');
  }

  {
    const session = mockSession();
    const attempts = [];
    const wrappedNetworkError = Object.assign(new Error('Cannot parse releases feed: Error: net::ERR_PROXY_CONNECTION_FAILED\n    at request\nXML:\n<feed/>'), {
      code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });
    const checker = createUpdateChecker({
      session,
      checkForUpdates: async () => {
        attempts.push(session.mode);
        if (attempts.length === 1) throw wrappedNetworkError;
        return available;
      },
    });
    assert.equal(await checker(), available, 'a transport error wrapped by the release feed parser still retries.');
    assert.deepEqual(attempts, ['system', 'direct']);
    assert.deepEqual(session.proxyChanges, ['direct', 'system']);
  }

  {
    const session = mockSession();
    const invalidManifest = Object.assign(new Error('Cannot parse releases feed: Error: invalid XML near unexpected token\n    at parser\nXML:\nfixture text says timeout ERR_CONNECTION_TIMED_OUT ERR_NETWORK_CHANGED'), {
      code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });
    assert.deepEqual(classifyUpdateError(invalidManifest), {
      category: 'service', retryDirect: false, code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
    });
    const checker = createUpdateChecker({ session, checkForUpdates: async () => { throw invalidManifest; } });
    await assert.rejects(checker(), error => error === invalidManifest);
    assert.deepEqual(session.proxyChanges, [], 'manifest parsing errors are not retried, even when their XML body contains network markers.');
  }

  {
    const session = mockSession();
    const setProxy = session.setProxy.bind(session);
    session.setProxy = async config => {
      if (config.mode === 'system' && session.proxyChanges.includes('direct')) throw new Error('system proxy restore failed');
      await setProxy(config);
    };
    const proxyError = Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { code: 'ERR_PROXY_CONNECTION_FAILED' });
    const checker = createUpdateChecker({
      session,
      checkForUpdates: async () => {
        if (session.mode === 'system') throw proxyError;
        return available;
      },
    });
    await assert.rejects(checker(), error => error.code === 'ERR_UPDATER_PROXY_RESTORE_FAILED');
    assert.equal(session.mode, 'direct', 'the failed restore is reported instead of returning an available update result.');
  }

  {
    const session = mockSession();
    const waiting = deferred();
    let checks = 0;
    const checker = createUpdateChecker({ session, checkForUpdates: () => { checks += 1; return waiting.promise; } });
    const first = checker();
    const second = checker();
    assert.equal(first, second, 'concurrent checks share one in-flight operation.');
    assert.equal(checks, 1);
    waiting.resolve(available);
    assert.equal(await first, available);
    assert.equal(session.proxyChanges.length, 0);
  }

  console.log('Windows update check contracts passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
