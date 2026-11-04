import { afterEach, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type Application } from '../apps/server/src/app.js';
import { saveReview } from '../apps/server/src/workflow/review/index.js';

let app: Application;
let directory: string | undefined;
afterEach(async () => {
  await app?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
const credentials = (username: string) => ({ username, password: 'test-password-123' });
async function signup(username: string) {
  const agent = request.agent(app.app);
  const response = await agent.post('/api/auth/register').send(credentials(username));
  expect(response.status).toBe(201);
  expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
  return {
    agent,
    user: response.body.user,
    cookie: response.headers['set-cookie'][0].split(';')[0],
  };
}
it('requires a server session for every private API and ignores client-supplied identity', async () => {
  app = createApp({ databasePath: ':memory:', importKnowledge: false });
  const paths = [
    ['get', '/api/conversations'],
    ['post', '/api/conversations'],
    ['get', '/api/conversations/foreign'],
    ['post', '/api/conversations/foreign/messages'],
    ['get', '/api/runs/foreign'],
    ['get', '/api/runs/foreign/events'],
    ['post', '/api/runs/foreign/cancel'],
    ['post', '/api/interactions/foreign/answer'],
    ['get', '/api/settings/model'],
    ['put', '/api/settings/model'],
    ['post', '/api/settings/model/test'],
  ];
  for (const [method, path] of paths) {
    const response = await (request(app.app) as any)[method](path).set('X-User-Id', 'local');
    expect(response.status, path).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  }
  expect((await request(app.app).get('/api/health')).status).toBe(200);
});
it('separates business state while keeping shared model configuration private', async () => {
  app = createApp({ databasePath: ':memory:', importKnowledge: false, runner: { async run() {} } });
  const a = await signup('alice');
  const b = await signup('bob');
  const c = (await a.agent.post('/api/conversations').send({ title: 'Alice private' })).body;
  const scope = app.forUser(a.user.id);
  const msg = scope.conversation.addMessage(c.id, 'user', '计算机专业');
  scope.learner.updateProfile(
    {
      changes: [
        { field: 'major', value: '计算机', evidenceRefs: [msg.id], evidenceType: 'user_statement' },
      ],
    },
    [msg.id],
  );
  const goal = scope.learner.proposeGoal(
    { direction: '后端', reason: '兴趣', evidenceRefs: [msg.id] },
    [msg.id],
  );
  const run = scope.conversation.createRun(c.id);
  scope.conversation.setStatus(run.id, 'waiting_input');
  const card = scope.conversation.requestInteraction({
    kind: 'goal',
    conversationId: c.id,
    runId: run.id,
    title: '目标',
    summary: '后端',
    targetId: goal.id,
    targetVersion: goal.revision,
    proposal: goal,
  });
  expect((await b.agent.get('/api/conversations')).body.items).toEqual([]);
  for (const path of [
    `/api/conversations/${c.id}`,
    `/api/runs/${run.id}`,
    `/api/runs/${run.id}/events`,
  ])
    await b.agent.get(path).expect(404);
  await b.agent
    .post(`/api/conversations/${c.id}/messages`)
    .send({ clientRequestId: 'steal', text: 'hello' })
    .expect(404);
  await b.agent.post(`/api/runs/${run.id}/cancel`).expect(404);
  await b.agent
    .post(`/api/interactions/${card.id}/answer`)
    .send({ clientRequestId: 'steal', kind: 'decision', action: 'confirm' })
    .expect(404);
  expect(scope.learner.state().goal).toBeNull();
  await a.agent
    .post(`/api/interactions/${card.id}/answer`)
    .send({ clientRequestId: 'own', kind: 'decision', action: 'confirm' })
    .expect(200);
  await scope.dialogue.close();
  const plan = scope.planning.saveDraft({
    goalId: goal.id,
    weeklyBudgetMinutes: 240,
    reason: '四小时',
    milestones: [
      {
        id: 'm',
        title: 'API',
        deliverable: '说明',
        criteria: [{ id: 'c', description: '解释路由' }],
      },
    ],
  });
  scope.planning.activate(plan.id, plan.version);
  const task = scope.planning.upsertTask({
    planVersion: plan.version,
    purpose: 'API',
    deliverable: '说明',
    criteria: [{ id: 'c', description: '解释路由' }],
    estimatedMinutes: 60,
  });
  const submission = scope.learning.saveSubmission(
    { taskId: task.id, evidenceMessageIds: [msg.id] },
    task,
    [msg],
  );
  scope.planning.setTaskStatus(task.id, 'pending_review');
  saveReview(scope, {
    submissionId: submission.id,
    criteriaResults: [
      { criterionId: 'c', result: '符合', reason: '内容审阅', evidenceMessageIds: [msg.id] },
    ],
    skillEvidence: [
      { skill: 'API', level: '理解', evidenceMessageIds: [msg.id], basis: 'content_review' },
    ],
    nextAction: '继续',
  });
  const other = app.forUser(b.user.id);
  expect(other.learner.state().profile).toEqual({});
  expect(other.learner.state().goal).toBeNull();
  expect(other.learner.state().skillEvidence).toEqual([]);
  expect(other.planning.plans()).toEqual([]);
  expect(other.planning.tasks()).toEqual([]);
  expect(other.learning.reviews()).toEqual([]);
  expect(() => other.learning.getSubmission(submission.id)).toThrow();
  for (const account of [a, b]) {
    await account.agent.get('/api/settings/model').expect(404);
    await account.agent.put('/api/settings/model').send({ apiKey: 'cannot-write' }).expect(404);
    await account.agent.post('/api/settings/model/test').expect(404);
  }
  expect(scope.settings).toBe(other.settings);
  await b.agent.get('/api/conversations').set('X-Career-Account', a.user.id).expect(401);
  await b.agent.get(`/api/runs/${run.id}/events?account=${a.user.id}`).expect(401);
  expect(scope.knowledge).toBe(other.knowledge);
  expect(other.db).not.toBe(scope.db);
});
it('hashes passwords and session tokens, normalizes names and invalidates sessions on logout', async () => {
  app = createApp({ databasePath: ':memory:', importKnowledge: false });
  const a = await signup('Alice');
  await request(app.app).post('/api/auth/register').send(credentials(' ALICE ')).expect(409);
  await request(app.app)
    .post('/api/auth/login')
    .send({ username: 'alice', password: 'wrong-password' })
    .expect(401);
  const login = request.agent(app.app);
  await login.post('/api/auth/login').send(credentials('alice')).expect(200);
  expect((await login.get('/api/auth/me')).body.user.id).toBe(a.user.id);
  const rows = JSON.stringify(app.db.sql.prepare('SELECT * FROM auth_users').all());
  expect(rows).not.toContain('test-password-123');
  const sessions = JSON.stringify(app.db.sql.prepare('SELECT * FROM auth_sessions').all());
  expect(sessions).not.toContain(a.cookie.split('=')[1]);
  await a.agent.post('/api/auth/logout').expect(200);
  await request(app.app).get('/api/conversations').set('Cookie', a.cookie).expect(401);
  await login.get('/api/conversations').expect(200);
  app.db.sql.prepare('UPDATE auth_sessions SET expires_at=0').run();
  await login.get('/api/conversations').expect(401);
});
it('assigns legacy data only to the first account and persists separate accounts across restarts', async () => {
  directory = mkdtempSync(join(tmpdir(), 'career-users-'));
  const databasePath = join(directory, 'career.sqlite');
  writeFileSync(
    join(directory, 'model.json'),
    JSON.stringify({
      baseUrl: 'https://example.com/v1',
      model: 'shared-model',
      apiKey: 'shared-secret',
    }),
  );
  app = createApp({ databasePath, importKnowledge: false });
  const legacy = app.conversation.create('legacy conversation');
  const a = await signup('owner');
  const b = await signup('newuser');
  expect((await a.agent.get('/api/conversations')).body.items[0].id).toBe(legacy.id);
  expect((await b.agent.get('/api/conversations')).body.items).toEqual([]);
  const own = (await b.agent.post('/api/conversations').send({ title: 'new private' })).body;
  const oldSettingsPath = join(directory, 'users', b.user.id, 'model.json');
  const oldSettings = JSON.stringify({
    baseUrl: 'https://old.example/v1',
    model: 'old-per-user',
    apiKey: 'old-unused-secret',
    revision: 100,
  });
  writeFileSync(oldSettingsPath, oldSettings);
  const pending = app.forUser(b.user.id).conversation.createRun(own.id);
  app.forUser(b.user.id).conversation.setStatus(pending.id, 'running');
  app
    .forUser(b.user.id)
    .conversation.append(pending.id, 'message.delta', { messageId: 'partial', delta: 'only bob' });
  await app.close();
  app = createApp({ databasePath, importKnowledge: false });
  const restored = await request(app.app).get('/api/conversations').set('Cookie', b.cookie);
  expect(restored.body.items.map((c: any) => c.id)).toEqual([own.id]);
  await request(app.app).get(`/api/conversations/${legacy.id}`).set('Cookie', b.cookie).expect(404);
  expect(app.forUser(b.user.id).settings.credentials().model).toBe('shared-model');
  expect(app.forUser(b.user.id).settings).toBe(app.settings);
  expect(readFileSync(oldSettingsPath, 'utf8')).toBe(oldSettings);
  const interrupted = await request(app.app).get(`/api/runs/${pending.id}`).set('Cookie', b.cookie);
  expect(interrupted.body.status).toBe('interrupted');
  await request(app.app).get(`/api/runs/${pending.id}`).set('Cookie', a.cookie).expect(404);
});
it('loads one private config file for all users and applies file edits after restart', async () => {
  directory = mkdtempSync(join(tmpdir(), 'career-shared-model-'));
  const settingsPath = join(directory, 'model.json');
  const databasePath = join(directory, 'career.sqlite');
  const config = {
    baseUrl: 'https://private.example/v1',
    model: 'private-model',
    apiKey: 'shared-token-one',
  };
  writeFileSync(settingsPath, JSON.stringify(config));
  const observed: string[] = [];
  const runner = {
    async run(ctx: any) {
      observed.push(ctx.credentials.apiKey ?? '');
      ctx.emitText('done');
    },
  };
  app = createApp({ databasePath, settingsPath, importKnowledge: false, runner });
  const a = await signup('maintainer');
  const b = await signup('learner');
  for (const account of [a, b]) {
    const c = (await account.agent.post('/api/conversations').send({})).body;
    await account.agent
      .post(`/api/conversations/${c.id}/messages`)
      .send({ clientRequestId: 'same', text: 'hello' })
      .expect(202);
    await app.forUser(account.user.id).dialogue.close();
    for (const path of ['/api/settings/model', '/model.json', '/.local/model.json']) {
      const response = await account.agent.get(path);
      expect(response.text).not.toContain(config.apiKey);
      expect(response.text).not.toContain(config.baseUrl);
      expect(response.text).not.toContain(config.model);
    }
    await account.agent.get('/api/settings/model').expect(404);
    await account.agent
      .put('/api/settings/model')
      .send({ ...config, apiKey: 'attempted-overwrite' })
      .expect(404);
    await account.agent.post('/api/settings/model/test').expect(404);
  }
  expect(observed).toEqual(['shared-token-one', 'shared-token-one']);
  expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(config);
  expect(existsSync(join(directory, 'users', b.user.id, 'model.json'))).toBe(false);
  writeFileSync(settingsPath, JSON.stringify({ ...config, apiKey: 'shared-token-two' }));
  await app.close();
  app = createApp({ databasePath, settingsPath, importKnowledge: false, runner });
  expect(app.forUser(a.user.id).settings.credentials().apiKey).toBe('shared-token-two');
  expect(app.forUser(b.user.id).settings).toBe(app.forUser(a.user.id).settings);
});
it('allows different users to run simultaneously but serializes runs within one account', async () => {
  app = createApp({
    databasePath: ':memory:',
    importKnowledge: false,
    runner: {
      async run(ctx) {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    },
  });
  const a = await signup('first');
  const b = await signup('second');
  for (const { agent } of [a, b]) {
    const c = (await agent.post('/api/conversations').send({})).body;
    const payload = { clientRequestId: 'same-id', text: 'private text' };
    const started = await agent
      .post(`/api/conversations/${c.id}/messages`)
      .send(payload)
      .expect(202);
    const repeat = await agent
      .post(`/api/conversations/${c.id}/messages`)
      .send(payload)
      .expect(202);
    expect(repeat.body).toEqual(started.body);
    await agent
      .post(`/api/conversations/${c.id}/messages`)
      .send({ ...payload, clientRequestId: 'other' })
      .expect(409);
  }
});
