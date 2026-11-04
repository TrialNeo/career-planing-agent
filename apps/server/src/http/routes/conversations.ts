import { Router } from 'express';
import { z } from 'zod';
import { accountContext } from '../context.js';

const pageInput = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const messageInput = z
  .object({
    clientRequestId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(50000),
  })
  .strict();

export function conversationsRouter() {
  const router = Router();
  router.get('/', (req, res) => {
    const q = pageInput.parse(req.query);
    res.json(accountContext(res).workspace.conversation.list(q.cursor, q.limit));
  });
  router.post('/', (req, res) => {
    const p = z
      .object({ title: z.string().trim().min(1).max(100).optional() })
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(accountContext(res).workspace.conversation.create(p.title));
  });
  router.get('/:id', (req, res) => {
    const { planning, conversation } = accountContext(res).workspace;
    const q = z
      .object({
        beforeMessageId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const reminders = planning
      .tasks()
      .filter(
        (t) =>
          t.dueAt &&
          Date.parse(t.dueAt) < Date.now() &&
          !['completed', 'superseded'].includes(t.status),
      )
      .map((t) => ({ taskId: t.id, purpose: t.purpose, dueAt: t.dueAt! }));
    res.json({ ...conversation.detail(req.params.id, q.beforeMessageId, q.limit), reminders });
  });
  router.post('/:id/messages', (req, res) => {
    res
      .status(202)
      .json(
        accountContext(res).workspace.dialogue.send(req.params.id, messageInput.parse(req.body)),
      );
  });
  return router;
}
