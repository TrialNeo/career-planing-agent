import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AuthUser } from '@career/contracts';
import type { Db } from '../../platform/database/index.js';
import { assert } from '../../platform/http/errors.js';
import { id, now } from '../../platform/runtime/index.js';

const derive = promisify(scrypt);
const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .normalize('NFKC')
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N}_-]+$/u, '账号只能包含文字、数字、下划线或短横线'),
    password: z.string().min(8).max(128),
  })
  .strict();
export const sessionCookie = 'career_session';
export const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  legacy_owner: number;
};
type SessionRow = { token_hash: string; user_id: string; expires_at: number };
export type Session = { tokenHash: string; user: AuthUser; expiresAt: number };
const publicUser = (row: UserRow): AuthUser => ({
  id: row.id,
  username: row.username,
  createdAt: row.created_at,
});

export class Auth {
  private listeners = new Map<string, Set<() => void>>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private db: Db) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY, username TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, legacy_owner INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS auth_legacy_owner ON auth_users(legacy_owner) WHERE legacy_owner=1;
      CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id), expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires_at);
      INSERT OR IGNORE INTO schema_migrations VALUES(2,datetime('now'));
    `);
    db.sql.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(Date.now());
  }
  users(): AuthUser[] {
    return (this.db.sql.prepare('SELECT * FROM auth_users ORDER BY rowid').all() as UserRow[]).map(
      publicUser,
    );
  }
  isLegacyOwner(userId: string) {
    return !!(
      this.db.sql.prepare('SELECT legacy_owner FROM auth_users WHERE id=?').get(userId) as
        | UserRow
        | undefined
    )?.legacy_owner;
  }
  getUser(userId: string) {
    const row = this.db.sql.prepare('SELECT * FROM auth_users WHERE id=?').get(userId) as
      | UserRow
      | undefined;
    assert(row, 'UNAUTHENTICATED', '请先登录。', 401);
    return publicUser(row);
  }
  // Bound expensive password checks on this local service without retaining passwords.
  throttle(client: string) {
    const current = Date.now();
    for (const [key, value] of this.attempts) if (value.until <= current) this.attempts.delete(key);
    const entry = this.attempts.get(client) ?? { count: 0, until: current + 60000 };
    assert(++entry.count <= 30, 'AUTH_RATE_LIMIT', '登录尝试过于频繁，请一分钟后重试。', 429);
    this.attempts.set(client, entry);
  }
  async register(input: unknown) {
    const p = credentials.parse(input);
    const normalized = p.username.toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const key = (await derive(p.password, salt, 64)) as Buffer;
    const user = this.db.transaction(() => {
      assert(
        !this.db.sql.prepare('SELECT id FROM auth_users WHERE normalized_name=?').get(normalized),
        'USERNAME_TAKEN',
        '该账号已存在，请登录或更换账号。',
        409,
      );
      const value: AuthUser = { id: id(), username: p.username, createdAt: now() };
      const first = !this.db.sql.prepare('SELECT id FROM auth_users LIMIT 1').get();
      this.db.sql
        .prepare(
          'INSERT INTO auth_users(id,username,normalized_name,password_hash,created_at,legacy_owner) VALUES(?,?,?,?,?,?)',
        )
        .run(
          value.id,
          value.username,
          normalized,
          `scrypt:${salt}:${key.toString('hex')}`,
          value.createdAt,
          first ? 1 : 0,
        );
      return value;
    });
    return this.issue(user);
  }
  async login(input: unknown) {
    const p = credentials.parse(input);
    const row = this.db.sql
      .prepare('SELECT * FROM auth_users WHERE normalized_name=?')
      .get(p.username.toLowerCase()) as UserRow | undefined;
    // Always perform the password derivation, including for an unknown account.
    const [, salt, hash] = row?.password_hash.split(':') ?? ['', '0'.repeat(32), '0'.repeat(128)];
    const key = (await derive(p.password, salt, 64)) as Buffer;
    assert(
      row && timingSafeEqual(key, Buffer.from(hash, 'hex')),
      'INVALID_CREDENTIALS',
      '账号或密码不正确。',
      401,
    );
    return this.issue(publicUser(row));
  }
  private issue(user: AuthUser) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionLifetimeMs;
    this.db.sql
      .prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(digest(token), user.id, expiresAt);
    return { user, token, expiresAt };
  }
  fromCookie(cookie?: string): Session | null {
    const token = cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = digest(token);
    const row = this.db.sql
      .prepare('SELECT * FROM auth_sessions WHERE token_hash=? AND expires_at>?')
      .get(tokenHash, Date.now()) as SessionRow | undefined;
    return row ? { tokenHash, user: this.getUser(row.user_id), expiresAt: row.expires_at } : null;
  }
  valid(session: Session) {
    return (
      session.expiresAt > Date.now() &&
      !!this.db.sql
        .prepare('SELECT token_hash FROM auth_sessions WHERE token_hash=? AND expires_at>?')
        .get(session.tokenHash, Date.now())
    );
  }
  onInvalidated(session: Session, fn: () => void) {
    const listeners = this.listeners.get(session.tokenHash) ?? new Set();
    listeners.add(fn);
    this.listeners.set(session.tokenHash, listeners);
    return () => {
      listeners.delete(fn);
      if (!listeners.size) this.listeners.delete(session.tokenHash);
    };
  }
  logout(session: Session | null) {
    if (!session) return;
    this.db.sql.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(session.tokenHash);
    for (const fn of [...(this.listeners.get(session.tokenHash) ?? [])]) fn();
    this.listeners.delete(session.tokenHash);
  }
}
