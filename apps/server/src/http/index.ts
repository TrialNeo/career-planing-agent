import express from 'express';
import { resolve } from 'node:path';
import { errorHandler, localRequestGuard } from '../platform/http/middleware.js';
import { webRouter } from '../platform/http/web.js';
import type { HttpDependencies } from './context.js';
import { apiRouter } from './router.js';

export function createHttpApp(
  dependencies: HttpDependencies,
  options: { webDirectory?: string } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localRequestGuard);
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', apiRouter(dependencies));
  app.use(webRouter(options.webDirectory ?? resolve('apps/web/dist')));
  app.use(errorHandler);
  return app;
}
