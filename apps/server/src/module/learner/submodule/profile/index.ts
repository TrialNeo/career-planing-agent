import { z } from 'zod';
export const profileFields = [
  'grade',
  'major',
  'education',
  'interests',
  'skills',
  'weeklyBudgetMinutes',
  'constraints',
  'experience',
  'deadline',
] as const;
export const profileChanges = z
  .object({
    changes: z
      .array(
        z
          .object({
            field: z.enum(profileFields),
            value: z.union([
              z.string().trim().min(1).max(4000),
              z.number().nonnegative().max(10080),
              z.array(z.string().max(500)).max(50),
            ]),
            evidenceRefs: z.array(z.string().min(1)).min(1).max(20),
            evidenceType: z.enum(['user_statement', 'inference', 'review']),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type Profile = {
  revision: number;
  fields: Record<
    string,
    { value: unknown; evidenceRefs: string[]; evidenceType: string; verified: boolean }
  >;
};
