import { test, expect } from '@playwright/test';
test('explores, confirms goal and plan, acts, submits, reviews and restores actual persisted state', async ({
  page,
}) => {
  const request = page.request;
  await request.post('/api/auth/register', {
    data: { username: `loop-${Date.now()}`, password: 'test-password-123' },
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: '输入消息' }).fill('我想学后端，每周只有四小时');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('确认职业目标', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认目标', exact: true }).click();
  await expect(page.getByText('实现第一个 HTTP API', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认计划', exact: true }).click();
  await expect(page.getByText(/本周行动已保存/)).toBeVisible();
  await page
    .getByRole('textbox', { name: '输入消息' })
    .fill('成果：GET /hello 的路由处理请求，返回 JSON；实际用时45分钟。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText(/成果已登记，内容审阅符合标准/)).toBeVisible();
  const list = await (await request.get('/api/conversations')).json();
  const before = await (await request.get(`/api/conversations/${list.items[0].id}`)).json();
  expect(before.interactions.map((i: any) => i.status)).toEqual(['confirmed', 'confirmed']);
  expect(before.messages.filter((m: any) => m.role === 'assistant')).toHaveLength(4);
  await page.reload();
  await expect(page.getByText(/成果已登记，内容审阅符合标准/)).toBeVisible();
  const after = await (await request.get(`/api/conversations/${list.items[0].id}`)).json();
  expect(after.messages).toEqual(before.messages);
  await page.getByRole('button', { name: '新建对话', exact: false }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('继续我的计划');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.getByText('已恢复长期计划与学习记录，可以继续行动。', { exact: true }),
  ).toBeVisible();
});
