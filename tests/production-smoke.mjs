import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

const start = () =>
  spawn(process.execPath, ['dist/apps/server/src/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3001' },
  });
const service = start();
let output = '';
service.stdout.on('data', (chunk) => {
  output += chunk;
});
service.stderr.on('data', (chunk) => {
  output += chunk;
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`startup timed out: ${output}`)), 10000);
    service.stdout.on('data', () => {
      if (output.includes('Career Agent:')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    service.once('exit', (code) => {
      clearTimeout(timeout);
      reject(Error(`startup exited ${code}: ${output}`));
    });
  });
  const health = await (await fetch('http://127.0.0.1:3001/api/health')).json();
  assert.equal(health.databaseReady, true);
  assert.equal(health.modelConfigured, false);
  const second = start();
  let secondOutput = '';
  second.stderr.on('data', (chunk) => {
    secondOutput += chunk;
  });
  const [exitCode] = await once(second, 'exit');
  assert.notEqual(exitCode, 0);
  assert.match(secondOutput, /本地服务已经运行/);
  const pageResponse = await fetch('http://127.0.0.1:3001/');
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /assets\/index-/);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:3001/');
  await page.getByRole('button', { name: '注册新账号', exact: true }).waitFor();
  await page.screenshot({ path: '.local/production-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('账号', { exact: true }).waitFor();
  await page.screenshot({ path: '.local/production-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log(
    JSON.stringify({
      databaseReady: health.databaseReady,
      modelConfigured: health.modelConfigured,
      productionPage: 200,
      secondProcessRejected: true,
      desktopAndMobileRendered: true,
    }),
  );
} finally {
  await browser?.close();
  if (service.exitCode === null) {
    const exited = once(service, 'exit');
    service.kill();
    await exited;
  }
}
