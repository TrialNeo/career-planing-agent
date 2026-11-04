import { test, expect, type Page } from '@playwright/test';

const conversation = {
  id: 'conversation-ui',
  title: '测试职业探索',
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
};
const run = {
  id: 'run-ui',
  conversationId: conversation.id,
  status: 'running',
  lastSequence: 0,
  createdAt: conversation.createdAt,
};
const detail = (extra: Record<string, unknown> = {}) => ({
  conversation,
  messages: [],
  nextCursor: null,
  pendingInteraction: null,
  activeRun: null,
  interactions: [],
  ...extra,
});
async function mockBase(page: Page, current: () => unknown = () => detail()) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me')
      return route.fulfill({
        json: {
          user: { id: 'account-ui', username: 'test-user', createdAt: conversation.createdAt },
          firstAccount: false,
        },
      });
    if (url.pathname === '/api/conversations' && route.request().method() === 'GET')
      return route.fulfill({ json: { items: [conversation], nextCursor: null } });
    if (url.pathname === `/api/conversations/${conversation.id}`)
      return route.fulfill({ json: current() });
    return route.fulfill({
      status: 404,
      json: { message: 'Unexpected API request', code: 'NOT_FOUND', retryable: false },
    });
  });
  await page.addInitScript(
    (id) => localStorage.setItem('career.account-ui.selectedConversation', id),
    conversation.id,
  );
}

test('streams a reply once, renders markdown and sources, and restores history', async ({
  page,
}) => {
  let complete = false;
  const user = {
    id: 'user-ui',
    conversationId: conversation.id,
    role: 'user',
    text: '你好',
    createdAt: conversation.createdAt,
  };
  const assistant = {
    id: 'assistant-ui',
    conversationId: conversation.id,
    role: 'assistant',
    text: '你好，**一起探索**。\n\n```js\nconsole.log("career");\n```\n\n[岗位资料](https://example.com/jobs)',
    createdAt: conversation.createdAt,
    sources: [
      {
        datasetVersion: 'test-v1',
        sheet: '岗位需求',
        row: 2,
        source: '岗位原始来源',
        url: 'https://example.com/source',
        collectedAt: null,
      },
    ],
  };
  await mockBase(page, () => detail({ messages: complete ? [user, assistant] : [] }));
  await page.route(`**/api/conversations/${conversation.id}/messages`, (route) =>
    route.fulfill({ status: 202, json: { messageId: user.id, runId: run.id } }),
  );
  await page.route(`**/api/runs/${run.id}/events?*`, async (route) => {
    complete = true;
    const events = [
      { type: 'run.started', sequence: 1, data: { runId: run.id } },
      { type: 'message.delta', sequence: 2, data: { messageId: assistant.id, delta: '你好，' } },
      { type: 'message.delta', sequence: 2, data: { messageId: assistant.id, delta: '重复内容' } },
      { type: 'message.completed', sequence: 3, data: { message: assistant } },
      { type: 'run.finished', sequence: 4, data: { status: 'completed' } },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map(
          (e) =>
            `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, runId: run.id, timestamp: conversation.createdAt })}\n\n`,
        )
        .join(''),
    });
  });
  await page.route(`**/api/runs/${run.id}`, (route) =>
    route.fulfill({ json: { ...run, status: 'completed' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '下一步，走向更适合你的方向。' })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('你好');
  await page.getByRole('textbox', { name: '输入消息' }).press('Enter');
  await expect(page.getByText('一起探索', { exact: true })).toBeVisible();
  await expect(page.getByText('重复内容')).toHaveCount(0);
  await expect(page.locator('pre code')).toContainText('console.log');
  await expect(page.getByRole('link', { name: '岗位资料' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await page.getByText('参考来源 · 1').click();
  await expect(page.getByRole('link', { name: '岗位原始来源' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('一起探索', { exact: true })).toBeVisible();
});

for (const failure of ['network', 'truncated-json', 'null-json'] as const) {
  test(`retries an ambiguous send with the same request ID after ${failure}`, async ({ page }) => {
    const requests: { clientRequestId: string; text: string }[] = [];
    await mockBase(page);
    await page.route(`**/api/conversations/${conversation.id}/messages`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        if (failure === 'network') return route.abort('connectionreset');
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: failure === 'null-json' ? 'null' : '{"messageId":',
        });
      }
      return route.fulfill({ status: 202, json: { messageId: 'retry-user', runId: run.id } });
    });
    await page.route(`**/api/runs/${run.id}/events?*`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `id: 1\nevent: run.finished\ndata: ${JSON.stringify({ type: 'run.finished', runId: run.id, sequence: 1, timestamp: conversation.createdAt, data: { status: 'completed' } })}\n\n`,
      }),
    );
    await page.goto('/');
    await page.getByRole('textbox', { name: '输入消息' }).fill('我要探索职业方向');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('alert')).toContainText(
      failure === 'network' ? '暂时无法连接服务' : '响应',
    );
    await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('我要探索职业方向');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
  });
}

test('renders overdue task reminders in readable Chinese', async ({ page }) => {
  await mockBase(page, () =>
    detail({ reminders: [{ purpose: '完成接口文档' }, { purpose: '补充设计说明' }] }),
  );
  await page.goto('/');
  const reminder = page.getByRole('complementary', { name: '学习任务提醒' });
  await expect(reminder).toContainText(
    '以下任务已到期：完成接口文档、补充设计说明。可以在对话中调整安排或提交成果。',
  );
});

test('question cards accept options and free text, then send a structured answer', async ({
  page,
}) => {
  let body: any;
  const interaction = {
    id: 'questions-ui',
    conversationId: conversation.id,
    runId: run.id,
    status: 'pending',
    kind: 'questions',
    title: '先了解一下你',
    summary: '这些信息能帮助我给出更具体的建议。',
    createdAt: conversation.createdAt,
    questions: [
      {
        id: 'grade',
        title: '你现在的年级？',
        options: [
          { id: 'year2', label: '大二' },
          { id: 'year3', label: '大三' },
        ],
      },
      {
        id: 'interests',
        title: '你感兴趣的方向？',
        multiple: true,
        options: [
          { id: 'web', label: '前端开发' },
          { id: 'data', label: '数据分析' },
        ],
      },
    ],
  };
  await mockBase(page, () =>
    detail({
      pendingInteraction: body ? null : interaction,
      activeRun: body ? null : { ...run, status: 'waiting_input' },
    }),
  );
  await page.route('**/api/interactions/questions-ui/answer', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      json: { interactionId: interaction.id, status: 'answered', runId: run.id },
    });
  });
  await page.route(`**/api/runs/${run.id}/events?*`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 1\nevent: run.finished\ndata: ${JSON.stringify({ type: 'run.finished', runId: run.id, sequence: 1, timestamp: conversation.createdAt, data: { status: 'completed' } })}\n\n`,
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: '提交回答' })).toBeDisabled();
  await page.getByRole('radio', { name: '大二' }).check();
  await page.getByRole('checkbox', { name: '前端开发' }).check();
  await page.getByRole('checkbox', { name: '数据分析' }).check();
  await page.getByRole('textbox', { name: '你感兴趣的方向？：补充回答' }).fill('也想了解产品设计');
  await page.getByRole('button', { name: '提交回答' }).click();
  await expect.poll(() => body?.kind).toBe('answers');
  expect(body.answers).toEqual([
    { questionId: 'grade', optionIds: ['year2'], text: '' },
    { questionId: 'interests', optionIds: ['web', 'data'], text: '也想了解产品设计' },
  ]);
});

test('plan cards show deliverables, acceptance criteria, weekly budget and decision comments', async ({
  page,
}) => {
  let body: any;
  const interaction = {
    id: 'plan-ui',
    conversationId: conversation.id,
    runId: run.id,
    status: 'pending',
    kind: 'plan',
    title: '确认学习计划',
    summary: '从一个可展示的小项目开始',
    createdAt: conversation.createdAt,
    proposal: {
      id: 'plan-1',
      goalId: 'goal-1',
      version: 1,
      status: 'draft',
      weeklyBudgetMinutes: 180,
      reason: '与课程安排相容',
      milestones: [
        {
          id: 'm1',
          title: '完成作品原型',
          deliverable: '一个可运行的网页',
          criteria: [{ id: 'c1', description: '支持键盘操作和手机浏览' }],
        },
      ],
    },
  };
  await mockBase(page, () => detail({ pendingInteraction: body ? null : interaction }));
  await page.route('**/api/interactions/plan-ui/answer', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      json: { interactionId: interaction.id, status: 'changes_requested', runId: run.id },
    });
  });
  await page.route(`**/api/runs/${run.id}/events?*`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 1\nevent: run.finished\ndata: ${JSON.stringify({ type: 'run.finished', runId: run.id, sequence: 1, timestamp: conversation.createdAt, data: { status: 'completed' } })}\n\n`,
    }),
  );
  await page.goto('/');
  await expect(page.getByText('180 分钟')).toBeVisible();
  await expect(page.getByText('交付物：一个可运行的网页')).toBeVisible();
  await expect(page.getByText('支持键盘操作和手机浏览')).toBeVisible();
  await page.getByRole('textbox', { name: '你的意见（可选）' }).fill('每周改为 120 分钟');
  await page.getByRole('button', { name: '提出修改' }).click();
  await expect.poll(() => body?.action).toBe('request_changes');
  expect(body.comment).toBe('每周改为 120 分钟');
});

test('never displays or requests model configuration in the chat UI', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/settings/')) requested.push(req.url());
  });
  await mockBase(page);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '\u8f93\u5165\u6d88\u606f' })).toBeVisible();
  await expect(page.getByRole('button', { name: /\u6a21\u578b\u8bbe\u7f6e/ })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('.settings-modal')).toHaveCount(0);
  expect(requested).toEqual([]);
});

test('mobile sidebar is accessible without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBase(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.getByRole('button', { name: /测试职业探索/ })).toBeVisible();
  await page.getByRole('button', { name: /测试职业探索/ }).click();
  await expect(page.getByRole('button', { name: '关闭会话列表' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('restores an active run from history and can stop it without sending another message', async ({
  page,
}) => {
  let cancelled = false;
  let sends = 0;
  let cancels = 0;
  const user = {
    id: 'restore-user',
    conversationId: conversation.id,
    role: 'user',
    text: '继续规划',
    createdAt: conversation.createdAt,
  };
  await mockBase(page, () => detail({ messages: [user], activeRun: cancelled ? null : run }));
  await page.route(`**/api/conversations/${conversation.id}/messages`, (route) => {
    sends++;
    return route.fulfill({ status: 500 });
  });
  await page.route(`**/api/runs/${run.id}`, (route) =>
    route.fulfill({ json: { ...run, status: cancelled ? 'cancelled' : 'running' } }),
  );
  await page.route(`**/api/runs/${run.id}/cancel`, (route) => {
    cancelled = true;
    cancels++;
    return route.fulfill({ json: { runId: run.id, status: 'cancelling' } });
  });
  await page.route(`**/api/runs/${run.id}/events?*`, (route) => {
    const event = cancelled
      ? { type: 'run.finished', sequence: 2, data: { status: 'cancelled' } }
      : { type: 'run.started', sequence: 1, data: { runId: run.id } };
    return route.fulfill({
      contentType: 'text/event-stream',
      body: `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, runId: run.id, timestamp: conversation.createdAt })}\n\n`,
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect.poll(() => cancels).toBe(1);
  await expect(page.getByRole('button', { name: '停止生成' })).toBeDisabled();
  expect(sends).toBe(0);
});

test('restores the next pending card when an interaction continuation already finished', async ({
  page,
}) => {
  let answered = false;
  let streamRequests = 0;
  const goal = {
    id: 'goal-immediate',
    conversationId: conversation.id,
    runId: 'old-goal-run',
    status: 'pending',
    kind: 'goal',
    title: '确认职业目标',
    summary: '前端开发方向',
    createdAt: conversation.createdAt,
    proposal: {
      id: 'goal-1',
      direction: '前端开发',
      reason: '结合你的兴趣与项目经历',
      evidenceRefs: ['internal-message-uuid'],
      status: 'draft',
      revision: 1,
    },
  };
  const plan = {
    id: 'plan-immediate',
    conversationId: conversation.id,
    runId: 'new-plan-run',
    status: 'pending',
    kind: 'plan',
    title: '确认下一步计划',
    summary: '先完成一个可展示项目',
    createdAt: conversation.createdAt,
    proposal: {
      id: 'plan-1',
      goalId: 'goal-1',
      version: 1,
      status: 'draft',
      weeklyBudgetMinutes: 120,
      reason: '每周稳步推进',
      milestones: [
        {
          id: 'm1',
          title: '项目原型',
          deliverable: '可运行网页',
          criteria: [{ id: 'c1', description: '包含输入与结果展示' }],
        },
      ],
    },
  };
  await mockBase(page, () =>
    detail({
      pendingInteraction: answered ? plan : goal,
      activeRun: { ...run, id: answered ? plan.runId : goal.runId, status: 'waiting_input' },
    }),
  );
  await page.route('**/api/interactions/goal-immediate/answer', (route) => {
    answered = true;
    return route.fulfill({
      json: { interactionId: goal.id, status: 'confirmed', runId: plan.runId },
    });
  });
  await page.route('**/api/runs/*/events?*', (route) => {
    streamRequests++;
    return route.fulfill({ contentType: 'text/event-stream', body: '' });
  });
  await page.goto('/');
  await expect(page.getByText('依据本次对话提出')).toBeVisible();
  await expect(page.getByText('internal-message-uuid')).toHaveCount(0);
  await page.getByRole('button', { name: '确认目标' }).click();
  await expect(page.getByRole('heading', { name: '确认下一步计划' })).toBeVisible();
  await expect(page.getByText('120 分钟')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认计划' })).toBeEnabled();
  expect(streamRequests).toBe(0);
});
