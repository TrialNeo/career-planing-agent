import { Router } from 'express';
import type { HttpDependencies } from './context.js';
import { requireAccount } from './require-account.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { conversationsRouter } from './routes/conversations.js';
import { runsRouter } from './routes/runs.js';
import { interactionsRouter } from './routes/interactions.js';

export function apiRouter(dependencies: HttpDependencies) {
  const router = Router();
  router.use('/health', healthRouter(dependencies));
  router.use('/auth', authRouter(dependencies));
  router.use(requireAccount(dependencies));
  router.use('/conversations', conversationsRouter());
  router.use('/runs', runsRouter(dependencies.auth));
  router.use('/interactions', interactionsRouter());
  router.use((_req, res) =>
    res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在。', retryable: false }),
  );
  return router;
}
