import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Application } from '../apps/server/src/app.js';
import { openDatabase } from '../apps/server/src/platform/database/index.js';
import { Conversation } from '../apps/server/src/module/conversation/index.js';
let instance: Application;
let server: Server;
let directory: string;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await instance?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it('delivers the final persisted event on a live SSE connection before closing', async () => {
  let release!: () => void;
  instance = createApp({
    databasePath: ':memory:',
    importKnowledge: false,
    runner: {
      async run(ctx) {
        await new Promise<void>((r) => (release = r));
        ctx.emitText('live');
      },
    },
  });
  server = createServer(instance.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'stream-user', password: 'test-password-123' }),
  });
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  const c = instance.conversation.create();
  const run = instance.dialogue.send(c.id, { clientRequestId: 'one', text: 'hi' });
  const response = await fetch(`${base}/api/runs/${run.runId}/events`, {
    headers: { Cookie: cookie },
  });
  release();
  const content = await response.text();
  expect(content).toContain('event: run.finished');
  expect(content).toContain('"status":"completed"');
});
it('marks unfinished disk runs interrupted and recovers partial assistant text on restart', () => {
  directory = mkdtempSync(join(tmpdir(), 'career-restart-'));
  const path = join(directory, 'test.sqlite');
  const db = openDatabase(path);
  const conversation = new Conversation(db);
  const c = conversation.create();
  const r = conversation.createRun(c.id);
  conversation.setStatus(r.id, 'running');
  conversation.append(r.id, 'message.delta', { messageId: 'partial', delta: '保存了一半' });
  db.close();
  instance = createApp({ databasePath: path, importKnowledge: false });
  expect(instance.conversation.getRun(r.id).status).toBe('interrupted');
  expect(instance.conversation.messages(c.id)[0].text).toBe('保存了一半');
  expect(instance.conversation.events(r.id).at(-1)?.type).toBe('run.finished');
  expect(instance.conversation.detail(c.id).activeRun?.status).toBe('interrupted');
});
it('closes an open event stream on logout and refuses replay with the revoked session', async () => {
  let release!: () => void;
  instance = createApp({
    databasePath: ':memory:',
    importKnowledge: false,
    runner: {
      async run(ctx) {
        await new Promise<void>((resolve) => {
          release = resolve;
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        ctx.emitText('after logout');
      },
    },
  });
  server = createServer(instance.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'logout-user', password: 'test-password-123' }),
  });
  const cookie = registered.headers.get('set-cookie')!.split(';')[0];
  const c = instance.conversation.create();
  const run = instance.dialogue.send(c.id, { clientRequestId: 'logout-stream', text: 'hi' });
  const stream = await fetch(`${base}/api/runs/${run.runId}/events`, {
    headers: { Cookie: cookie },
  });
  expect(stream.status).toBe(200);
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const content = await stream.text();
  expect(content).toContain('run.started');
  expect(content).not.toContain('after logout');
  release();
  const replay = await fetch(`${base}/api/runs/${run.runId}/events`, {
    headers: { Cookie: cookie },
  });
  expect(replay.status).toBe(401);
});
it('rolls back review, evidence and task state together on downstream failure', async () => {
  instance = createApp({
    databasePath: ':memory:',
    importKnowledge: false,
    runner: { async run() {} },
  });
  const { saveReview } = await import('../apps/server/src/workflow/review/index.js');
  const c = instance.conversation.create();
  const m = instance.conversation.addMessage(c.id, 'user', '成果');
  const goal = instance.learner.proposeGoal(
    { direction: '后端', reason: '兴趣', evidenceRefs: [m.id] },
    [m.id],
  );
  instance.learner.confirmGoal(goal.id);
  const p = instance.planning.saveDraft({
    goalId: goal.id,
    milestones: [
      { id: 'm', title: 'API', deliverable: '代码', criteria: [{ id: 'c', description: '解释' }] },
    ],
    weeklyBudgetMinutes: 240,
    reason: '时间',
  });
  instance.planning.activate(p.id, p.version);
  const t = instance.planning.upsertTask({
    planVersion: 1,
    purpose: 'API',
    deliverable: '代码',
    criteria: [{ id: 'c', description: '解释' }],
    estimatedMinutes: 60,
  });
  const sub = instance.learning.saveSubmission({ taskId: t.id, evidenceMessageIds: [m.id] }, t, [
    m,
  ]);
  instance.planning.setTaskStatus(t.id, 'pending_review');
  instance.db.sql.exec(
    "CREATE TRIGGER reject_evidence BEFORE INSERT ON entities WHEN NEW.kind='skill_evidence' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;",
  );
  expect(() =>
    saveReview(instance, {
      submissionId: sub.id,
      criteriaResults: [
        { criterionId: 'c', result: '符合', reason: '内容完整', evidenceMessageIds: [m.id] },
      ],
      skillEvidence: [
        { skill: 'API', level: '能解释', evidenceMessageIds: [m.id], basis: 'content_review' },
      ],
      nextAction: '继续',
    }),
  ).toThrow('injected write failure');
  expect(instance.learning.reviews()).toHaveLength(0);
  expect(instance.learner.state().skillEvidence).toHaveLength(0);
  expect(instance.planning.getTask(t.id).status).toBe('pending_review');
});
