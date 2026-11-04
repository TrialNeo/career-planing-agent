import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AuthState, AuthUser } from '../../../packages/contracts/src/index';
import { api, post, errorText } from './api';

const announce = () => localStorage.setItem('career.auth-change', crypto.randomUUID());
export function AuthGate({
  children,
}: {
  children: (user: AuthUser, logout: () => void) => ReactNode;
}) {
  const [state, setState] = useState<AuthState | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const check = useCallback(async (hide = true) => {
    const current = ++generation.current;
    if (hide) setChecking(true);
    try {
      const value = await api<AuthState>('/auth/me');
      if (current !== generation.current) return;
      setState(value);
      setError('');
    } catch (e) {
      if (current !== generation.current) return;
      setError(errorText(e));
      if (hide) setState(null);
    } finally {
      if (current === generation.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
    const storage = (event: StorageEvent) => {
      if (event.key === 'career.auth-change') void check();
    };
    const invalid = () => void check();
    const focus = () => void check(false);
    window.addEventListener('storage', storage);
    window.addEventListener('career:session-changed', invalid);
    window.addEventListener('focus', focus);
    const timer = setInterval(focus, 60000);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener('career:session-changed', invalid);
      window.removeEventListener('focus', focus);
    };
  }, [check]);
  const logout = async () => {
    generation.current++;
    setChecking(true);
    try {
      await post('/auth/logout');
      announce();
      await check();
    } catch (e) {
      setState(null);
      setError(errorText(e));
      setChecking(false);
    }
  };
  if (checking)
    return (
      <main className="auth-page">
        <p role="status">正在读取账号…</p>
      </main>
    );
  if (state?.user) return children(state.user, () => void logout());
  if (!state)
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <p role="alert">{error || '暂时无法读取账号。'}</p>
          <button onClick={() => void check()}>重新连接</button>
        </section>
      </main>
    );
  return (
    <AuthForm
      firstAccount={state.firstAccount}
      onAuthenticated={(user) => {
        generation.current++;
        setState({ user, firstAccount: false });
        announce();
      }}
    />
  );
}

function AuthForm({
  firstAccount,
  onAuthenticated,
}: {
  firstAccount: boolean;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [register, setRegister] = useState(firstAccount);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = async () => {
    if (busy) return;
    setNotice('');
    if (register && password !== confirmation) {
      setNotice('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ user: AuthUser }>(`/auth/${register ? 'register' : 'login'}`, {
        username,
        password,
      });
      setPassword('');
      setConfirmation('');
      onAuthenticated(result.user);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-label="账号登录">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <div>
            职业规划<span>CAREER AGENT</span>
          </div>
        </div>
        <h1>{register ? '为自己的下一步，留一个空间。' : '继续你的职业探索。'}</h1>
        <p className="auth-intro">登录后，接着聊你的目标、行动与收获。</p>
        <div className="auth-tabs">
          <button
            type="button"
            aria-pressed={!register}
            disabled={busy}
            onClick={() => {
              setRegister(false);
              setNotice('');
              setPassword('');
              setConfirmation('');
            }}
          >
            已有账号
          </button>
          <button
            type="button"
            aria-pressed={register}
            disabled={busy}
            onClick={() => {
              setRegister(true);
              setNotice('');
              setPassword('');
              setConfirmation('');
            }}
          >
            注册新账号
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="auth-username">账号</label>
          <input
            id="auth-username"
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            value={username}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3–32 位文字、数字、下划线或短横线"
          />
          <label htmlFor="auth-password">密码</label>
          <input
            id="auth-password"
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={8}
            maxLength={128}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
          />
          {register && (
            <>
              <label htmlFor="auth-confirm">确认密码</label>
              <input
                id="auth-confirm"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </>
          )}
          {notice && (
            <p className="auth-error" role="alert">
              {notice}
            </p>
          )}
          <button className="auth-submit" disabled={busy} type="submit">
            {busy ? '正在处理…' : register ? '创建账号' : '登录'}
          </button>
        </form>
        {firstAccount && register && (
          <p className="auth-note">首次注册的账号将接收本机已有的聊天和学习记录。</p>
        )}
        <p className="auth-note">每个账号的聊天和长期记忆独立保存，岗位知识库共用。</p>
      </section>
    </main>
  );
}
