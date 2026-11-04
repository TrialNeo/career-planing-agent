import type { Db } from '../../../platform/database/index.js';
import { assert } from '../../../platform/http/errors.js';
import { getPlan, listPlans, savePlan } from '../submodule/plan/index.js';
import { listTasks, saveTask } from '../submodule/task/index.js';

export function retireActivePlan(db: Db) {
  for (const plan of listPlans(db).filter((plan) => plan.status === 'active')) {
    savePlan(db, { ...plan, status: 'superseded' });
  }
  for (const task of listTasks(db).filter(
    (task) => !['completed', 'superseded'].includes(task.status),
  )) {
    saveTask(db, { ...task, status: 'superseded', revision: task.revision + 1 });
  }
}

export function activateDraft(db: Db, planId: string, version: number) {
  const plan = getPlan(db, planId, version);
  assert(plan?.status === 'draft', 'STALE_PROPOSAL', '计划版本已失效。', 409);
  assert(
    !listPlans(db).some((candidate) => candidate.id === planId && candidate.version > version),
    'STALE_PROPOSAL',
    '请确认最新计划版本。',
    409,
  );
  retireActivePlan(db);
  plan.status = 'active';
  savePlan(db, plan);
  return plan;
}

export function rejectDraft(db: Db, planId: string, version: number) {
  const plan = getPlan(db, planId, version);
  if (plan?.status === 'draft') savePlan(db, { ...plan, status: 'rejected' });
}
