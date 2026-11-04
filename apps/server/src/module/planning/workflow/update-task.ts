import type { Task } from '@career/contracts';
import type { Db } from '../../../platform/database/index.js';
import { assert } from '../../../platform/http/errors.js';
import { id } from '../../../platform/runtime/index.js';
import { activePlan } from '../submodule/plan/index.js';
import { getTask, listTasks, saveTask, taskInput } from '../submodule/task/index.js';

export function updateTask(db: Db, input: unknown) {
  // A task belongs to the currently confirmed plan; draft task details are part of the plan card.
  const parsed = taskInput.parse(input);
  const plan = activePlan(db);
  assert(
    plan && plan.version === parsed.planVersion,
    'PLAN_NOT_ACTIVE',
    '任务必须使用当前已确认计划版本。',
    409,
  );
  const old = parsed.taskId ? getTask(db, parsed.taskId) : undefined;
  assert(
    !old || old.revision === parsed.expectedRevision,
    'REVISION_CONFLICT',
    '任务已改变，请重新读取。',
    409,
  );
  assert(
    !old ||
      (!['completed', 'pending_review', 'superseded'].includes(old.status) &&
        old.planId === plan.id),
    'TASK_LOCKED',
    '当前任务状态不允许修改。',
    409,
  );
  const others = listTasks(db).filter(
    (task) =>
      task.planId === plan.id &&
      task.id !== old?.id &&
      !['completed', 'superseded'].includes(task.status),
  );
  assert(
    others.reduce((sum, task) => sum + task.estimatedMinutes, 0) + parsed.estimatedMinutes <=
      plan.weeklyBudgetMinutes,
    'BUDGET_EXCEEDED',
    '近期任务总用时超过每周可投入时间。',
  );
  const task: Task = {
    id: old?.id ?? id(),
    revision: (old?.revision ?? 0) + 1,
    planId: plan.id,
    planVersion: plan.version,
    purpose: parsed.purpose,
    deliverable: parsed.deliverable,
    criteria: parsed.criteria,
    estimatedMinutes: parsed.estimatedMinutes,
    dueAt: parsed.dueAt,
    status: old?.status ?? 'planned',
  };
  saveTask(db, task);
  return task;
}

export function updateTaskStatus(
  db: Db,
  taskId: string,
  status: Task['status'],
  expectedRevision?: number,
) {
  const task = getTask(db, taskId);
  assert(
    expectedRevision === undefined || task.revision === expectedRevision,
    'REVISION_CONFLICT',
    '任务版本已变化。',
    409,
  );
  assert(task.status !== 'superseded', 'TASK_SUPERSEDED', '任务已被新计划替代。', 409);
  const updated = { ...task, status, revision: task.revision + 1 };
  saveTask(db, updated);
  return updated;
}
