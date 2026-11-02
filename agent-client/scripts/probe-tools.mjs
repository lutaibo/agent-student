// 一次性探针：验证网关是否支持 OpenAI function calling
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

const model = process.env.OPENAI_MODEL ?? 'agnes-2.5-pro';
const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const weather = tool({
  description: '查询某个城市当前的天气',
  inputSchema: z.object({ city: z.string().describe('城市名，例如 北京') }),
  execute: async ({ city }) => {
    console.error('[tool] execute get_weather', { city });
    return { city, tempC: 23, condition: '晴' };
  },
});

const prompt =
  process.env.PROMPT ??
  '北京现在多少度？请调用工具查询，然后用一句中文回答，带摄氏度。';

console.error('[probe] model =', model);

const result = streamText({
  model: provider.chat(model),
  prompt,
  tools: { get_weather: weather },
  stopWhen: stepCountIs(3),
  maxRetries: 0,
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'text-delta':
      process.stdout.write(part.text ?? part.delta ?? '');
      break;
    case 'tool-call':
      console.log('\n[part] tool-call', JSON.stringify(part));
      break;
    case 'tool-result':
      console.log('[part] tool-result', JSON.stringify(part));
      break;
    case 'tool-error':
      console.log('[part] tool-error', JSON.stringify(part));
      break;
    case 'finish':
      console.log('\n[part] finish', JSON.stringify(part.extra ?? part.finishReason ?? part));
      break;
    case 'error':
      console.log('[part] ERROR', JSON.stringify(part.error ?? part));
      break;
    default:
      break;
  }
}

try {
  console.log('\n[usage]', JSON.stringify(await result.usage));
} catch (error) {
  // 上游报错时不会有 usage，别把探针炸掉
  console.log('\n[usage] unavailable:', error?.message ?? error);
}
