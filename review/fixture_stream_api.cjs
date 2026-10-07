// Independent slow SSE provider for visible progress and real cancellation.
const http = require('node:http');

async function createStreamFixture() {
  const requests = [];
  const sessions = [];
  const modelRequests = [];
  const requestPath = '/literal/stream-endpoint/?routing=test%2Bstream';
  const state = { pause: false, pauseFullPrompt: false, pauseContent: false, finish: 'stop', closeBeforeFinish: false };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && ['/v1/models', '/literal/stream-endpoint/models?routing=test%2Bstream'].includes(request.url)) {
      modelRequests.push({ path: request.url, authorized: Boolean(request.headers.authorization) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'stream-fixture' }, { id: 'fixture-B' }, { id: 'mimo-v6pro' }] }));
    }
    if (request.method !== 'POST' || request.url !== requestPath) return response.writeHead(404).end();
    let raw = '';
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, ...body });
    const session = { closedEarly: false, completed: false, contentPieces: 0, reasoningPieces: 0 };
    sessions.push(session);
    response.on('close', () => { session.closedEarly = !session.completed; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const frame = (delta, finish = null) => {
      if (response.destroyed) return;
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (delta.content) session.contentPieces++;
      if (delta.reasoning_content) session.reasoningPieces++;
    };
    const wait = async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return !response.destroyed;
    };
    frame({ reasoning_content: '这是接口返回的思考第一段。' });
    if (!await wait()) return;
    frame({ reasoning_content: '思考第二段，检查资料来源。' });
    if (state.pause || (state.pauseFullPrompt && !body.tools)) {
      for (let i = 0; i < 100 && await wait(); i++) frame({ reasoning_content: '等待服务端继续。' });
      if (response.destroyed) return;
    }
    const last = body.messages.at(-1);
    if (body.tools && last.role === 'user' && (/详细总结/.test(last.content) || (/联网/.test(last.content) && body.tools.some(tool => tool.function.name === 'web_search')))) {
      const search = /联网/.test(last.content);
      frame({ tool_calls: [{ index: 0, id: search ? 'search_call' : 'summary_call', type: 'function', function: { name: search ? 'web_search' : 'summarize_paper', arguments: search ? '{"query":' : '{' } }] });
      if (!await wait()) return;
      frame({ tool_calls: [{ index: 0, function: { arguments: search ? '"Python official documentation"}' : '}' } }] });
      frame({}, 'tool_calls');
    } else {
      let pieces;
      if (!body.tools && body.messages.some(message => message.content?.includes('137 independent samples'))) {
        const source = body.messages.map(message => message.content).join('\n').match(/\[(S\d+)\]/)[1];
        pieces = ['## 完整原文总结\n\n', `137 个样本、23.7% 与种子 811。[${source}]`];
      } else if (last.role === 'tool') {
        pieces = ['## 联网回答\n\n', '已读取搜索返回的标题、链接与摘要。', '\n\n来源：[W1]。'];
      } else if (last.role === 'user' && /RBM排版验收/.test(last.content)) {
        pieces = [
          '## RBM 排版验收\n\n这些是合成公式，用于验证界面排版。\n\n行内权重 $W_{ij}$ 与转置 $\\mathbf{x}^{\\mathsf{T}}$。\n\n',
          '$$\nE(\\mathbf{x},\\mathbf{h})=-\\sum_i\\sum_j x_i W_{ij}h_j-\\sum_i c_i x_i-\\sum_j b_j h_j\n$$\n\n',
          '$$\nP(\\mathbf{x},\\mathbf{h})=\\frac{1}{Z}\\exp\\left(-E(\\mathbf{x},\\mathbf{h})\\right)\n$$\n\n',
          '$$\nP(h_j=1\\mid\\mathbf{x})=\\sigma\\left(b_j+\\sum_i W_{ij}x_i\\right)\n$$\n\n',
          '```text\nW_{ij} 与 Σ_i 在代码内保持原样\n```\n\n排版结束。',
        ];
      } else {
        pieces = ['## 流式回答\n\n第一段已收到。\n\n', '行内公式 $E=mc^2$，括号公式 \\(a^2+b^2=c^2\\)。\n\n', '$$\n\\frac{1}{n}\\sum_{i=1}^{n}x_i\n$$\n\n', '\\[\\int_0^1 x^2 dx=\\frac{1}{3}\\]\n\n', '```text\n\\(do not render code\\)\n```\n\n', '最后一段完成。'];
      }
      for (const piece of pieces) {
        if (!await wait()) return;
        frame({ content: piece });
        if (state.pauseContent) {
          for (let i = 0; i < 100 && await wait(); i++) {}
          if (response.destroyed) return;
        }
      }
      if (state.closeBeforeFinish) return response.end();
      frame({}, state.finish);
    }
    session.completed = true;
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, sessions, modelRequests, state, requestPath, apiUrl: `http://127.0.0.1:${server.address().port}${requestPath}` };
}

module.exports = { createStreamFixture };
