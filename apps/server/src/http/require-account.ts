import type { RequestHandler } from 'express';
import { assert } from '../platform/http/errors.js';
import type { HttpDependencies } from './context.js';

export function requireAccount({ auth, forUser }: HttpDependencies): RequestHandler {
  return (req, res, next) => {
    const session = auth.fromCookie(req.headers.cookie);
    assert(session, 'UNAUTHENTICATED', '请先登录。', 401);
    const expectedAccount =
      req.get('X-Career-Account') ?? (req.path.endsWith('/events') ? req.query.account : undefined);
    assert(
      expectedAccount === undefined || expectedAccount === session.user.id,
      'SESSION_CHANGED',
      '登录账号已切换，请刷新当前页面。',
      401,
    );
    res.locals.account = { session, workspace: forUser(session.user.id) };
    next();
  };
}
