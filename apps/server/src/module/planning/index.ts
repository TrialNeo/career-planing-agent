import type { Task } from '@career/contracts';
import type { Db } from '../../platform/database/index.js';
import { activePlan, getPlan, listPlans } from './submodule/plan/index.js';
import { getTask, listTasks } from './submodule/task/index.js';
import { createDraft } from './workflow/create-draft.js';
import { activateDraft, rejectDraft, retireActivePlan } from './workflow/revise-draft.js';
import { updateTask, updateTaskStatus } from './workflow/update-task.js';
export { planInput } from './submodule/plan/index.js';
export { taskInput } from './submodule/task/index.js';
export class Planning {
  constructor(private db: Db) {}
  plans() {
    return listPlans(this.db);
  }
  tasks() {
    return listTasks(this.db);
  }
  activePlan() {
    return activePlan(this.db);
  }
  getPlan(planId: string, version: number) {
    return getPlan(this.db, planId, version);
  }
  getTask(taskId: string) {
    return getTask(this.db, taskId);
  }
  saveDraft(input: unknown) {
    return createDraft(this.db, input);
  }
  activate(planId: string, version: number) {
    return activateDraft(this.db, planId, version);
  }
  reject(planId: string, version: number) {
    return rejectDraft(this.db, planId, version);
  }
  retireActive() {
    return retireActivePlan(this.db);
  }
  upsertTask(input: unknown) {
    return updateTask(this.db, input);
  }
  setTaskStatus(taskId: string, status: Task['status'], expectedRevision?: number) {
    return updateTaskStatus(this.db, taskId, status, expectedRevision);
  }
}
