import type {
  Conversation as ConversationDto,
  ConversationDetail,
  Message,
  Run,
  RunStatus,
  StreamEvent,
  StreamPayloads,
  Interaction,
} from '@career/contracts';
import type { Db } from '../../platform/database/index.js';
import { EventHub } from '../../platform/streaming/index.js';
import { assert } from '../../platform/http/errors.js';
import { id, now } from '../../platform/runtime/index.js';
type RunRow = {
  id: string;
  conversation_id: string;
  status: RunStatus;
  sequence: number;
  created_at: string;
  error: string | null;
};
export class Conversation {
  readonly hub = new EventHub();
  constructor(private db: Db) {}
  create(title = '新对话') {
    const c: ConversationDto = { id: id(), title, createdAt: now(), updatedAt: now() };
    this.db.put('conversation', c.id, c);
    return c;
  }
  get(conversationId: string) {
    const c = this.db.get<ConversationDto>('conversation', conversationId);
    assert(c, 'NOT_FOUND', '会话不存在。', 404);
    return c;
  }
  list(cursor?: string, limit = 30) {
    const all = this.db
      .list<ConversationDto>('conversation')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const index = cursor ? all.findIndex((c) => c.id === cursor) : -1;
    assert(!cursor || index >= 0, 'INVALID_CURSOR', '会话分页位置无效。');
    const items = all.slice(index + 1, index + 1 + limit);
    return { items, nextCursor: all.length > index + 1 + limit ? items.at(-1)!.id : null };
  }
  messages(conversationId: string) {
    return this.db.list<Message>('message').filter((m) => m.conversationId === conversationId);
  }
  addMessage(
    conversationId: string,
    role: Message['role'],
    text: string,
    messageId: string = id(),
    sources?: Message['sources'],
  ) {
    const c = this.get(conversationId);
    const m: Message = {
      id: messageId,
      conversationId,
      role,
      text,
      createdAt: now(),
      ...(sources?.length ? { sources } : {}),
    };
    this.db.put('message', m.id, m);
    c.updatedAt = now();
    if (c.title === '新对话' && role === 'user') c.title = text.slice(0, 32);
    this.db.put('conversation', c.id, c);
    return m;
  }
  interactions(conversationId: string) {
    return this.db
      .list<Interaction>('interaction')
      .filter((i) => i.conversationId === conversationId);
  }
  pending(conversationId: string) {
    return this.interactions(conversationId).find((i) => i.status === 'pending') ?? null;
  }
  detail(conversationId: string, before?: string, limit = 50): ConversationDetail {
    const conversation = this.get(conversationId);
    const all = this.messages(conversationId);
    const end = before ? all.findIndex((m) => m.id === before) : all.length;
    assert(end >= 0, 'INVALID_CURSOR', '消息分页位置无效。');
    const start = Math.max(0, end - limit);
    const runs = this.runs().filter((r) => r.conversationId === conversationId);
    const pending = this.pending(conversationId);
    return {
      conversation,
      messages: all.slice(start, end),
      nextCursor: start > 0 ? all[start].id : null,
      pendingInteraction: pending,
      activeRun:
        runs.find((r) => ['queued', 'running', 'cancelling'].includes(r.status)) ??
        (pending ? (runs.find((r) => r.id === pending.runId) ?? null) : null) ??
        (['failed', 'interrupted', 'cancelled'].includes(runs[0]?.status) ? runs[0] : null),
      interactions: this.interactions(conversationId),
    };
  }
  runs() {
    return (this.db.sql.prepare('SELECT * FROM runs ORDER BY rowid DESC').all() as RunRow[]).map(
      (r) => this.dto(r),
    );
  }
  private dto(r: RunRow): Run {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      status: r.status,
      lastSequence: r.sequence,
      createdAt: r.created_at,
      ...(r.error ? { error: JSON.parse(r.error) } : {}),
    };
  }
  getRun(runId: string) {
    const r = this.db.sql.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
    assert(r, 'NOT_FOUND', '运行不存在。', 404);
    return this.dto(r);
  }
  assertIdle() {
    assert(
      !this.runs().some((r) => ['queued', 'running', 'cancelling'].includes(r.status)),
      'RUN_CONFLICT',
      '当前已有正在执行的对话，请等待或停止。',
      409,
    );
  }
  createRun(conversationId: string) {
    this.get(conversationId);
    this.assertIdle();
    const runId = id();
    this.db.sql
      .prepare('INSERT INTO runs(id,conversation_id,status,created_at) VALUES(?,?,?,?)')
      .run(runId, conversationId, 'queued', now());
    return this.getRun(runId);
  }
  setStatus(runId: string, status: RunStatus, error?: Run['error']) {
    this.db.sql
      .prepare('UPDATE runs SET status=?,error=? WHERE id=?')
      .run(status, error ? JSON.stringify(error) : null, runId);
  }
  append<K extends keyof StreamPayloads>(
    runId: string,
    type: K,
    data: StreamPayloads[K],
  ): StreamEvent {
    const event = this.db.transaction(() => {
      const r = this.getRun(runId);
      const e = {
        type,
        runId,
        sequence: r.lastSequence + 1,
        timestamp: now(),
        data,
      } as StreamEvent;
      this.db.sql
        .prepare('INSERT INTO events VALUES(?,?,?)')
        .run(runId, e.sequence, JSON.stringify(e));
      this.db.sql.prepare('UPDATE runs SET sequence=? WHERE id=?').run(e.sequence, runId);
      return e;
    });
    this.db.afterCommit(() => this.hub.publish(runId));
    return event;
  }
  events(runId: string, after = 0) {
    this.getRun(runId);
    return (
      this.db.sql
        .prepare('SELECT payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence')
        .all(runId, after) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as StreamEvent);
  }
  getInteraction(interactionId: string) {
    const i = this.db.get<Interaction>('interaction', interactionId);
    assert(i, 'NOT_FOUND', '交互请求不存在。', 404);
    return i;
  }
  requestInteraction(input: Omit<Interaction, 'id' | 'status' | 'createdAt'>) {
    this.expire((i) => i.conversationId === input.conversationId);
    const interaction: Interaction = { ...input, id: id(), status: 'pending', createdAt: now() };
    this.db.put('interaction', interaction.id, interaction);
    this.append(input.runId, 'interaction.requested', { interaction });
    return interaction;
  }
  updateInteraction(interactionId: string, status: Interaction['status'], eventRunId?: string) {
    const i = this.getInteraction(interactionId);
    i.status = status;
    this.db.put('interaction', i.id, i);
    if (eventRunId) this.append(eventRunId, 'interaction.updated', { interactionId, status });
    return i;
  }
  expire(matches: (i: Interaction) => boolean, eventRunId?: string) {
    for (const i of this.db
      .list<Interaction>('interaction')
      .filter((i) => i.status === 'pending' && matches(i)))
      this.updateInteraction(i.id, 'expired', eventRunId);
  }
  deduplicate<T>(
    scope: string,
    requestId: string,
    input: unknown,
    fn: () => T,
  ): { result: T; replayed: boolean } {
    const encoded = JSON.stringify(input);
    const old = this.db.sql
      .prepare('SELECT input,result FROM requests WHERE scope=? AND request_id=?')
      .get(scope, requestId) as { input: string; result: string } | undefined;
    if (old) {
      assert(old.input === encoded, 'IDEMPOTENCY_CONFLICT', '此请求标识已用于不同内容。', 409);
      return { result: JSON.parse(old.result), replayed: true };
    }
    const result = fn();
    this.db.sql
      .prepare('INSERT INTO requests VALUES(?,?,?,?)')
      .run(scope, requestId, encoded, JSON.stringify(result));
    return { result, replayed: false };
  }
  recover() {
    for (const run of this.runs().filter((r) =>
      ['queued', 'running', 'cancelling'].includes(r.status),
    )) {
      const partials = new Map<string, string>();
      for (const e of this.events(run.id))
        if (e.type === 'message.delta')
          partials.set(e.data.messageId, (partials.get(e.data.messageId) ?? '') + e.data.delta);
        else if (e.type === 'message.completed') partials.delete(e.data.message.id);
      for (const [messageId, text] of partials)
        if (text) {
          const m = this.addMessage(run.conversationId, 'assistant', text, messageId);
          this.append(run.id, 'message.completed', { message: m });
        }
      this.setStatus(run.id, 'interrupted');
      this.append(run.id, 'run.finished', {
        status: 'interrupted',
        error: {
          code: 'PROCESS_RESTARTED',
          message: '上次运行因服务重启中断，已保存完成的操作和部分回复。',
          retryable: true,
        },
      });
    }
  }
}
