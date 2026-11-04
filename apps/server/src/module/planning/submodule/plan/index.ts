import type { Plan } from '@career/contracts';
import { z } from 'zod';
import type { Db } from '../../../../platform/database/index.js';
import { milestoneSchema } from '../milestone/index.js';

export { criteriaSchema } from '../milestone/index.js';
export const planInput = z
  .object({
    goalId: z.string().min(1),
    baseVersion: z.number().int().positive().optional(),
    milestones: z.array(milestoneSchema).min(1).max(20),
    weeklyBudgetMinutes: z.number().int().positive().max(10080),
    reason: z.string().min(1).max(4000),
  })
  .strict();

export function listPlans(db: Db) {
  return db.list<Plan>('plan');
}
export function activePlan(db: Db) {
  return listPlans(db).find((plan) => plan.status === 'active') ?? null;
}
export function getPlan(db: Db, planId: string, version: number) {
  return db.get<Plan>('plan', `${planId}:${version}`);
}
export function savePlan(db: Db, plan: Plan) {
  db.put('plan', `${plan.id}:${plan.version}`, plan);
}
