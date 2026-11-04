import { Router } from 'express';
import { answerInteraction } from '../../workflow/interaction/index.js';
import { accountContext } from '../context.js';

export function interactionsRouter() {
  const router = Router();
  router.post('/:id/answer', (req, res) => {
    const { workspace } = accountContext(res);
    res.json(answerInteraction(workspace, workspace.dialogue, req.params.id, req.body));
  });
  return router;
}
