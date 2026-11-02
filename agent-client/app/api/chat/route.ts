import { tool, UIMessage } from 'ai';
import { z } from 'zod';
import { getAgentClient } from '@/lib/agent-client';

export const maxDuration = 60;

/**
 * 演示用工具：真数据、无外部依赖。
 * 模型自己决定要不要调，AgentClient 负责跑"调用 → 结果 → 再生成"的多步循环。
 */
const getCurrentTime = tool({
  description: '查询指定时区的当前时间。用户问"现在几点""今天几号"时必须调用，不要凭训练数据猜。',
  inputSchema: z.object({
    timeZone: z
      .string()
      .describe('IANA 时区名，例如 Asia/Shanghai、America/New_York、Europe/Berlin'),
  }),
  execute: async ({ timeZone }) => {
    const now = new Date();
    try {
      return {
        timeZone,
        iso: now.toISOString(),
        local: new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now),
      };
    } catch {
      return { error: `无法识别的时区: ${timeZone}` };
    }
  },
});

export async function POST(req: Request) {
  const {
    messages,
    id,
  }: { messages: UIMessage[]; id?: string } = await req.json();

  return getAgentClient().respond(messages, {
    conversationId: id,
    // 用户断开 / 关页面时把上游请求一起断掉，别继续烧 token
    signal: req.signal,
    system:
      '你是一个乐于助人的助手，用用户的语言回答。' +
      '涉及"现在几点/今天几号"时必须调用 get_current_time 工具，不要凭训练数据猜测。',
    tools: { get_current_time: getCurrentTime },
  });
}
