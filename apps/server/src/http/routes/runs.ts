import { Router } from 'express';
import { z } from 'zod';
import type { Auth } from '../../module/auth/index.js';
import { assert } from '../../platform/http/errors.js';
import { streamEvents } from '../../platform/streaming/sse.js';
import { accountContext } from '../context.js';

export function runsRouter(auth: Auth) {
  const router = Router();
  router.get('/:id', (req, res) =>
    res.json(accountContext(res).workspace.conversation.getRun(req.params.id)),
  );
  router.get('/:id/events', (req, res) => {
    const {
      session,
      workspace: { conversation },
    } = accountContext(res);
    const runId = req.params.id;
    const run = conversation.getRun(runId);
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(req.get('Last-Event-ID') ?? req.query.after ?? 0);
    assert(after <= run.lastSequence, 'INVALID_EVENT_CURSOR', '事件位置超出当前运行。');
    streamEvents(req, res, {
      after,
      read: (n) => conversation.events(runId, n),
      status: () => conversation.getRun(runId).status,
      subscribe: (fn) => conversation.hub.subscribe(runId, fn),
      authorized: () => auth.valid(session),
      onInvalidated: (fn) => auth.onInvalidated(session, fn),
    });
  });
  router.post('/:id/cancel', (req, res) =>
    res.json(accountContext(res).workspace.dialogue.cancel(req.params.id)),
  );
  return router;
}
