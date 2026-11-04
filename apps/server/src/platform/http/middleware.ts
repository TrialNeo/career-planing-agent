import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, assert, publicError } from './errors.js';

export const localRequestGuard: RequestHandler = (req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  assert(
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(req.hostname),
    'INVALID_HOST',
    '请使用本机地址访问。',
    403,
  );
  if (req.headers.origin)
    assert(
      req.headers.origin === `${req.protocol}://${req.get('host')}`,
      'INVALID_ORIGIN',
      '仅允许同源请求。',
      403,
    );
  next();
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const malformed = err?.type === 'entity.parse.failed';
  const tooLarge = err?.type === 'entity.too.large';
  res
    .status(
      err instanceof AppError
        ? err.status
        : err instanceof ZodError || malformed
          ? 400
          : tooLarge
            ? 413
            : 500,
    )
    .json(
      malformed
        ? { code: 'INVALID_JSON', message: '请求不是有效 JSON。', retryable: false }
        : tooLarge
          ? { code: 'REQUEST_TOO_LARGE', message: '内容过长，请拆分发送。', retryable: false }
          : publicError(err),
    );
};
