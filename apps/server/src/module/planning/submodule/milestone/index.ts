import { z } from 'zod';

export const criteriaSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(100),
        description: z.string().min(1).max(1500),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .refine(
    (criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
    '标准ID不能重复',
  );

export const milestoneSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(500),
    deliverable: z.string().min(1).max(4000),
    criteria: criteriaSchema,
  })
  .strict();
