import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  StopCondition,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from 'ai';

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 结构化单行 JSON，直接可被 Loki / CloudWatch 之类按 event 字段过滤。 */
export function createJsonLogger(minLevel: LogLevel = 'info'): AgentLogger {
  return {
    log(level, event, fields = {}) {
      if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
      const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
      if (level === 'error') console.error(line);
      else console.log(line);
    },
  };
}

/* ------------------------------------------------------------------ *
 * AgentClient
 * ------------------------------------------------------------------ */

export interface AgentClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** 单次尝试的总超时（含整个流式读取），默认 60s */
  timeoutMs?: number;
  /** 只重试"还没开始吐字"的失败，默认 2 */
  maxRetries?: number;
  /** 指数退避基数，默认 300ms */
  retryBaseDelayMs?: number;
  logger?: AgentLogger;
}

export interface StreamOptions {
  /** 会话 id，日志里用它把同一轮对话串起来 */
  conversationId?: string;
  /** 调用方中止信号（例如 req.signal），用户关页面时能立刻止损 */
  signal?: AbortSignal;
  system?: string;
  /** 工具集；传了就会自动跑多步循环（工具调用 → 结果 → 再生成） */
  tools?: ToolSet;
  /** 多步停止条件，默认有工具时最多 5 步 */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
}

/** 一次请求的共享状态：传输层写，流层读，用来判断到底为什么断了 */
interface Trace {
  requestId: string;
  conversationId: string;
  timedOut: boolean;
  aborted: boolean;
  attempts: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

type FailReason = 'aborted' | 'timeout' | 'upstream';

/** 只把可操作的结论透给浏览器，不泄漏上游原始报文 */
function friendlyMessage(reason: FailReason, error: unknown): string {
  if (reason === 'aborted') return '请求已取消';
  if (reason === 'timeout') return '模型响应超时，请重试';

  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;

  if (status === 401 || status === 403) return '模型服务鉴权失败，请检查 API Key';
  if (status === 404) return '模型不存在，请检查 OPENAI_MODEL 配置';
  if (status === 400 || status === 422) return '请求被模型服务拒绝';
  return '模型服务暂时不可用，请重试';
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'UnknownError', message: String(error) };
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class AgentClient {
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly logger: AgentLogger;

  constructor(options: AgentClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
    this.logger = options.logger ?? createJsonLogger();
  }

  /**
   * 把一轮对话变成 SSE 响应。
   * 重试只发生在"拿到响应头之前"，所以不会出现前半段已渲染、又重新来一遍；
   * 流中断（超时/上游掐断）会补一个 error part，前端能显示原因而不是静默截断。
   */
  async respond(messages: UIMessage[], options: StreamOptions = {}): Promise<Response> {
    const trace: Trace = {
      requestId: crypto.randomUUID(),
      conversationId: options.conversationId ?? crypto.randomUUID(),
      timedOut: false,
      aborted: false,
      attempts: 0,
    };
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;

    this.logger.log('info', 'agent.request', {
      requestId: trace.requestId,
      conversationId: trace.conversationId,
      model: this.model,
      messages: messages.length,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    });

    const provider = createOpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      fetch: this.createGuardedFetch(trace),
    });

    const result = streamText({
      model: provider.chat(this.model),
      system: options.system,
      messages: await convertToModelMessages(messages),
      abortSignal: options.signal,
      tools: options.tools,
      stopWhen: options.stopWhen ?? (options.tools ? stepCountIs(5) : undefined),
      // 重试由 AgentClient 负责，关掉 SDK 内建的，避免两层叠加放大流量
      maxRetries: 0,
      onChunk: ({ chunk }) => {
        if (chunk.type === 'tool-call') {
          this.logger.log('info', 'agent.tool_call', {
            requestId: trace.requestId,
            conversationId: trace.conversationId,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
          });
        }
        if (firstTokenAt || chunk.type !== 'text-delta') return;
        firstTokenAt = Date.now();
        this.logger.log('info', 'agent.first_token', {
          requestId: trace.requestId,
          conversationId: trace.conversationId,
          ttftMs: firstTokenAt - startedAt,
          attempt: trace.attempts,
        });
      },
      onFinish: ({ usage, finishReason }) => {
        this.logger.log('info', 'agent.finish', {
          requestId: trace.requestId,
          conversationId: trace.conversationId,
          finishReason,
          durationMs: Date.now() - startedAt,
          attempts: trace.attempts,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        });
      },
    });

    // SDK 会把上游错误转成 error part 并抹掉细节，这里先留一份原始错误用于日志和归类
    let upstreamError: unknown;
    const uiStream = result.toUIMessageStream({
      onError: (error) => {
        upstreamError ??= error;
        return 'stream error';
      },
    });

    return createUIMessageStreamResponse({
      stream: this.pump(uiStream, trace, startedAt, () => Boolean(firstTokenAt), () => upstreamError),
    });
  }

  /** 接管 SDK 的 chunk 流：异常/中断时补一条可读的 error part，而不是静默截断 */
  private pump(
    source: ReadableStream<UIMessageChunk>,
    trace: Trace,
    startedAt: number,
    hasFirstToken: () => boolean,
    getUpstreamError: () => unknown,
  ): ReadableStream<UIMessageChunk> {
    const reader = source.getReader();
    const { logger } = this;
    let cancelled = false;

    const report = (reason: FailReason, error: unknown) => {
      const { name, message } = describeError(error);
      logger.log(reason === 'aborted' ? 'warn' : 'error', 'agent.stream_error', {
        requestId: trace.requestId,
        conversationId: trace.conversationId,
        reason,
        name,
        message,
        attempts: trace.attempts,
        afterFirstToken: hasFirstToken(),
        durationMs: Date.now() - startedAt,
      });
      return friendlyMessage(reason, error);
    };

    const reasonOf = (): FailReason =>
      trace.aborted ? 'aborted' : trace.timedOut ? 'timeout' : 'upstream';

    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        // 客户端断开后 controller 已经关了，此时再 enqueue 会抛 Invalid state
        const emit = (chunk: UIMessageChunk) => {
          if (cancelled) return;
          try {
            controller.enqueue(chunk);
          } catch {
            cancelled = true;
          }
        };
        const close = () => {
          if (cancelled) return;
          try {
            controller.close();
          } catch {
            cancelled = true;
          }
        };

        try {
          const { done, value } = await reader.read();
          if (done) {
            // 超时/取消往往表现为流"正常结束"，这里补一条日志，否则事后查不到
            if (trace.aborted || trace.timedOut) {
              report(reasonOf(), new Error('stream closed by signal'));
            }
            close();
            return;
          }
          // SDK 自己已经转成 error part 的情况（例如上游 4xx）
          if (value.type === 'error') {
            const reason = reasonOf();
            emit({
              ...value,
              errorText: report(reason, getUpstreamError() ?? value.errorText),
            });
            return;
          }
          emit(value);
        } catch (error) {
          emit({ type: 'error', errorText: report(reasonOf(), error) });
          close();
        }
      },
      cancel(reason) {
        cancelled = true;
        void reader.cancel(reason);
      },
    });
  }

  /** 带超时、重试、日志的 fetch，包住所有对模型的 HTTP 调用 */
  private createGuardedFetch(trace: Trace): typeof fetch {
    const { logger, timeoutMs, maxRetries, retryBaseDelayMs } = this;

    return async (input, init) => {
      const callerSignal = init?.signal ?? undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        trace.attempts = attempt + 1;
        // 单次尝试的总超时：body 还没读完就超时会连带中断整条流
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, timeoutSignal])
          : timeoutSignal;
        const startedAt = Date.now();

        // 流的读取发生在 fetch 之后，所以中断原因要在信号层面记下来
        timeoutSignal.addEventListener('abort', () => (trace.timedOut = true), { once: true });
        callerSignal?.addEventListener('abort', () => (trace.aborted = true), { once: true });

        try {
          const response = await fetch(input, { ...init, signal });
          const durationMs = Date.now() - startedAt;
          const canRetry = RETRYABLE_STATUS.has(response.status) && attempt < maxRetries;

          logger.log(canRetry ? 'warn' : 'info', canRetry ? 'http.retry' : 'http.response', {
            attempt: attempt + 1,
            status: response.status,
            durationMs,
            upstreamRequestId: response.headers.get('x-request-id') ?? undefined,
            requestId: trace.requestId,
          });

          if (!canRetry) return response;

          // 丢掉这次失败的响应体，避免连接泄漏
          await response.body?.cancel();
        } catch (error) {
          const reason = callerSignal?.aborted
            ? 'aborted'
            : timeoutSignal.aborted
              ? 'timeout'
              : 'network';
          trace.aborted ||= reason === 'aborted';
          trace.timedOut ||= reason === 'timeout';

          logger.log(reason === 'network' ? 'error' : 'warn', 'http.attempt_failed', {
            requestId: trace.requestId,
            attempt: attempt + 1,
            reason,
            ...describeError(error),
            durationMs: Date.now() - startedAt,
          });

          // 调用方取消 / 已经超时 / 网络还没恢复：不重试
          if (reason !== 'network' || attempt >= maxRetries) throw error;
        }

        const backoffMs = Math.min(retryBaseDelayMs * 2 ** attempt + Math.random() * 100, 5_000);
        logger.log('warn', 'http.backoff', {
          requestId: trace.requestId,
          attempt: attempt + 1,
          backoffMs: Math.round(backoffMs),
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      throw new Error('AgentClient: retries exhausted');
    };
  }
}

/* ------------------------------------------------------------------ *
 * 默认实例
 * ------------------------------------------------------------------ */

let defaultClient: AgentClient | undefined;

export function getAgentClient(): AgentClient {
  if (!defaultClient) {
    defaultClient = new AgentClient({
      timeoutMs: parseEnvInt(process.env.AGENT_TIMEOUT_MS, 60_000),
      maxRetries: parseEnvInt(process.env.AGENT_MAX_RETRIES, 2),
      logger: createJsonLogger((process.env.AGENT_LOG_LEVEL as LogLevel) ?? 'info'),
    });
  }
  return defaultClient;
}
