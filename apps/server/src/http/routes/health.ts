import { Router } from 'express';
import type { HttpDependencies } from '../context.js';

export function healthRouter({ auth, forUser }: HttpDependencies) {
  const router = Router();
  router.get('/', (req, res) => {
    const session = auth.fromCookie(req.headers.cookie);
    res.json({
      status: 'ok',
      databaseReady: true,
      modelConfigured: session ? forUser(session.user.id).settings.configured() : false,
    });
  });
  return router;
}
