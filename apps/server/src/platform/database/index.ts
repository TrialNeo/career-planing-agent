import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Db {
  private depth = 0;
  private notifications: (() => void)[][] = [];
  constructor(public readonly sql: DatabaseSync) {}
  get<T = any>(kind: string, id: string): T | undefined {
    const row = this.sql
      .prepare('SELECT payload FROM entities WHERE kind=? AND id=?')
      .get(kind, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  list<T = any>(kind: string): T[] {
    return (
      this.sql.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid').all(kind) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload));
  }
  put(kind: string, id: string, value: unknown) {
    this.sql
      .prepare(
        'INSERT INTO entities(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload',
      )
      .run(kind, id, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    const savepoint = `tx_${this.depth++}`;
    const notifications: (() => void)[] = [];
    this.notifications.push(notifications);
    this.sql.exec(`SAVEPOINT ${savepoint}`);
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as any).then === 'function')
        throw Error('Database transactions must be synchronous');
      this.sql.exec(`RELEASE ${savepoint}`);
    } catch (e) {
      this.sql.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw e;
    } finally {
      this.depth--;
      this.notifications.pop();
    }
    const parent = this.notifications.at(-1);
    if (parent) parent.push(...notifications);
    else for (const notify of notifications) notify();
    return result;
  }
  afterCommit(notify: () => void) {
    const current = this.notifications.at(-1);
    if (current) current.push(notify);
    else notify();
  }
  close() {
    this.sql.close();
  }
}
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sql = new DatabaseSync(path);
  sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,status TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,error TEXT,lock_key INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(lock_key) WHERE status IN ('queued','running','cancelling');
    CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id),sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
    CREATE TABLE IF NOT EXISTS requests(scope TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,request_id));
    CREATE TABLE IF NOT EXISTS tool_calls(run_id TEXT NOT NULL,call_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(run_id,call_id));
    INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));
  `);
  return new Db(sql);
}
