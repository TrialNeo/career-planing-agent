import { randomUUID } from 'node:crypto';
import type { ModelTest } from '@career/contracts';
import type { AgentRunner } from '../../platform/agent/index.js';
import type { Settings } from '../../module/settings/index.js';
import { publicError } from '../../platform/http/errors.js';
export async function testModel(runner: AgentRunner, settings: Settings): Promise<ModelTest> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const token = `probe_${randomUUID().replaceAll('-', '')}`;
  let output = '';
  let called = false;
  const checks = [
    { name: 'textStream', ok: false },
    { name: 'toolCall', ok: false },
    { name: 'toolResultRoundTrip', ok: false },
  ];
  try {
    await runner.run({
      credentials: settings.credentials(),
      signal: controller.signal,
      messages: [
        {
          id: 'probe',
          conversationId: 'probe',
          role: 'user',
          text: 'Call connection_probe once with no arguments. Then output the exact returned token in a text reply. Do not invent a token.',
          createdAt: new Date().toISOString(),
        },
      ],
      systemPrompt:
        'You are testing Responses streaming, tool calls and tool-result round trips. Follow the user request.',
      tools: [
        {
          name: 'connection_probe',
          description: 'Returns the secret test token. Call once.',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ],
      emitText: (delta) => {
        output += delta;
        checks[0].ok = true;
      },
      completeMessage: () => {},
      shouldStop: () => false,
      callTool: async (name) => {
        if (name !== 'connection_probe') throw Error('Unexpected tool');
        called = true;
        return { token };
      },
    });
    checks[1].ok = called;
    checks[2].ok = called && output.includes(token);
    return {
      ok: checks.every((c) => c.ok),
      checks,
      latencyMs: Date.now() - start,
      ...(!checks.every((c) => c.ok)
        ? {
            error: {
              code: 'MODEL_CAPABILITY_MISSING',
              message: '服务未完成文本流、工具调用及结果回传的全部检查。',
              retryable: false,
            },
          }
        : {}),
    };
  } catch (e) {
    checks[1].ok = called;
    return { ok: false, checks, latencyMs: Date.now() - start, error: publicError(e) };
  } finally {
    clearTimeout(timeout);
  }
}
