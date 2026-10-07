// Test-only OpenAI-compatible service. Never imported by the product.
const http = require('node:http');

function sourceSections(text) {
  return [...text.matchAll(/\[(S\d+)\] 原文页码 \d+-\d+\n([\s\S]*?)(?=\n\n\[S\d+\]|$)/g)]
    .map(match => ({ id: match[1], text: match[2] }));
}

function facts(text, fallbackId) {
  const lines = [];
  for (const section of sourceSections(text)) {
    const sample = section.text.match(/QUARTZ_METHOD_N=(\d+)/) || section.text.match(/(\d+)\s+independent samples/);
    const delta = section.text.match(/QUARTZ_RESULT_DELTA=([\d.]+)%/) || section.text.match(/signal increased by\s+([\d.]+)%/);
    const seed = section.text.match(/QUARTZ_APPENDIX_SEED=(\d+)/) || section.text.match(/seed was\s+(\d+)/);
    if (sample) lines.push(`实验采用 ${sample[1]} 个独立样本，设置参考组和处理组。[${section.id}]`);
    if (delta) lines.push(`信号增加 ${delta[1]}%，未开展实地实验。[${section.id}]`);
    if (seed) lines.push(`附录记录数据生成种子 ${seed[1]}。[${section.id}]`);
  }
  return lines.length ? lines.join('\n') : `本段讨论实验条件和重复测量。[${fallbackId}]`;
}

async function createFixture() {
  const requests = [];
  const freeRequests = [];
  const requestPath = '/provider/custom-endpoint/?route=paper%2Bnotes';
  const freePath = '/provider/free-translation/?route=pdf%2Bnotes';
  const state = { nextFinishReason: null, rejectNext: null, delayMs: 0 };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || ![requestPath, freePath].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url === freePath) {
      const source = body.text.split('Input:\n\n').at(-1);
      freeRequests.push({ path: request.url, text: body.text, source, authorization: request.headers.authorization || null });
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      const content = !source.includes('\n') && source.length < 120
        ? '测试文献：石英测量研究' : '测试译文：' + source;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ content }));
      return;
    }
    requests.push({ path: request.url, model: body.model, messages: body.messages, stream: body.stream });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.rejectNext) {
      const status = state.rejectNext;
      state.rejectNext = null;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Intentional test-only failure' } }));
      return;
    }
    const text = body.messages.map(message => message.content).join('\n');
    const sources = [...text.matchAll(/\[(S\d+)\]/g)].map(match => match[1]);
    let content;
    if (text.includes('英译中译者')) {
      if (text.includes('这是论文标题')) {
        content = text.includes('Long Document') ? '测试文献：长文覆盖检查' : '测试文献：石英测量研究';
      } else {
        const last = body.messages.at(-1).content;
        const sample = last.match(/QUARTZ_METHOD_N=(\d+)/);
        const delta = last.match(/QUARTZ_RESULT_DELTA=([\d.]+)%/);
        const seed = last.match(/QUARTZ_APPENDIX_SEED=(\d+)/);
        content = sample ? `方法：使用 ${sample[1]} 个独立样本，设置参考组和处理组，重复测量三次。\n${sample[0]}`
          : delta ? `结果与局限：信号增加 ${delta[1]}%；未开展实地实验。\n${delta[0]}`
          : seed ? `附录：数据生成种子为 ${seed[1]}，用于复现实验。\n${seed[0]}`
          : '测试译文：本文评估固定实验条件下的测量方法。具体方法、结果与复现信息分别记录在后续章节。';
      }
    } else if (text.includes('英文检索关键词')) {
      content = 'sample, method, result, appendix, reference group';
    } else if (text.includes('全文按顺序切分')) {
      content = facts(text, sources[0]);
    } else if (text.includes('分块摘要')) {
      content = '【验收服务生成的测试总结】\n\n研究目的：评价固定实验条件下的测量方法。\n\n'
        + body.messages.at(-1).content.split('\n\n').slice(1).join('\n\n');
    } else if (sources.length) {
      content = '【验收服务生成的测试回答】\n' + facts(text, sources[0]);
    } else {
      content = '验收服务连接正常。';
    }
    const finishReason = state.nextFinishReason || 'stop';
    state.nextFinishReason = null;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, requests, freeRequests, state, requestPath, freePath, apiUrl: base + requestPath, freeUrl: base + freePath };
}

module.exports = { createFixture };
