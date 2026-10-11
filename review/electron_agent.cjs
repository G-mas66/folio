// Exercise the actual Electron -> preload -> backend -> provider -> PDF reader flow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createAgentFixture } = require('./fixture_agent_api.cjs');
const root = path.resolve(__dirname, '..');
const output = process.env.AGENT_REVIEW_OUTPUT || path.join(root, '.review', `agent-1.1.0-${Date.now()}`);
const data = path.join(output, 'data');
const env = { ...process.env, WORKBENCH_DATA_DIR: data, WORKBENCH_CREDENTIAL_ROOT: data,
  WORKBENCH_LOCATION_CONFIG: path.join(output, 'location.json'), APPDATA: path.join(output, 'profile'),
  LOCALAPPDATA: path.join(output, 'local-profile'), USERPROFILE: path.join(output, 'user'),
  TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp'), PYTHONIOENCODING: 'utf-8' };
for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, env.TEMP]) fs.mkdirSync(directory, { recursive: true });
delete env.ELECTRON_RUN_AS_NODE;
delete env.WORKBENCH_DEV;
const seed = spawnSync(path.join(root, '.venv/Scripts/python.exe'), ['-B', '-m', 'review.seed_reader_fixture', data], { cwd: root, env, encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);
const { paper_id: paperId } = JSON.parse(seed.stdout.trim());

(async () => {
  const fixture = await createAgentFixture();
  const errors = [];
  const checks = [];
  let application, page;
  try {
    application = await _electron.launch({ cwd: root, env, timeout: 90000,
      executablePath: process.env.REVIEW_EXECUTABLE || path.join(root, 'node_modules/electron/dist/electron.exe'),
      args: process.env.REVIEW_EXECUTABLE ? [] : ['.'] });
    page = await application.firstWindow();
    // Poll awaited API results in Node; waitForFunction treats a Promise as truthy.
    const waitForApi = async (predicate, argument, options = {}) => {
      const deadline = Date.now() + (options.timeout || 30000);
      while (Date.now() < deadline) {
        const value = await page.evaluate(predicate, argument);
        if (value) return { dispose: async () => {}, jsonValue: async () => value };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for the API condition');
    };
    page.on('pageerror', error => errors.push(error.message));
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), '1.1.0');
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();
    const api = (suffix, method, body) => page.evaluate(input => window.workbench.request(input), {
      path: suffix.startsWith('/') ? suffix : `/papers/${paperId}/${suffix}`, method, body,
    });
    await api('/settings', 'PUT', { base_url: fixture.apiUrl, protocol: 'custom_chat_completions', model: 'deepseek-flash', api_key: 'review-only-agent-key' });
    await api('/settings/models', 'PUT', { models: ['deepseek-flash', 'fixture-basic'] });
    await page.locator('.paper-card').getByRole('button', { name: '阅读', exact: true }).click();
    const reader = page.getByTestId(`reader-tab-panel-${paperId}`);
    await reader.getByLabel('当前页码').waitFor();
    await reader.getByRole('button', { name: '原文 PDF', exact: true }).click();
    await reader.locator('.textLayer').filter({ hasText: '137' }).first().waitFor();
    const select = async quote => {
      const point = await reader.evaluate((element, text) => {
        const frame = element.querySelector('.pdf-page-frame[data-page-number="1"][data-rendered="true"]');
        const span = [...frame.querySelectorAll('.textLayer span')].find(node => node.textContent.includes(text));
        if (!span) throw new Error(`Missing fixture quote: ${text}`);
        const node = [...span.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
        const offset = node.textContent.indexOf(text);
        const range = document.createRange();
        range.setStart(node, offset); range.setEnd(node, offset + text.length);
        const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
        const rect = range.getBoundingClientRect();
        frame.querySelector('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.left + 1, clientY: rect.top + 1 }));
        return { x: rect.left + 2, y: rect.top + 2 };
      }, quote);
      await page.mouse.click(point.x, point.y, { button: 'right' });
      await reader.getByTestId('reader-selection-context-menu').waitFor();
    };
    await select('137 independent samples');
    await reader.getByRole('button', { name: 'AI 批注', exact: true }).click();
    await reader.getByLabel('AI 批注问题').fill('为什么使用独立样本？');
    await reader.getByRole('button', { name: '生成预览', exact: true }).click();
    await reader.getByLabel('AI 批注解释').waitFor();
    assert.match(await reader.getByLabel('AI 批注解释').inputValue(), /问题：[\s\S]*简要解释：/);
    assert.equal((await api('annotations')).length, 0, 'AI generation must not persist annotations');
    await page.screenshot({ path: path.join(output, 'ai-annotation-preview.png') });
    await reader.getByRole('button', { name: '保存批注', exact: true }).click();
    await waitForApi(async id => (await window.workbench.request({ path: `/papers/${id}/annotations` })).length === 1, paperId);
    const saved = (await api('annotations'))[0];
    assert.equal(saved.selected_text, '137 independent samples');
    checks.push('Right-click question-first AI annotation and explicit save');

    await reader.getByTestId('reader-side-tab-chat').click();
    await reader.getByTestId('reader-thinking-mode').selectOption('enabled');
    await reader.getByTestId('reader-reasoning-effort').selectOption('high');
    await reader.getByLabel('向当前文献提问').fill('解释独立样本的作用');
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).waitFor();
    const messages = await api('chat');
    assert.ok(messages.some(message => message.reasoning?.includes('先检查文献')));
    assert.ok(fixture.requests.some(request => request.thinking?.type === 'enabled' && request.reasoning_effort === 'high'));
    checks.push('Thinking controls traverse real IPC and reasoning is persisted');

    await reader.getByLabel('向当前文献提问').fill('找到对应原文，把问题和简要解释批注进去');
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).waitFor();
    const pending = (await api('agent-actions')).find(action => action.kind === 'annotation' && action.status === 'pending');
    assert.ok(pending, 'Chat must create a pending annotation action');
    assert.equal((await api('annotations')).length, 1);
    checks.push('Natural chat tool prepares annotation without writing it');
    const card = reader.getByTestId(`reader-agent-action-${pending.id}`);
    await card.getByTestId(`reader-agent-action-location-${pending.id}-0`).click();
    await card.getByTestId('reader-action-location-preview').waitFor();
    await page.screenshot({ path: path.join(output, 'chat-annotation-location.png') });
    await card.getByTestId(`reader-agent-action-text-${pending.id}`).fill('问题：为什么使用独立样本？\n简要解释：人工确认后的简要解释。');
    await card.getByTestId(`reader-agent-action-confirm-${pending.id}`).click();
    await waitForApi(async id => (await window.workbench.request({ path: `/papers/${id}/annotations` })).length === 2, paperId);
    const located = (await api('annotations')).find(item => item.comment.includes('人工确认'));
    assert.equal(located.page_no, 1);
    assert.equal(located.selected_text, '137 independent samples');
    assert.ok(located.rects.length && located.rects.every(rect => rect.width > 0 && rect.height > 0));
    await api(`agent-actions/${pending.id}/confirm`, 'POST', {});
    assert.equal((await api('annotations')).length, 2, 'Repeated confirmation must be idempotent');
    checks.push('Retrieved quotation locates real PDF geometry and edited confirmation is idempotent');

    await reader.getByLabel('向当前文献提问').fill('把这段解释保存到笔记');
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await reader.getByRole('button', { name: '发送 ↑', exact: true }).waitFor();
    const noteAction = (await api('agent-actions')).find(action => action.kind === 'note' && action.status === 'pending');
    assert.ok(noteAction);
    assert.equal((await api('notes')).text, '');
    await reader.getByTestId('reader-side-tab-notes').click();
    await reader.getByTestId('reader-note-editor').fill('现有未保存心得。');
    await reader.getByTestId('reader-side-tab-chat').click();
    const noteCard = reader.getByTestId(`reader-agent-action-${noteAction.id}`);
    await noteCard.getByTestId(`reader-agent-action-text-${noteAction.id}`).fill('经确认的阅读心得。');
    await noteCard.getByTestId(`reader-agent-action-confirm-${noteAction.id}`).click();
    await waitForApi(async id => (await window.workbench.request({ path: `/papers/${id}/notes` })).text.includes('经确认'), paperId);
    assert.equal((await api('notes')).text, '现有未保存心得。\n\n经确认的阅读心得。');
    checks.push('Chat note confirmation flushes existing draft and appends edited content');
    await page.screenshot({ path: path.join(output, 'agent-preview.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ version: '1.1.0', packaged: Boolean(process.env.REVIEW_EXECUTABLE), checks, providerRequests: fixture.requests.length, errors }, null, 2));
    console.log(JSON.stringify({ output, checks, errors }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    throw error;
  } finally {
    if (application) await application.close();
    await new Promise(resolve => fixture.server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
