// 本地 OpenAI 兼容 mock，用于在没有真实 API key 时验证流式链路 / 重试 / 超时。
// 用法: node scripts/mock-openai.mjs  (环境变量: PORT, FAIL_TIMES, DELAY_MS, CHUNKS)
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4010);
const FAIL_TIMES = Number(process.env.FAIL_TIMES ?? 0);
const DELAY_MS = Number(process.env.DELAY_MS ?? 120);
const CHUNKS = Number(process.env.CHUNKS ?? 8);

let calls = 0;

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

createServer(async (req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let bytes = 0;
  for await (const part of req) bytes += part.length;
  calls += 1;
  console.error(`[mock] call #${calls} ${req.method} ${req.url} body=${bytes}B`);

  if (calls <= FAIL_TIMES) {
    res.writeHead(503, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: { message: 'mock upstream overloaded', type: 'mock_error' } }),
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': `mock-${calls}`,
  });

  res.write(chunk({ role: 'assistant', content: '' }));
  for (let i = 0; i < CHUNKS; i += 1) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    res.write(chunk({ content: `tok${i} ` }));
  }
  res.write(chunk({}, 'stop'));
  res.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4o-mini',
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: CHUNKS, total_tokens: 11 + CHUNKS },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(PORT, () => console.error(`[mock] listening on http://127.0.0.1:${PORT}/v1`));
