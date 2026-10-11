// Local provider fixture for end-to-end Windows reader Agent verification.
const http = require('node:http');

async function createAgentFixture() {
  const requests = [];
  const state = { delayMs: 0, reasoningDelayMs: 0, reasoningSent: 0, missingQuote: false, repeatedQuote: false, failNext: false };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'fixture-basic' }] }));
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.failNext) {
      state.failNext = false;
      return response.writeHead(429).end(JSON.stringify({ error: { message: 'Synthetic rate limit' } }));
    }
    const messages = body.messages || [];
    const userContent = [...messages].reverse().find(message => message.role === 'user')?.content || '';
    const userText = typeof userContent === 'string' ? userContent
      : Array.isArray(userContent) ? userContent.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
    const last = messages.at(-1);
    const toolNames = (body.tools || []).map(tool => tool.function.name);
    let calls;
    let content = '独立样本用于减少样本间的依赖，使估计更可靠。';
    const thinking = body.thinking?.type === 'enabled' || Boolean(body.reasoning_effort && body.reasoning_effort !== 'none');
    const reasoning = thinking ? '先检查文献中的样本描述，再结合方法目的解释。' : '';
    if (toolNames.includes('prepare_note') && /保存到笔记|追加到笔记/.test(userText) && last?.role !== 'tool') {
      calls = [{ id: 'qa_note', type: 'function', function: { name: 'prepare_note', arguments: JSON.stringify({ text: '新增阅读笔记：独立样本减少观测间依赖。' }) } }];
    } else if (toolNames.includes('prepare_annotation') && /批注/.test(userText) && last?.role !== 'tool') {
      if (!messages.slice(messages.findLastIndex(message => message.role === 'user')).some(message => message.role === 'tool' && message.tool_call_id === 'qa_read')) {
        calls = [{ id: 'qa_read', type: 'function', function: { name: 'read_paper', arguments: JSON.stringify({ query: 'independent samples', start_page: 1, end_page: 1 }) } }];
      }
    } else if (last?.role === 'tool' && last.tool_call_id === 'qa_read' && /批注/.test(userText)) {
      calls = [{ id: 'qa_annotation', type: 'function', function: { name: 'prepare_annotation', arguments: JSON.stringify({
        question: '为什么使用独立样本？', explanation: '减少样本间依赖，使估计更可靠。',
        quote: state.missingQuote ? 'NONEXISTENT ORIGINAL PHRASE' : '137 independent samples',
        ...(state.repeatedQuote ? {} : { page_no: 1 }), use_selection: /这里|选区/.test(userText),
      }) } }];
    } else if (last?.role === 'tool') {
      content = '草稿已准备，请查看原文位置和内容，确认后保存。';
    }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (reasoning) {
        frame({ reasoning_content: reasoning });
        state.reasoningSent++;
        if (state.reasoningDelayMs) await new Promise(resolve => setTimeout(resolve, state.reasoningDelayMs));
      }
      if (calls) {
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index];
          frame({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] });
        }
      } else {
        for (let index = 0; index < content.length; index += 10) frame({ content: content.slice(index, index + 10) });
      }
      frame({}, calls ? 'tool_calls' : 'stop');
      return response.end('data: [DONE]\n\n');
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: calls ? null : content,
      ...(calls ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}),
    } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, state, apiUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
}

module.exports = { createAgentFixture };
