import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authenticated } from './helpers/auth.js';
let http: ReturnType<typeof request.agent>;
import { createApp, type Application } from '../apps/server/src/app.js';
import type { AgentRunner } from '../apps/server/src/platform/agent/index.js';
let instance: Application;
afterEach(async () => {
  await instance?.close();
});
const app = async (runner?: AgentRunner) => {
  instance = createApp({ databasePath: ':memory:', runner, importKnowledge: false });
  http = await authenticated(instance.app);
  return instance;
};
const wait = async (id: string) => {
  for (let n = 0; n < 100; n++) {
    const r = instance.conversation.getRun(id);
    if (!['queued', 'running', 'cancelling'].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('run timeout');
};
const scripted = (fn: AgentRunner['run']): AgentRunner => ({ run: fn });
describe('local HTTP and durable runs', () => {
  it('validates requests and never exposes API keys', async () => {
    await app();
    expect((await http.get('/api/health')).body.databaseReady).toBe(true);
    expect((await http.post('/api/conversations').send({ title: 42 })).status).toBe(400);
    await http.get('/api/settings/model').expect(404);
    await http.put('/api/settings/model').send({ apiKey: 'cannot-set-from-browser' }).expect(404);
    await http.post('/api/settings/model/test').expect(404);
  });
  it('deduplicates message requests, serializes runs and replays persisted SSE without rerunning tools', async () => {
    let release!: () => void;
    let executions = 0;
    await app(
      scripted(async (ctx) => {
        executions++;
        await new Promise<void>((r) => (release = r));
        ctx.emitText('回复');
      }),
    );
    const conversation = (await http.post('/api/conversations').send({})).body;
    const first = await http
      .post(`/api/conversations/${conversation.id}/messages`)
      .send({ clientRequestId: 'same', text: '你好' });
    expect(first.status).toBe(202);
    const duplicate = await http
      .post(`/api/conversations/${conversation.id}/messages`)
      .send({ clientRequestId: 'same', text: '你好' });
    expect(duplicate.body).toEqual(first.body);
    expect(
      (
        await http
          .post(`/api/conversations/${conversation.id}/messages`)
          .send({ clientRequestId: 'same', text: 'changed' })
      ).status,
    ).toBe(409);
    expect(
      (
        await http
          .post(`/api/conversations/${conversation.id}/messages`)
          .send({ clientRequestId: 'other', text: 'another' })
      ).status,
    ).toBe(409);
    release();
    await wait(first.body.runId);
    const events = await http.get(`/api/runs/${first.body.runId}/events?after=1`);
    expect(events.text).toContain('message.completed');
    expect(events.text).not.toContain('event: run.started');
    expect(executions).toBe(1);
  });
  it('requires version-bound card confirmation, then completes submission and review atomically', async () => {
    let phase = 0;
    let taskId = '';
    await app(
      scripted(async (ctx) => {
        const m = ctx.messages.filter((m) => m.role === 'user').at(-1)!;
        if (phase++ === 0) {
          const goal: any = await ctx.callTool('goal_propose', 'g', {
            direction: '后端',
            reason: '用户希望',
            evidenceRefs: [m.id],
          });
          await ctx.callTool('interaction_request', 'card', {
            kind: 'goal',
            goalProposalId: goal.goalProposalId,
          });
        } else if (phase === 2) {
          const goal = instance.learner.state().goal!;
          const plan: any = await ctx.callTool('plan_save', 'p', {
            goalId: goal.id,
            milestones: [
              {
                id: 'm',
                title: '基础',
                deliverable: 'API',
                criteria: [{ id: 'c', description: '解释实现' }],
              },
            ],
            weeklyBudgetMinutes: 240,
            reason: '四小时',
          });
          await ctx.callTool('interaction_request', 'pc', {
            kind: 'plan',
            planId: plan.planId,
            version: plan.version,
          });
        } else if (phase === 3) {
          const t: any = await ctx.callTool('task_upsert', 't', {
            planVersion: 1,
            purpose: '理解API',
            deliverable: '说明与代码',
            criteria: [{ id: 'c', description: '解释实现' }],
            estimatedMinutes: 60,
          });
          taskId = t.taskId;
        } else {
          const sub: any = await ctx.callTool('submission_save', 's', {
            taskId,
            evidenceMessageIds: [m.id],
            actualMinutes: 45,
          });
          await ctx.callTool('review_save', 'r', {
            submissionId: sub.submissionId,
            criteriaResults: [
              {
                criterionId: 'c',
                result: '符合',
                reason: '内容说明完整，未执行代码',
                evidenceMessageIds: [m.id],
              },
            ],
            skillEvidence: [
              {
                skill: 'API',
                level: '能解释',
                evidenceMessageIds: [m.id],
                basis: 'content_review',
              },
            ],
            nextAction: '下一项',
          });
        }
        ctx.emitText('已处理');
      }),
    );
    const c = (await http.post('/api/conversations').send({})).body;
    const run = (
      await http
        .post(`/api/conversations/${c.id}/messages`)
        .send({ clientRequestId: 'm', text: '我想学后端，每周4小时' })
    ).body;
    expect((await wait(run.runId)).status).toBe('waiting_input');
    const card = instance.conversation.detail(c.id).pendingInteraction!;
    expect(instance.learner.state().goal).toBeNull();
    const answer = await http
      .post(`/api/interactions/${card.id}/answer`)
      .send({ clientRequestId: 'a', kind: 'decision', action: 'confirm' });
    expect(answer.status).toBe(200);
    await wait(answer.body.runId);
    expect(instance.learner.state().goal?.direction).toBe('后端');
    const planCard = instance.conversation.detail(c.id).pendingInteraction!;
    const confirmed = await http
      .post(`/api/interactions/${planCard.id}/answer`)
      .send({ clientRequestId: 'b', kind: 'decision', action: 'confirm' });
    await wait(confirmed.body.runId);
    expect(instance.planning.getTask(taskId).status).toBe('planned');
    const sub = (
      await http.post(`/api/conversations/${c.id}/messages`).send({
        clientRequestId: 'submit',
        text: '我的实现：GET /hello 返回 JSON，通过路由处理请求。',
      })
    ).body;
    await wait(sub.runId);
    expect(instance.planning.getTask(taskId).status).toBe('completed');
    expect(instance.learning.reviews()).toHaveLength(1);
    expect(instance.learner.state().skillEvidence).toHaveLength(1);
  });
  it('keeps successful writes when generation is cancelled and rejects subsequent writes', async () => {
    let done!: () => void;
    let error: any;
    await app(
      scripted(async (ctx) => {
        const m = ctx.messages.filter((m) => m.role === 'user').at(-1)!;
        await ctx.callTool('profile_update', 'first', {
          changes: [
            {
              field: 'major',
              value: '计算机',
              evidenceRefs: [m.id],
              evidenceType: 'user_statement',
            },
          ],
        });
        await new Promise<void>((r) => {
          done = r;
          ctx.signal.addEventListener('abort', () => r(), { once: true });
        });
        try {
          await ctx.callTool('profile_update', 'second', {
            changes: [
              { field: 'grade', value: '二', evidenceRefs: [m.id], evidenceType: 'user_statement' },
            ],
          });
        } catch (e) {
          error = e;
        }
      }),
    );
    const c = (await http.post('/api/conversations').send({})).body;
    const r = (
      await http
        .post(`/api/conversations/${c.id}/messages`)
        .send({ clientRequestId: 'x', text: '计算机' })
    ).body;
    await http.post(`/api/runs/${r.runId}/cancel`);
    done?.();
    expect((await wait(r.runId)).status).toBe('cancelled');
    expect(instance.learner.state().profile.major.value).toBe('计算机');
    expect(instance.learner.state().profile.grade).toBeUndefined();
    expect(error).toBeDefined();
  });
});
