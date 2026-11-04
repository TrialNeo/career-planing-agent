import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let configDirectory: string | undefined;
function fixtureSettings(config: object) {
  configDirectory = mkdtempSync(join(tmpdir(), 'career-pi-config-'));
  const path = join(configDirectory, 'model.json');
  writeFileSync(path, JSON.stringify(config));
  return new Settings(path);
}
import { createServer, type Server } from 'node:http';
import { PiRunner } from '../apps/server/src/platform/agent/index.js';
import { Settings } from '../apps/server/src/module/settings/index.js';
import { testModel } from '../apps/server/src/workflow/dialogue/test-model.js';
import { toolDefinitions } from '../apps/server/src/workflow/dialogue/tools.js';
let server: Server;
afterEach(async () => {
  if (configDirectory) rmSync(configDirectory, { recursive: true, force: true });
  configDirectory = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
async function provider(handler: (body: any, res: express.Response) => void) {
  const app = express();
  app.use(express.json());
  app.post('/v1/responses', (req, res) => handler(req.body, res));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as any).port}/v1`;
}
function stream(res: express.Response, item: any) {
  res.setHeader('Content-Type', 'text/event-stream');
  const send = (type: string, rest: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  send('response.created', { response: { id: 'resp_test', status: 'in_progress', output: [] } });
  send('response.output_item.added', {
    output_index: 0,
    item: { ...item, arguments: item.type === 'function_call' ? '' : undefined },
  });
  if (item.type === 'function_call')
    send('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments });
  else
    send('response.output_text.delta', {
      output_index: 0,
      content_index: 0,
      delta: item.content[0].text,
    });
  send('response.output_item.done', { output_index: 0, item });
  send('response.completed', {
    response: {
      id: 'resp_test',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  });
  res.end();
}
it('uses the actual pi Responses adapter for streaming, a tool and tool-result round trip', async () => {
  const payloads: any[] = [];
  const baseUrl = await provider((body, res) => {
    payloads.push(body);
    const result = body.input.find((i: any) => i.type === 'function_call_output');
    if (!result)
      stream(res, {
        type: 'function_call',
        id: 'fc_probe',
        call_id: 'call_probe',
        name: 'connection_probe',
        arguments: '{}',
        status: 'completed',
      });
    else {
      const token = JSON.parse(result.output).token;
      stream(res, {
        type: 'message',
        id: 'msg_result',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: token, annotations: [] }],
      });
    }
  });
  const settings = fixtureSettings({ baseUrl, model: 'fixture-model', apiKey: 'local-test' });
  const result = await testModel(new PiRunner(), settings);
  expect(result).toMatchObject({ ok: true, checks: [{ ok: true }, { ok: true }, { ok: true }] });
  expect(payloads).toHaveLength(2);
  expect(payloads.every((p) => p.store === false)).toBe(true);
});
it('does not report success when the provider ignores tool-result content', async () => {
  const baseUrl = await provider((_body, res) =>
    stream(res, {
      type: 'message',
      id: 'msg',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'connected', annotations: [] }],
    }),
  );
  const settings = fixtureSettings({ baseUrl, model: 'fixture', apiKey: 'local-test' });
  const result = await testModel(new PiRunner(), settings);
  expect(result.ok).toBe(false);
  expect(result.checks[0].ok).toBe(true);
  expect(result.checks[2].ok).toBe(false);
});
it('passes real career tools to pi and stops after persisting an interaction without another model call', async () => {
  const payloads: any[] = [];
  const input = {
    kind: 'questions',
    title: '了解基础',
    questions: [{ id: 'q', title: '你的年级？', options: [] }],
  };
  const baseUrl = await provider((body, res) => {
    payloads.push(body);
    stream(res, {
      type: 'function_call',
      id: 'fc_card',
      call_id: 'call_card',
      name: 'interaction_request',
      arguments: JSON.stringify(input),
      status: 'completed',
    });
  });
  let waiting = false;
  const calls: unknown[] = [];
  await new PiRunner().run({
    credentials: { baseUrl, model: 'fixture', apiKey: 'local-test' },
    signal: new AbortController().signal,
    systemPrompt: 'Ask one question through interaction_request, then stop.',
    messages: [
      {
        id: 'u',
        conversationId: 'c',
        role: 'user',
        text: '开始',
        createdAt: new Date().toISOString(),
      },
    ],
    tools: toolDefinitions,
    emitText: () => {},
    completeMessage: () => {},
    shouldStop: () => waiting,
    callTool: async (name, callId, args) => {
      calls.push({ name, args });
      waiting = true;
      return { interactionId: 'card', status: 'pending' };
    },
  });
  expect(calls).toEqual([{ name: 'interaction_request', args: input }]);
  expect(payloads).toHaveLength(1);
  expect(payloads[0].tools.every((t: any) => t.parameters.type === 'object')).toBe(true);
});
