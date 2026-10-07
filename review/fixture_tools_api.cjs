// Independent fake provider: choose tools, consume text evidence and produce Markdown.
const http = require('node:http');

async function createToolsFixture() {
  const requests = [];
  const requestPath = '/provider/custom-endpoint/?route=paper%2Bnotes';
  const modelPath = '/catalog/custom-endpoint/?route=models%2Blist';
  const modelRequests = [];
  const state = { rejectNext: null, delayMs: 0 };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === modelPath) {
      modelRequests.push({ path: request.url, authorized: request.headers.authorization === 'Bearer review-only-tools-key' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'fixture-A' }, { id: 'fixture-B' }, { id: 'mimo-v6pro' }] }));
    }
    if (request.method !== 'POST' || request.url !== requestPath) return response.writeHead(404).end();
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, ...body });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.rejectNext) {
      const status = state.rejectNext;
      state.rejectNext = null;
      return response.writeHead(status).end('{}');
    }
    const last = body.messages.at(-1);
    const text = body.messages.map(message => message.content || '').join('\n');
    const ids = [...text.matchAll(/\[(S\d+)\]|"source_id"\s*:\s*"(S\d+)"/g)].map(match => match[1] || match[2]);
    let content;
    let toolCalls;
    if (body.tools && last.role !== 'tool') {
      const question = last.content || '';
      if (/总结.*文献/.test(question)) {
        toolCalls = [{ id: 'call_summary', type: 'function', function: { name: 'summarize_paper', arguments: '{}' } }];
      } else if (/样本|seed|数据|文献/.test(question)) {
        toolCalls = [{ id: 'call_read', type: 'function', function: { name: 'read_paper', arguments: JSON.stringify({ query: question.includes('seed') ? 'seed' : 'independent samples' }) } }];
      } else {
        content = `## 普通聊天\n\n当前模型：**${body.model}**。\n\n- 无需读取文献\n- 支持 Markdown\n\n| 项目 | 数值 |\n| --- | --- |\n| 计算 | 4 |\n\n\`\`\`python\nprint(2 + 2)\n\`\`\`\n\n<script>window.__markdownUnsafe = true</script>\n\n![远程图片](https://invalid.example/test.png)`;
      }
    } else if (text.includes('137 independent samples') && !body.tools) {
      content = `本段使用 137 个独立样本，信号增加 23.7%，生成种子 811。[${ids[0]}]`;
    } else if (text.includes('分块摘要') || last.role === 'tool') {
      content = `## 文献解读\n\n使用 **137** 个独立样本，信号增加 **23.7%**，生成种子 **811**。[${ids[0]}]\n\n| 事实 | 数值 |\n| --- | --- |\n| 样本 | 137 |\n| 种子 | 811 |`;
    } else {
      content = '测试连接正常。';
    }
    const message = { role: 'assistant', content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (toolCalls) {
        const call = toolCalls[0];
        frame({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
        frame({ tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] });
      } else {
        for (let index = 0; index < content.length; index += 24) frame({ content: content.slice(index, index + 24) });
      }
      frame({}, toolCalls ? 'tool_calls' : 'stop');
      return response.end('data: [DONE]\n\n');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: toolCalls ? 'tool_calls' : 'stop', message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, modelRequests, state, requestPath, apiUrl: `http://127.0.0.1:${server.address().port}${requestPath}`, modelsUrl: `http://127.0.0.1:${server.address().port}${modelPath}` };
}

module.exports = { createToolsFixture };
