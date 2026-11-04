import { Router, type Request } from 'express';
import { sessionCookie, sessionLifetimeMs } from '../../module/auth/index.js';
import type { HttpDependencies } from '../context.js';

const cookieOptions = (req: Request) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: req.secure,
  path: '/',
  maxAge: sessionLifetimeMs,
});

export function authRouter({ auth, forUser }: HttpDependencies) {
  const router = Router();
  router.get('/me', (req, res) =>
    res.json({
      user: auth.fromCookie(req.headers.cookie)?.user ?? null,
      firstAccount: auth.users().length === 0,
    }),
  );
  router.post('/register', async (req, res) => {
    auth.throttle(req.ip ?? 'local');
    const result = await auth.register(req.body);
    forUser(result.user.id);
    auth.logout(auth.fromCookie(req.headers.cookie));
    res.cookie(sessionCookie, result.token, cookieOptions(req));
    res.status(201).json({ user: result.user });
  });
  router.post('/login', async (req, res) => {
    auth.throttle(req.ip ?? 'local');
    const result = await auth.login(req.body);
    // Replacing a browser session must also disconnect its existing live streams.
    auth.logout(auth.fromCookie(req.headers.cookie));
    res.cookie(sessionCookie, result.token, cookieOptions(req));
    res.json({ user: result.user });
  });
  router.post('/logout', (req, res) => {
    auth.logout(auth.fromCookie(req.headers.cookie));
    const { maxAge: _, ...clearOptions } = cookieOptions(req);
    res.clearCookie(sessionCookie, clearOptions);
    res.json({ ok: true });
  });
  return router;
}
