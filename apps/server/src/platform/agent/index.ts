import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Message as PiMessage, Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import type { Message } from '@career/contracts';
import { AppError, publicError } from '../http/errors.js';
export type ToolDefinition = { name: string; description: string; parameters: object };
export type AgentContext = {
  messages: Message[];
  systemPrompt: string;
  tools: ToolDefinition[];
  signal: AbortSignal;
  credentials: { baseUrl: string; model: string; apiKey?: string };
  emitText: (delta: string) => void;
  completeMessage: () => void;
  callTool: (name: string, callId: string, args: unknown) => Promise<unknown>;
  shouldStop: () => boolean;
};
export interface AgentRunner {
  run(context: AgentContext): Promise<void>;
}
export class PiRunner implements AgentRunner {
  async run(ctx: AgentContext) {
    if (!ctx.credentials.model || !ctx.credentials.apiKey)
      throw new AppError('MODEL_NOT_CONFIGURED', '模型服务暂不可用，请联系服务维护者。');
    const model: Model<'openai-responses'> = {
      id: ctx.credentials.model,
      name: ctx.credentials.model,
      api: 'openai-responses',
      provider: 'career-local',
      baseUrl: ctx.credentials.baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 8192,
    };
    const tools: AgentTool[] = ctx.tools.map((tool) => ({
      ...tool,
      label: tool.description,
      execute: async (callId, args) => {
        try {
          const result = await ctx.callTool(tool.name, callId, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: result,
          };
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(publicError(e)) }],
            isError: true,
            details: undefined,
          };
        }
      },
    }));
    let turns = 0;
    const agent = new Agent({
      initialState: { systemPrompt: ctx.systemPrompt, model, tools, thinkingLevel: 'off' },
      streamFn: (m, c, options) =>
        streamSimple(m as Model<'openai-responses'>, c, {
          ...options,
          apiKey: ctx.credentials.apiKey,
          timeoutMs: 90000,
          maxRetries: 0,
          transport: 'sse',
          onPayload: (payload: any) => ({ ...payload, store: false }),
        }),
      toolExecution: 'sequential',
      beforeToolCall: async () =>
        ctx.signal.aborted || ctx.shouldStop()
          ? { block: true, reason: '运行已停止或正在等待用户回答。', terminate: true }
          : undefined,
      finishTurn: () => {
        turns++;
        return ctx.shouldStop() || turns >= 20 ? { action: 'end' } : undefined;
      },
    });
    agent.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
        ctx.emitText(event.assistantMessageEvent.delta);
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        ctx.completeMessage();
        const msg = event.message;
        if (msg.stopReason === 'error')
          throw new AppError(
            'MODEL_REQUEST_FAILED',
            '模型请求失败，请检查服务地址、模型权限和 Responses 兼容性。',
            502,
            true,
          );
      }
    });
    const abort = () => agent.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      if (ctx.signal.aborted) throw new AppError('CANCELLED', '运行已停止。');
      // Message IDs accompany content so the model can cite actual user evidence.
      const messages: PiMessage[] = ctx.messages.map((m) =>
        m.role === 'assistant'
          ? {
              role: 'assistant',
              content: [{ type: 'text', text: m.text }],
              api: 'openai-responses',
              provider: 'career-local',
              model: ctx.credentials.model,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'stop',
              timestamp: Date.parse(m.createdAt),
            }
          : {
              role: 'user',
              content: `[messageId=${m.id}; role=${m.role}]\n${m.text}`,
              timestamp: Date.parse(m.createdAt),
            },
      );
      await agent.prompt(messages);
      if (agent.state.errorMessage)
        throw new AppError('MODEL_REQUEST_FAILED', '模型请求未完成，请检查配置后重试。', 502, true);
      if (turns >= 20 && !ctx.shouldStop())
        throw new AppError('TURN_LIMIT', '本次对话已达到工具轮次上限，请继续发送消息。', 422, true);
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  }
}
