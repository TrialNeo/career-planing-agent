import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { authenticated } from './helpers/auth.js';
let http: ReturnType<typeof request.agent>;
import { createApp, type Application } from '../apps/server/src/app.js';
import { answerInteraction } from '../apps/server/src/workflow/interaction/index.js';
import { toolDefinitions } from '../apps/server/src/workflow/dialogue/tools.js';
let s: Application;
afterEach(async () => {
  await s?.close();
});
const setup = async () => {
  s = createApp({ databasePath: ':memory:', importKnowledge: false, runner: { async run() {} } });
  http = await authenticated(s.app);
};
it('declares every model tool as an object schema supported by Responses', () => {
  for (const tool of toolDefinitions) expect(tool.parameters).toHaveProperty('type', 'object');
});
function goalCard() {
  const c = s.conversation.create();
  const m = s.conversation.addMessage(c.id, 'user', '后端');
  const g = s.learner.proposeGoal({ direction: '后端', reason: '兴趣', evidenceRefs: [m.id] }, [
    m.id,
  ]);
  const r = s.conversation.createRun(c.id);
  s.conversation.setStatus(r.id, 'waiting_input');
  const card = s.conversation.requestInteraction({
    kind: 'goal',
    conversationId: c.id,
    runId: r.id,
    title: '目标',
    summary: '后端',
    targetId: g.id,
    targetVersion: g.revision,
    proposal: g,
  });
  return { c, m, g, r, card };
}
it('plain chat never confirms a proposal and stale target versions cannot be approved', async () => {
  await setup();
  const { c, m, card } = goalCard();
  s.dialogue.send(c.id, { clientRequestId: 'plain', text: '确认，同意' });
  await s.dialogue.close();
  expect(s.learner.state().goal).toBeNull();
  s.learner.proposeGoal({ direction: '前端', reason: '新提案', evidenceRefs: [m.id] }, [m.id]);
  const answer = await http
    .post(`/api/interactions/${card.id}/answer`)
    .send({ clientRequestId: 'answer', kind: 'decision', action: 'confirm' });
  expect(answer.status).toBe(409);
  expect(s.learner.state().goal).toBeNull();
});
it('reuses an already confirmed interaction response and does not start another run', async () => {
  await setup();
  const { card } = goalCard();
  const input = { clientRequestId: 'same-answer', kind: 'decision', action: 'confirm' };
  const first = await http.post(`/api/interactions/${card.id}/answer`).send(input);
  await s.dialogue.close();
  const second = await http.post(`/api/interactions/${card.id}/answer`).send(input);
  expect(second.body).toEqual(first.body);
  expect(s.conversation.runs()).toHaveLength(2);
  expect(
    (await http.post(`/api/interactions/${card.id}/answer`).send({ ...input, action: 'reject' }))
      .status,
  ).toBe(409);
});
it('deduplicates a committed tool write by call ID and rejects conflicting arguments', async () => {
  let observed: any[] = [];
  s = createApp({
    databasePath: ':memory:',
    importKnowledge: false,
    runner: {
      async run(ctx) {
        const m = ctx.messages.at(-1)!;
        const args = {
          changes: [
            {
              field: 'major',
              value: '计算机',
              evidenceRefs: [m.id],
              evidenceType: 'user_statement',
            },
          ],
        };
        observed.push(await ctx.callTool('profile_update', 'call', args));
        observed.push(await ctx.callTool('profile_update', 'call', args));
        try {
          await ctx.callTool('profile_update', 'call', {
            changes: [{ ...args.changes[0], value: '其他' }],
          });
        } catch (e: any) {
          observed.push(e.code);
        }
      },
    },
  });
  const c = s.conversation.create();
  s.dialogue.send(c.id, { clientRequestId: 'tool', text: '计算机' });
  for (let i = 0; i < 100 && !observed.length; i++) await new Promise((r) => setTimeout(r, 2));
  await s.dialogue.close();
  expect(observed[0]).toEqual(observed[1]);
  expect(observed[2]).toBe('TOOL_ID_CONFLICT');
  expect(s.learner.state().profileRevision).toBe(1);
});
it('does not publish rolled-back interaction events to live subscribers', async () => {
  await setup();
  const c = s.conversation.create();
  const r = s.conversation.createRun(c.id);
  let notifications = 0;
  const unsubscribe = s.conversation.hub.subscribe(r.id, () => notifications++);
  expect(() =>
    s.db.transaction(() => {
      s.conversation.requestInteraction({
        kind: 'questions',
        conversationId: c.id,
        runId: r.id,
        title: '问题',
        summary: '测试',
        questions: [{ id: 'q', title: '年级', options: [] }],
      });
      throw Error('rollback');
    }),
  ).toThrow();
  expect(s.conversation.events(r.id)).toHaveLength(0);
  expect(s.conversation.pending(c.id)).toBeNull();
  expect(notifications).toBe(0);
  unsubscribe();
});
it('validates answer ownership and options, limits batches, and blocks cross-origin writes', async () => {
  await setup();
  const { c, r } = goalCard();
  const card = s.conversation.requestInteraction({
    kind: 'questions',
    conversationId: c.id,
    runId: r.id,
    title: '问题',
    summary: '',
    questions: [{ id: 'q', title: '年级', options: [{ id: 'second', label: '大二' }] }],
  });
  expect(() =>
    answerInteraction(s, s.dialogue, card.id, {
      clientRequestId: 'a',
      kind: 'answers',
      answers: [{ questionId: 'q', optionIds: ['foreign'] }],
    }),
  ).toThrow();
  expect(
    (await http.post('/api/conversations').set('Origin', 'https://external.example').send({}))
      .status,
  ).toBe(403);
  expect(
    (await http.post('/api/conversations').set('Content-Type', 'application/json').send('{')).body
      .code,
  ).toBe('INVALID_JSON');
});
