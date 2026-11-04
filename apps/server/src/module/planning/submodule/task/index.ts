import type { Task } from '@career/contracts';
import { z } from 'zod';
import type { Db } from '../../../../platform/database/index.js';
import { assert } from '../../../../platform/http/errors.js';
import { criteriaSchema } from '../milestone/index.js';

export const taskInput = z
  .object({
    taskId: z.string().min(1).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    planVersion: z.number().int().positive(),
    purpose: z.string().min(1).max(2000),
    deliverable: z.string().min(1).max(4000),
    criteria: criteriaSchema,
    estimatedMinutes: z.number().int().positive().max(10080),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();

export function listTasks(db: Db) {
  return db.list<Task>('task');
}
export function getTask(db: Db, taskId: string) {
  const task = db.get<Task>('task', taskId);
  assert(task, 'NOT_FOUND', '任务不存在。', 404);
  return task;
}
export function saveTask(db: Db, task: Task) {
  db.put('task', task.id, task);
}
