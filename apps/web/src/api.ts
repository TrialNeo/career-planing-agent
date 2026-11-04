import type { ApiError } from '../../../packages/contracts/src/index';
export class RequestError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase());
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new RequestError('暂时无法连接服务，请检查本地服务是否启动后重试。', true, isWrite);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as ApiError | null;
    if (response.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined')
      window.dispatchEvent(new Event('career:session-changed'));
    throw new RequestError(
      error?.message ?? '请求未完成，请稍后重试。',
      error?.retryable ?? response.status >= 500,
      response.status >= 500 && isWrite,
    );
  }
  // A committed write may lose its response body after headers arrive. Keep the
  // original operation pending until a usable acknowledgement is received.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('服务响应不完整，请重试以确认本次操作结果。', true, isWrite);
  }
  return body as T;
}
export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
// Capture the account in each mounted view. A stale tab or delayed callback may
// never apply its operation to a newly logged-in browser session.
export function accountClient(userId: string) {
  const boundApi = <T>(path: string, init?: RequestInit) =>
    api<T>(path, {
      ...init,
      headers: { ...init?.headers, 'X-Career-Account': userId },
    });
  return {
    api: boundApi,
    post: <T>(path: string, body: unknown = {}) =>
      boundApi<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
