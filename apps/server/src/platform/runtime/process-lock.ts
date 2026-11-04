import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Hold a separate SQLite database's OS lock for this process's lifetime.
 * Never unlink this file: contenders must always lock the same filesystem object.
 * Closing the connection or process death releases ownership without PID races.
 */
export function acquireProcessLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = new DatabaseSync(path);
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    lock.close();
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
      throw new Error('本地服务已经运行，请勿同时打开同一个 SQLite 数据库。', { cause: error });
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    lock.close();
    released = true;
  };
}
