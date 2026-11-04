import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import type {
  Conversation,
  ConversationDetail,
  Message,
  Run,
  StreamEvent,
  Interaction,
  InteractionAnswer,
  GoalProposal,
  Plan,
  AuthUser,
} from '../../../packages/contracts/src/index';
import { accountClient, RequestError, errorText } from './api';
import { AuthGate } from './auth';
import './style.css';

const live = (run: Run | null) => !!run && ['queued', 'running', 'cancelling'].includes(run.status);
const statusLabel: Record<Run['status'], string> = {
  queued: '正在准备',
  running: '正在思考',
  waiting_input: '等待你的回答',
  completed: '回复完成',
  cancelling: '正在停止',
  cancelled: '已停止',
  failed: '本次运行失败',
  interrupted: '上次运行已中断',
};
const eventNames = [
  'run.started',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'interaction.requested',
  'interaction.updated',
  'run.finished',
];
const safeUrl = (url: string | null | undefined) => {
  try {
    const u = new URL(url ?? '');
    return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
};
type Notice = { text: string; retry?: () => void };
type PendingSend = { conversationId: string; text: string; clientRequestId: string };
type PendingAnswer = { interactionId: string; conversationId: string; body: InteractionAnswer };

function MessageView({ message }: { message: Message }) {
  return (
    <article
      className={`message ${message.role}`}
      aria-label={message.role === 'user' ? '我的消息' : '职业规划助手的消息'}
    >
      <div className="message-label">
        {message.role === 'user' ? '你' : message.role === 'system' ? '提示' : '职业规划助手'}
      </div>
      <div className="bubble">
        <Markdown
          components={{
            a: ({ href, children }) => {
              const url = safeUrl(href);
              return url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {children}
                  <span className="sr-only">（在新窗口打开）</span>
                </a>
              ) : (
                <span>{children}</span>
              );
            },
          }}
        >
          {message.text}
        </Markdown>
        {!!message.sources?.length && (
          <details className="sources">
            <summary>参考来源 · {message.sources.length}</summary>
            <ol>
              {message.sources.map((s, i) => (
                <li key={`${s.sheet}-${s.row}-${i}`}>
                  {safeUrl(s.url) ? (
                    <a href={safeUrl(s.url)} target="_blank" rel="noopener noreferrer">
                      {s.source ?? s.sheet}
                    </a>
                  ) : (
                    <span>{s.source ?? s.sheet}</span>
                  )}
                  <small>
                    {s.sheet} · 第 {s.row} 行 · 数据版本 {s.datasetVersion}
                    {s.collectedAt ? ` · 采集于 ${s.collectedAt}` : ''}
                  </small>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </article>
  );
}

function InteractionCard({
  interaction,
  busy,
  onAnswer,
}: {
  interaction: Interaction;
  busy: boolean;
  onAnswer: (body: InteractionAnswer) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { optionIds: string[]; text: string }>>({});
  const [comment, setComment] = useState('');
  const questions = interaction.questions?.slice(0, 3) ?? [];
  const ready = questions.every(
    (q) => answers[q.id]?.optionIds.length || answers[q.id]?.text.trim(),
  );
  const update = (id: string, value: Partial<{ optionIds: string[]; text: string }>) =>
    setAnswers((old) => ({
      ...old,
      [id]: { ...(old[id] ?? { optionIds: [], text: '' }), ...value },
    }));
  const goal =
    interaction.kind === 'goal' ? (interaction.proposal as GoalProposal | undefined) : undefined;
  const plan = interaction.kind === 'plan' ? (interaction.proposal as Plan | undefined) : undefined;
  return (
    <section
      className="interaction-card"
      aria-label={
        interaction.kind === 'questions'
          ? '待回答问题'
          : interaction.kind === 'goal'
            ? '目标确认'
            : '计划确认'
      }
    >
      <div className="eyebrow">
        {interaction.kind === 'questions'
          ? '一起补充几条信息'
          : interaction.kind === 'goal'
            ? '请确认你的方向'
            : '请确认行动计划'}
      </div>
      <h2>{interaction.title}</h2>
      <p className="card-summary">{interaction.summary}</p>
      {interaction.kind === 'questions' ? (
        <>
          {questions.map((q, index) => (
            <fieldset key={q.id}>
              <legend>
                {index + 1}. {q.title}
                {q.multiple && <span className="muted">（可多选）</span>}
              </legend>
              <div className="options">
                {q.options.map((option) => {
                  const selected = answers[q.id]?.optionIds.includes(option.id) ?? false;
                  return (
                    <label className={`option ${selected ? 'selected' : ''}`} key={option.id}>
                      <input
                        type={q.multiple ? 'checkbox' : 'radio'}
                        name={q.id}
                        checked={selected}
                        onChange={() =>
                          update(q.id, {
                            optionIds: q.multiple
                              ? selected
                                ? answers[q.id].optionIds.filter((id) => id !== option.id)
                                : [...(answers[q.id]?.optionIds ?? []), option.id]
                              : [option.id],
                          })
                        }
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
              <input
                className="text-input"
                aria-label={`${q.title}：补充回答`}
                placeholder="也可以在这里填写你的回答…"
                value={answers[q.id]?.text ?? ''}
                onChange={(e) => update(q.id, { text: e.target.value })}
                maxLength={8000}
              />
            </fieldset>
          ))}
          <div className="card-actions">
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() =>
                onAnswer({
                  clientRequestId: crypto.randomUUID(),
                  kind: 'answers',
                  answers: questions.map((q) => ({
                    questionId: q.id,
                    optionIds: answers[q.id]?.optionIds ?? [],
                    text: answers[q.id]?.text ?? '',
                  })),
                })
              }
            >
              提交回答
            </button>
          </div>
        </>
      ) : (
        <>
          {goal && (
            <div className="proposal">
              <h3>{goal.direction}</h3>
              <p>{goal.reason}</p>
              {!!goal.evidenceRefs?.length && <p className="muted">依据本次对话提出</p>}
            </div>
          )}
          {plan && (
            <div className="proposal">
              <p>
                每周投入 <strong>{plan.weeklyBudgetMinutes} 分钟</strong>
              </p>
              <p>{plan.reason}</p>
              <ol className="milestones">
                {plan.milestones?.map((m) => (
                  <li key={m.id}>
                    <h3>{m.title}</h3>
                    <p>交付物：{m.deliverable}</p>
                    <ul>
                      {m.criteria.map((c) => (
                        <li key={c.id}>{c.description}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <label className="field">
            你的意见（可选）
            <textarea
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={8000}
              placeholder="例如：希望降低每周投入时间，或调整目标方向"
            />
          </label>
          <div className="card-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onAnswer({
                  clientRequestId: crypto.randomUUID(),
                  kind: 'decision',
                  action: 'confirm',
                  comment,
                })
              }
            >
              确认{interaction.kind === 'goal' ? '目标' : '计划'}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                onAnswer({
                  clientRequestId: crypto.randomUUID(),
                  kind: 'decision',
                  action: 'request_changes',
                  comment,
                })
              }
            >
              提出修改
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                onAnswer({
                  clientRequestId: crypto.randomUUID(),
                  kind: 'decision',
                  action: 'reject',
                  comment,
                })
              }
            >
              暂不采用
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function App({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const { api, post } = accountClient(user.id);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem(`career.${user.id}.selectedConversation`),
  );
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Interaction | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tool, setTool] = useState('');
  const [connection, setConnection] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const viewRevision = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const messageRef = useRef(messages);
  messageRef.current = messages;
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const uncertainSend = useRef<PendingSend | null>(null);
  const uncertainAnswer = useRef<PendingAnswer | null>(null);
  const suppressScroll = useRef(false);
  const refreshList = async (append = false) => {
    const page = await api<{ items: Conversation[]; nextCursor: string | null }>(
      `/conversations${append && listCursor ? `?cursor=${encodeURIComponent(listCursor)}` : ''}`,
    );
    setConversations((old) =>
      append ? [...old, ...page.items.filter((c) => !old.some((x) => x.id === c.id))] : page.items,
    );
    setListCursor(page.nextCursor);
  };
  const loadDetail = async (id: string) => {
    const revision = viewRevision.current;
    const value = await api<ConversationDetail>(`/conversations/${id}`);
    if (selectedRef.current !== id || revision !== viewRevision.current) return;
    setDetail(value);
    setMessages(value.messages);
    setPending(value.pendingInteraction);
    setRun(value.activeRun);
    setStreaming({});
    setTool('');
    const last = localStorage.getItem(`career.${user.id}.run.${id}`);
    if (last && !value.activeRun) {
      try {
        const r = await api<Run>(`/runs/${last}`);
        if (selectedRef.current !== id) return;
        if (r.status === 'interrupted') {
          setRun(r);
          setNotice({
            text: '上次运行因服务重启中断，已保存完成的操作和部分回复。你可以继续发送消息。',
          });
        }
      } catch {
        /* A removed run must not block the conversation. */
      }
    }
  };
  useEffect(() => {
    void refreshList().catch((e) =>
      setNotice({
        text: errorText(e),
        retry: () => void refreshList().catch((e) => setNotice({ text: errorText(e) })),
      }),
    );
  }, []);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setMessages([]);
      setPending(null);
      setRun(null);
      setStreaming({});
      return;
    }
    localStorage.setItem(`career.${user.id}.selectedConversation`, selected);
    setLoading(true);
    setDetail(null);
    setMessages([]);
    setPending(null);
    setRun(null);
    setStreaming({});
    setNotice(null);
    void loadDetail(selected)
      .catch((e) => {
        if (selectedRef.current === selected)
          setNotice({
            text: errorText(e),
            retry: () => void loadDetail(selected).catch((e) => setNotice({ text: errorText(e) })),
          });
      })
      .finally(() => {
        if (selectedRef.current === selected) setLoading(false);
      });
  }, [selected]);
  useEffect(() => {
    if (!run || !live(run) || selected !== run.conversationId) return;
    const conversationId = run.conversationId;
    const runId = run.id;
    let lastSequence = 0;
    let finished = false;
    let disposed = false;
    localStorage.setItem(`career.${user.id}.run.${conversationId}`, runId);
    const source = new EventSource(
      `/api/runs/${runId}/events?after=0&account=${encodeURIComponent(user.id)}`,
    );
    setConnection('正在连接');
    const handle = (raw: Event) => {
      if (disposed || finished || selectedRef.current !== conversationId) return;
      let event: StreamEvent;
      try {
        event = JSON.parse((raw as MessageEvent).data);
      } catch {
        return;
      }
      if (event.runId !== runId || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      setConnection('');
      switch (event.type) {
        case 'run.started':
          setRun((old) => (old?.id === runId ? { ...old, status: 'running' } : old));
          break;
        case 'message.delta':
          if (!messageRef.current.some((m) => m.id === event.data.messageId))
            setStreaming((old) => ({
              ...old,
              [event.data.messageId]: (old[event.data.messageId] ?? '') + event.data.delta,
            }));
          break;
        case 'message.completed':
          setMessages((old) =>
            old.some((m) => m.id === event.data.message.id)
              ? old.map((m) => (m.id === event.data.message.id ? event.data.message : m))
              : [...old, event.data.message],
          );
          setStreaming((old) => {
            const next = { ...old };
            delete next[event.data.message.id];
            return next;
          });
          break;
        case 'tool.started':
          setTool(event.data.label);
          break;
        case 'tool.completed':
          setTool(event.data.summary);
          break;
        case 'interaction.requested':
          setPending(event.data.interaction);
          break;
        case 'interaction.updated':
          setPending((old) => (old?.id === event.data.interactionId ? null : old));
          break;
        case 'run.finished':
          finished = true;
          source.close();
          setConnection('');
          setTool('');
          setRun((old) =>
            old?.id === runId
              ? { ...old, status: event.data.status, error: event.data.error }
              : old,
          );
          if (event.data.error) setNotice({ text: event.data.error.message });
          if (event.data.status === 'interrupted')
            setNotice({ text: '上次运行已中断，已保存部分回复。可以继续发送消息。' });
          void loadDetail(conversationId)
            .then(() => refreshList())
            .catch((e) => {
              if (selectedRef.current === conversationId)
                setNotice({ text: errorText(e), retry: () => void loadDetail(conversationId) });
            });
          break;
      }
    };
    eventNames.forEach((name) => source.addEventListener(name, handle));
    source.onopen = () => {
      if (!disposed) setConnection('');
    };
    source.onerror = () => {
      if (disposed || finished) return;
      setConnection('连接中断，正在自动重连…');
      void api<Run>(`/runs/${runId}`)
        .then((current) => {
          if (disposed || finished || selectedRef.current !== conversationId) return;
          if (!live(current)) {
            finished = true;
            source.close();
            setConnection('');
            if (current.status === 'interrupted' || current.status === 'failed')
              setNotice({ text: current.error?.message ?? '上次运行已中断，可以继续发送消息。' });
            void loadDetail(conversationId).catch((e) => setNotice({ text: errorText(e) }));
          }
        })
        .catch(() => {});
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, [run?.id, selected]);
  useEffect(() => {
    if (suppressScroll.current) {
      suppressScroll.current = false;
      return;
    }
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming, pending, tool]);
  const choose = (id: string) => {
    viewRevision.current++;
    selectedRef.current = id;
    setSelected(id);
    setSidebar(false);
    setText('');
  };
  const createConversation = async () => {
    const c = await post<Conversation>('/conversations');
    setConversations((old) => [c, ...old]);
    viewRevision.current++;
    selectedRef.current = c.id;
    setSelected(c.id);
    setDetail({
      conversation: c,
      messages: [],
      nextCursor: null,
      pendingInteraction: null,
      activeRun: null,
      interactions: [],
    });
    setSidebar(false);
    return c.id;
  };
  const newChat = () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    void createConversation()
      .catch((e) => setNotice({ text: errorText(e), retry: newChat }))
      .finally(() => setBusy(false));
  };
  const send = async (request?: PendingSend) => {
    if (sending.current || live(run) || (!request && !text.trim())) return;
    sending.current = true;
    setBusy(true);
    setNotice(null);
    let payload = request;
    try {
      if (!payload) {
        const id = selected ?? (await createConversation());
        payload = { conversationId: id, text: text.trim(), clientRequestId: crypto.randomUUID() };
      }
      uncertainSend.current = payload;
      const result = await post<{ messageId: string; runId: string }>(
        `/conversations/${payload.conversationId}/messages`,
        { clientRequestId: payload.clientRequestId, text: payload.text },
      );
      uncertainSend.current = null;
      viewRevision.current++;
      if (selectedRef.current === payload.conversationId) {
        setText('');
        setMessages((old) =>
          old.some((m) => m.id === result.messageId)
            ? old
            : [
                ...old,
                {
                  id: result.messageId,
                  conversationId: payload!.conversationId,
                  role: 'user',
                  text: payload!.text,
                  createdAt: new Date().toISOString(),
                },
              ],
        );
        setPending(null);
        setStreaming({});
        setTool('');
        setRun({
          id: result.runId,
          conversationId: payload.conversationId,
          status: 'queued',
          lastSequence: 0,
          createdAt: new Date().toISOString(),
        });
        localStorage.setItem(`career.${user.id}.run.${payload.conversationId}`, result.runId);
      }
      void refreshList().catch(() => {});
    } catch (e) {
      const saved = payload;
      if (!(e instanceof RequestError) || !e.ambiguous) uncertainSend.current = null;
      setNotice({ text: errorText(e), retry: saved ? () => void send(saved) : undefined });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const answer = async (body: InteractionAnswer, request?: PendingAnswer) => {
    if (sending.current || !selected || (!pending && !request)) return;
    const payload = request ?? { body, interactionId: pending!.id, conversationId: selected };
    sending.current = true;
    setBusy(true);
    setNotice(null);
    uncertainAnswer.current = payload;
    try {
      const result = await post<{
        interactionId: string;
        status: Interaction['status'];
        runId: string;
      }>(`/interactions/${payload.interactionId}/answer`, payload.body);
      uncertainAnswer.current = null;
      viewRevision.current++;
      if (selectedRef.current === payload.conversationId) {
        setPending(null);
        setStreaming({});
        const value = await api<ConversationDetail>(`/conversations/${payload.conversationId}`);
        if (selectedRef.current === payload.conversationId) {
          setMessages(value.messages);
          setDetail(value);
          setPending(value.pendingInteraction);
          localStorage.setItem(`career.${user.id}.run.${payload.conversationId}`, result.runId);
          setRun(
            value.activeRun?.id === result.runId
              ? value.activeRun
              : {
                  id: result.runId,
                  conversationId: payload.conversationId,
                  status: 'queued',
                  lastSequence: 0,
                  createdAt: new Date().toISOString(),
                },
          );
        }
      }
    } catch (e) {
      if (!(e instanceof RequestError) || !e.ambiguous) uncertainAnswer.current = null;
      setNotice({ text: errorText(e), retry: () => void answer(payload.body, payload) });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!run) return;
    try {
      const updated = await post<{ runId: string; status: Run['status'] }>(
        `/runs/${run.id}/cancel`,
      );
      setRun((old) => (old?.id === updated.runId ? { ...old, status: updated.status } : old));
    } catch (e) {
      setNotice({ text: errorText(e), retry: () => void stop() });
    }
  };
  const older = async () => {
    if (!selected || !detail?.nextCursor) return;
    setBusy(true);
    try {
      const value = await api<ConversationDetail>(
        `/conversations/${selected}?beforeMessageId=${encodeURIComponent(detail.nextCursor)}`,
      );
      if (selectedRef.current !== selected) return;
      suppressScroll.current = true;
      setMessages((old) => [
        ...value.messages.filter((m) => !old.some((x) => x.id === m.id)),
        ...old,
      ]);
      setDetail((old) => (old ? { ...old, nextCursor: value.nextCursor } : old));
    } catch (e) {
      setNotice({ text: errorText(e), retry: () => void older() });
    } finally {
      setBusy(false);
    }
  };
  const sendUncertain = uncertainSend.current?.conversationId === selected;
  const answerUncertain = uncertainAnswer.current?.conversationId === selected;
  const activeNotice =
    notice ??
    (sendUncertain
      ? {
          text: '上一次发送结果尚未确认，请重试以确认结果。',
          retry: () => void send(uncertainSend.current!),
        }
      : answerUncertain
        ? {
            text: '上一次卡片回答结果尚未确认，请重试以确认结果。',
            retry: () => void answer(uncertainAnswer.current!.body, uncertainAnswer.current!),
          }
        : null);
  const running = live(run);
  const title =
    detail?.conversation.title ?? conversations.find((c) => c.id === selected)?.title ?? '新的开始';
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="关闭会话列表"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? 'open' : ''}`} aria-label="会话列表">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <div>
            职业规划<span>CAREER AGENT</span>
          </div>
        </div>
        <button className="new-chat" onClick={newChat} disabled={busy}>
          <span>＋</span>新建对话
        </button>
        <div className="sidebar-label">最近对话</div>
        <nav className="history">
          {conversations.map((c) => (
            <button
              key={c.id}
              title={c.title}
              className={`history-item ${selected === c.id ? 'active' : ''}`}
              onClick={() => choose(c.id)}
              aria-current={selected === c.id ? 'page' : undefined}
            >
              <span className="history-symbol">◯</span>
              <span>{c.title}</span>
            </button>
          ))}
          {!conversations.length && <p className="empty-history">你的探索会保存在这里。</p>}
          {listCursor && (
            <button
              className="load-more"
              onClick={() =>
                void refreshList(true).catch((e) =>
                  setNotice({ text: errorText(e), retry: () => void refreshList(true) }),
                )
              }
            >
              加载更多会话
            </button>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="account-row">
            <span title={user.username}>{user.username}</span>
            <button onClick={onLogout}>退出登录</button>
          </div>
          <p>独立空间 · 持续记录你的成长</p>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="打开会话列表"
            onClick={() => setSidebar(true)}
          >
            ☰
          </button>
          <div className="conversation-title">{title}</div>
          <span className="local-badge">
            <span />
            本地工作空间
          </span>
        </header>
        <div className="chat-scroll">
          <div className="chat-content">
            {activeNotice && (
              <div className="notice" role="alert">
                <span>{activeNotice.text}</span>
                {activeNotice.retry && <button onClick={activeNotice.retry}>重试</button>}
                <button
                  className="notice-dismiss"
                  aria-label="关闭提示"
                  onClick={() => setNotice(null)}
                >
                  ×
                </button>
              </div>
            )}
            {!!detail?.reminders?.length && (
              <aside className="notice" aria-label="学习任务提醒">
                <span>
                  以下任务已到期：{detail.reminders.map((t) => t.purpose).join('、')}
                  。可以在对话中调整安排或提交成果。
                </span>
              </aside>
            )}
            {loading && (
              <p className="loading" role="status">
                正在载入对话…
              </p>
            )}
            {!loading && !messages.length && !Object.keys(streaming).length && (
              <section className="welcome">
                <div className="welcome-symbol">↗</div>
                <div className="eyebrow">从一次对话开始</div>
                <h1>下一步，走向更适合你的方向。</h1>
                <p>
                  聊聊你的专业、兴趣与困惑。我们一起梳理目标，
                  <br className="desktop-break" />
                  再把它变成每周能完成的小行动。
                </p>
                <div className="quick-prompts">
                  {[
                    '我还不确定适合什么职业',
                    '帮我梳理专业对应的就业方向',
                    '我想制定一份能坚持的学习计划',
                  ].map((prompt, i) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setText(prompt);
                        input.current?.focus();
                      }}
                    >
                      <span>{['◉', '⌁', '▤'][i]}</span>
                      {prompt}
                      <span className="prompt-arrow">↗</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {detail?.nextCursor && (
              <button className="load-older" disabled={busy} onClick={() => void older()}>
                加载更早的消息
              </button>
            )}
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {Object.entries(streaming).map(([id, value]) => (
              <MessageView
                key={id}
                message={{
                  id,
                  conversationId: selected ?? '',
                  role: 'assistant',
                  text: value,
                  createdAt: '',
                }}
              />
            ))}
            {pending && (
              <InteractionCard
                key={pending.id}
                interaction={pending}
                busy={busy || running || answerUncertain}
                onAnswer={(body) => void answer(body)}
              />
            )}
            <div className="run-state" role="status" aria-live="polite">
              {running && <span className="working-dot" />}
              {connection || tool || (run ? statusLabel[run.status] : '')}
            </div>
            <div ref={bottom} />
          </div>
        </div>
        <div className="composer-area">
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
              aria-label="输入消息"
              placeholder={
                pending ? '可以先回答上方卡片，也可以继续对话…' : '说说你的想法，或从一个困惑开始…'
              }
              rows={2}
              maxLength={50000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={loading || sendUncertain}
            />
            <div className="composer-bottom">
              <span>
                Enter 发送 <span className="separator">·</span> Shift + Enter 换行
              </span>
              {running ? (
                <button
                  className="send-button stop-button"
                  type="button"
                  aria-label="停止生成"
                  onClick={() => void stop()}
                  disabled={run?.status === 'cancelling'}
                >
                  ■
                </button>
              ) : (
                <button
                  className="send-button"
                  type="submit"
                  aria-label="发送消息"
                  disabled={busy || loading || !text.trim() || sendUncertain}
                >
                  ↑
                </button>
              )}
            </div>
          </form>
          <p className="composer-note">
            建议结合真实经历与岗位信息判断。目标和计划由你确认后生效。
          </p>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{(user, logout) => <App key={user.id} user={user} onLogout={logout} />}</AuthGate>
  </React.StrictMode>,
);
