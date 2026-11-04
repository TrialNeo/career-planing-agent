import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { acquireProcessLock } from '../apps/server/src/platform/runtime/process-lock.js';

const directories: string[] = [];
const releases: (() => void)[] = [];
const children: ChildProcess[] = [];
const lockPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-process-lock-'));
  directories.push(dir);
  return join(dir, 'server-lock.sqlite');
};
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGKILL');
      await closed;
    }
  }
  for (const release of releases.splice(0)) release();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('rejects a second owner until the first lock handle is released', () => {
  const path = lockPath();
  const release = acquireProcessLock(path);
  releases.push(release);
  expect(() => acquireProcessLock(path)).toThrow('本地服务已经运行');
  release();
  const next = acquireProcessLock(path);
  releases.push(next);
  expect(() => acquireProcessLock(path)).toThrow('本地服务已经运行');
  release(); // Releasing an old owner never unlocks a later owner.
  expect(() => acquireProcessLock(path)).toThrow('本地服务已经运行');
  next();
});

it('uses a process lifetime OS lock that is released after an abrupt owner exit', async () => {
  const path = lockPath();
  const moduleUrl = pathToFileURL(resolve('apps/server/src/platform/runtime/process-lock.ts')).href;
  const code = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; globalThis.releaseLock = acquireProcessLock(process.argv[1]); process.stdout.write('locked\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((accept, reject) => {
    child.stdout!.once('data', () => accept());
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Lock owner exited before acquiring: ${stderr}`)));
  });
  expect(() => acquireProcessLock(path)).toThrow('本地服务已经运行');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const release = acquireProcessLock(path);
  releases.push(release);
  expect(() => acquireProcessLock(path)).toThrow('本地服务已经运行');
});
