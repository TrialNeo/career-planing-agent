import type { Plan } from '@career/contracts';
import type { Db } from '../../../platform/database/index.js';
import { assert } from '../../../platform/http/errors.js';
import { id } from '../../../platform/runtime/index.js';
import { listPlans, planInput, savePlan } from '../submodule/plan/index.js';

// Initial drafts and revisions use the same version checks and persistence path.
export function createDraft(db: Db, input: unknown) {
  const parsed = planInput.parse(input);
  const existing = listPlans(db)
    .filter((plan) => plan.goalId === parsed.goalId)
    .sort((a, b) => b.version - a.version)[0];
  assert(
    existing ? parsed.baseVersion === existing.version : parsed.baseVersion === undefined,
    'VERSION_CONFLICT',
    '请基于最新计划版本修订。',
    409,
  );
  const plan: Plan = {
    id: existing?.id ?? id(),
    goalId: parsed.goalId,
    version: (existing?.version ?? 0) + 1,
    status: 'draft',
    milestones: parsed.milestones,
    weeklyBudgetMinutes: parsed.weeklyBudgetMinutes,
    reason: parsed.reason,
  };
  if (existing?.status === 'draft') savePlan(db, { ...existing, status: 'superseded' });
  savePlan(db, plan);
  return plan;
}
