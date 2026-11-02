# agent-client

Next.js + AI SDK 的最小流式对话，外面包一层带超时 / 重试 / 日志 / 工具调用的 `AgentClient`。

## 技术栈

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 框架 | Next.js 16.4.3（App Router + Turbopack） | 开了 `cacheComponents` / `partialPrefetching`，脚手架默认值 |
| UI | React 19.3 + Tailwind CSS 4 | Tailwind 走 `@tailwindcss/turbopack` loader |
| 模型接入 | AI SDK v7：`ai` / `@ai-sdk/openai` / `@ai-sdk/react` | 显式 provider，`openai.chat()` 走 `/chat/completions` 而非 `/responses` |
| 工具 schema | Zod 4 | 给 `tool()` 的 `inputSchema` 用 |
| Markdown | react-markdown 10 + remark-gfm | 只渲染助手消息，用户输入保持纯文本 |
| 语言 | TypeScript 5（`strict`） | |

## 功能

- **流式对话**：`POST /api/chat` 返回 SSE，前端 `useChat` 逐字渲染
- **超时**：每次尝试一个 `AbortSignal.timeout`，覆盖到流读完；超时不重试
- **重试**：只重试"还没开始吐字"的网络错误和 408/409/425/429/5xx，指数退避 + 抖动
- **日志**：单行 JSON，带 `requestId` + `conversationId`，可直接按 `event` 字段过滤
- **错误兜底**：流中断时补一个 `error` part，前端显示原因而不是静默截断
- **取消**：浏览器断开时 `req.signal` 传到上游，停止计费
- **工具调用**：`get_current_time`，默认最多 5 步循环，支持并行调用
- **Markdown**：标题 / 列表 / 代码块 / 表格 / 引用

## 跑起来

```bash
cp .env.example .env.local   # 填 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
npm run dev
```

默认配的是自建中转 `https://api.agnes-ai.cn/v1` + `agnes-2.5-flash`，换网关只改这两个变量。
模型名以网关为准，可以先查：

```bash
curl "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY"
```

没有 key 时用自带 mock 验证链路（按 120ms 间隔吐 8 个 token）：

```bash
npm run mock      # 终端 A，监听 127.0.0.1:4010
OPENAI_API_KEY=test OPENAI_BASE_URL=http://127.0.0.1:4010/v1 npm run dev   # 终端 B
```

## 结构

- `app/api/chat/route.ts` — 解析请求 + 声明工具（`get_current_time`），把活交给 `AgentClient`
- `lib/agent-client.ts` — `AgentClient`：超时、重试、日志、流中断兜底、工具多步循环
- `app/layout.tsx` — 根布局（Geist 字体）
- `app/page.tsx` — `useChat` 客户端，渲染文本 / 工具调用 / markdown
- `app/globals.css` — 包含 `.md` 排版
- `scripts/mock-openai.mjs` — OpenAI 兼容 mock，可模拟 503（`FAIL_TIMES`）和慢响应（`DELAY_MS`）
- `scripts/probe-tools.mjs` — 工具调用探针：`OPENAI_MODEL=agnes-2.5-flash node --env-file=.env.local scripts/probe-tools.mjs`

## AgentClient 行为

| 能力 | 做法 |
| --- | --- |
| 超时 | 每次尝试一个 `AbortSignal.timeout(timeoutMs)`，覆盖到流读完为止；超时不重试 |
| 重试 | 只在"还没开始吐字"时重试，流开始后不重试，避免用户看到重复内容 |
| 日志 | `agent.request` / `http.response` / `http.retry` / `http.backoff` / `http.attempt_failed` / `agent.first_token` / `agent.tool_call` / `agent.finish` / `agent.stream_error` |
| 错误分类 | 401/403 鉴权失败、404 模型不存在、400/422 请求被拒，其余按暂时不可用 |
| 工具 | `respond()` 传 `tools` 即可，默认 `stopWhen: stepCountIs(5)` |

配置见 `.env.example`：`AGENT_TIMEOUT_MS`、`AGENT_MAX_RETRIES`、`AGENT_LOG_LEVEL`。

## 已知限制

无对话持久化、无多会话切换、无鉴权限流、无自动化测试（验证靠脚本 + curl + 无头浏览器手测）、代码块无语法高亮。
