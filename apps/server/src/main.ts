import { resolve } from 'node:path';
import { createApp } from './app.js';
import { acquireProcessLock } from './platform/runtime/process-lock.js';
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('请使用 Node.js 24。');
const releaseLock = acquireProcessLock(resolve('.local/server-lock.sqlite'));
let instance: ReturnType<typeof createApp>;
try {
  instance = createApp({ settingsPath: resolve('.local/model.json') });
} catch (e) {
  releaseLock();
  throw e;
}
const server = instance.app.listen(Number(process.env.PORT ?? 3001), '127.0.0.1', () =>
  console.log(`Career Agent: http://127.0.0.1:${process.env.PORT ?? 3001}`),
);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  try {
    await instance.close();
  } finally {
    releaseLock();
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', async () => {
  console.error('服务启动失败，请检查端口是否被占用。');
  await shutdown();
});
