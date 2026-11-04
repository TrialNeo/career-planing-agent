import { z } from 'zod';
export const goalInput = z
  .object({
    direction: z.string().trim().min(1).max(300),
    reason: z.string().trim().min(1).max(4000),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(30),
  })
  .strict();
