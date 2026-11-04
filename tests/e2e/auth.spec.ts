import { test, expect, type Page } from '@playwright/test';
async function register(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).click();
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('browser-password-123');
  await page.getByLabel('确认密码', { exact: true }).fill('browser-password-123');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeVisible();
}
test('registers, logs out, switches accounts and restores only the owning account history', async ({
  page,
}) => {
  const first = `owner-${Date.now()}`;
  const second = `other-${Date.now()}`;
  await register(page, first);
  await page.getByRole('textbox', { name: '输入消息' }).fill('我的私人后端探索');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('确认职业目标', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByText('我的私人后端探索', { exact: true })).toHaveCount(0);
  await register(page, second);
  await expect(page.getByText('你的探索会保存在这里。')).toBeVisible();
  await expect(page.getByText('确认职业目标', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('账号', { exact: true }).fill(first);
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账号或密码不正确');
  await page.getByLabel('密码', { exact: true }).fill('browser-password-123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('确认职业目标', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('确认职业目标', { exact: true })).toBeVisible();
});
test('clears other tabs when the shared browser session logs out or changes account', async ({
  page,
  context,
}) => {
  await register(page, `tabs-${Date.now()}`);
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(otherTab.getByRole('textbox', { name: '输入消息' })).toBeVisible();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(otherTab.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(otherTab.getByRole('textbox', { name: '输入消息' })).toHaveCount(0);
});
test('does not horizontally overflow the mobile login form', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '注册新账号', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
