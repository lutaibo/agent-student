'use client';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Chat() {
  const [input, setInput] = useState('');
  // useChat 自己生成会话 id 并随请求发出，服务端用它把同一轮对话的日志串起来
  const { messages, sendMessage, status, error } = useChat();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="text-lg font-semibold">agent-client</h1>

      <div className="flex flex-col gap-4">
        {messages.map((message) => (
          <div key={message.id}>
            <span className="font-mono text-xs text-zinc-500">
              {message.role === 'user' ? 'User' : 'AI'}
            </span>
            {message.parts.map((part, i) => {
              const key = `${message.id}-${i}`;

              if (part.type === 'text') {
                // 助手回答按 markdown 渲染；用户输入保持纯文本，避免被当成语法解析
                return message.role === 'assistant' ? (
                  <div key={key} className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                  </div>
                ) : (
                  <div key={key} className="whitespace-pre-wrap">
                    {part.text}
                  </div>
                );
              }

              // 工具调用：让"模型查了什么"可见，而不是只看到最后的答案
              if (isToolUIPart(part)) {
                const state =
                  part.state === 'output-available'
                    ? `→ ${JSON.stringify(part.output).slice(0, 120)}`
                    : part.state === 'output-error'
                      ? `✕ ${part.errorText}`
                      : '…';
                return (
                  <div key={key} className="my-1 font-mono text-xs text-zinc-500">
                    {part.state === 'output-available' ? '✓' : '⚙'} {getToolName(part)} {state}
                  </div>
                );
              }

              return null;
            })}
          </div>
        ))}
        {status === 'streaming' && <span className="animate-pulse text-zinc-400">…</span>}
        {error && <div className="text-sm text-red-600">{error.message}</div>}
      </div>

      <form
        className="sticky bottom-0 flex gap-2 bg-white py-2 dark:bg-black"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          className="flex-1 rounded border border-zinc-300 p-2 dark:border-zinc-800 dark:bg-zinc-900"
          value={input}
          placeholder="Say something..."
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        <button
          className="rounded bg-zinc-900 px-4 text-white disabled:opacity-40 dark:bg-white dark:text-black"
          disabled={status === 'streaming' || status === 'submitted'}
        >
          Send
        </button>
      </form>
    </div>
  );
}
