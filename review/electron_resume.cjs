// Actual native service restart and queue persistence with test-only credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createFixture } = require('./fixture_api.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.review', `resume-${Date.now()}`);
const dataRoot = path.join(output, 'data');
fs.mkdirSync(path.join(output, 'temp'), { recursive: true });

(async () => {
  const fixture = await createFixture();
  fixture.state.delayMs = 600;
  const env = { ...process.env, WORKBENCH_DATA_DIR: dataRoot, WORKBENCH_DEV: '0', WORKBENCH_FREE_API_URL: fixture.freeUrl, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  async function launch() {
    application = await _electron.launch({ executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'), args: process.env.REVIEW_EXECUTABLE ? [] : [root], cwd: root, env, timeout: 60000 });
    const main = await application.firstWindow();
    await main.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
    return main;
  }
  async function api(page, apiPath, method = 'GET', body) {
    return page.evaluate(input => window.workbench.request(input), { path: apiPath, method, body });
  }
  async function waitPaper(page, id, predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const paper = await api(page, `/papers/${id}`);
      if (predicate(paper)) return paper;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Queue did not reach expected state');
  }
  function assertSavedNotResent(saved, requestStart) {
    const resumedInputs = fixture.freeRequests.slice(requestStart).map(request => request.source);
    for (const segment of saved.filter(segment => segment.status === 'completed')) {
      assert.ok(!resumedInputs.some(input => input.includes(segment.original_text)), 'Persisted completed translation was sent twice');
    }
  }
  try {
    let main = await launch();
    await api(main, '/settings', 'PUT', { base_url: fixture.apiUrl, model: 'review-fixture', api_key: 'review-only-not-a-real-key' });
    const imported = await api(main, '/papers/import', 'POST', { paths: [path.join(root, '.review/fixtures/quartz_alpha.pdf')] });
    const firstId = imported.results[0].paper.id;
    await waitPaper(main, firstId, paper => paper.segment_done >= 1 && paper.status === 'translating');
    await api(main, `/papers/${firstId}/translation/stop`, 'POST');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const savedFirst = await api(main, `/papers/${firstId}/segments`);
    const stopped = await api(main, `/papers/${firstId}`);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.can_read, false);
    const stoppedCalls = fixture.freeRequests.length;
    await application.close();
    main = await launch();
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal((await api(main, `/papers/${firstId}`)).status, 'stopped');
    assert.equal(fixture.freeRequests.length, stoppedCalls, 'Paused task resumed without user action');
    await main.locator('.paper-card').filter({ hasText: 'quartz_alpha.pdf' }).getByRole('button', { name: '继续翻译', exact: true }).click();
    await waitPaper(main, firstId, paper => paper.can_read);
    assertSavedNotResent(savedFirst, stoppedCalls);

    const next = await api(main, '/papers/import', 'POST', { paths: [path.join(root, '.review/fixtures/quartz_beta_same_title.pdf')] });
    const secondId = next.results[0].paper.id;
    await waitPaper(main, secondId, paper => paper.segment_done >= 1 && paper.status === 'translating');
    const savedSecond = await api(main, `/papers/${secondId}/segments`);
    await application.close();
    const restartCalls = fixture.freeRequests.length;
    main = await launch();
    await waitPaper(main, secondId, paper => paper.can_read);
    assertSavedNotResent(savedSecond, restartCalls);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, stoppedSurvivesRestart: true, activeAutomaticallyResumes: true, completedSegmentsNotResent: true }, null, 2));
    console.log(`ELECTRON_RESUME_PASS ${output}`);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack || error));
    console.error(`ELECTRON_RESUME_FAIL ${error.stack || error}`);
    process.exitCode = 1;
  } finally {
    if (application) await application.close().catch(() => {});
    await new Promise(resolve => fixture.server.close(resolve));
    spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-c', 'from backend.ai import credential_service; import keyring; service=credential_service(); keyring.delete_password(service,"api-key") if keyring.get_password(service,"api-key") else None'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: dataRoot }, encoding: 'utf8' });
  }
})();
