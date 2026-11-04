import { z } from 'zod';
import type { Task, Message, Submission, Review } from '@career/contracts';
import type { Db } from '../../platform/database/index.js';
import { assert } from '../../platform/http/errors.js';
import { id, now } from '../../platform/runtime/index.js';
import { claimsExecutionSuccess, requiresExecution } from './content-review.js';
export const submissionInput = z
  .object({
    taskId: z.string().min(1),
    evidenceMessageIds: z.array(z.string()).min(1).max(30),
    actualMinutes: z.number().int().nonnegative().max(100000).optional(),
    difficulties: z.string().max(4000).optional(),
    reflection: z.string().max(4000).optional(),
  })
  .strict();
export const reviewInput = z
  .object({
    submissionId: z.string().min(1),
    criteriaResults: z
      .array(
        z
          .object({
            criterionId: z.string(),
            result: z.enum(['符合', '未符合', '证据不足']),
            reason: z.string().min(1).max(4000),
            evidenceMessageIds: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    skillEvidence: z
      .array(
        z
          .object({
            skill: z.string().min(1).max(300),
            level: z.string().min(1).max(500),
            evidenceMessageIds: z.array(z.string()).min(1),
            basis: z.literal('content_review'),
          })
          .strict(),
      )
      .max(30),
    nextAction: z.string().min(1).max(4000),
  })
  .strict();
export class Learning {
  constructor(private db: Db) {}
  submissions() {
    return this.db.list<Submission>('submission');
  }
  reviews() {
    return this.db.list<Review>('review');
  }
  saveSubmission(input: unknown, task: Task, messages: Message[]) {
    const parsed = submissionInput.parse(input);
    assert(
      task.id === parsed.taskId && ['planned', 'in_progress', 'needs_work'].includes(task.status),
      'INVALID_TASK_STATUS',
      '任务当前不接受提交。',
      409,
    );
    const materials = parsed.evidenceMessageIds.map((ref) => {
      const m = messages.find((m) => m.id === ref && m.role === 'user');
      assert(m, 'INVALID_EVIDENCE', '成果必须引用真实用户消息。');
      return m;
    });
    const submission: Submission = {
      id: id(),
      ...parsed,
      taskRevision: task.revision,
      materials,
      createdAt: now(),
    };
    this.db.put('submission', submission.id, submission);
    return submission;
  }
  getSubmission(submissionId: string) {
    const sub = this.db.get<Submission>('submission', submissionId);
    assert(sub, 'NOT_FOUND', '成果提交不存在。', 404);
    return sub;
  }
  saveReview(input: unknown, task: Task) {
    const parsed = reviewInput.parse(input);
    const sub = this.getSubmission(parsed.submissionId);
    assert(sub.taskId === task.id, 'INVALID_SUBMISSION', '提交与任务不匹配。');
    assert(
      !this.reviews().some((r) => r.submissionId === sub.id),
      'ALREADY_REVIEWED',
      '本次成果已评估。',
      409,
    );
    assert(
      parsed.criteriaResults.length === task.criteria.length &&
        new Set(parsed.criteriaResults.map((r) => r.criterionId)).size === task.criteria.length &&
        task.criteria.every((c) => parsed.criteriaResults.some((r) => r.criterionId === c.id)),
      'CRITERIA_MISMATCH',
      '必须逐项评估全部完成标准。',
    );
    for (const e of [...parsed.criteriaResults, ...parsed.skillEvidence])
      assert(
        e.evidenceMessageIds.every((m) => sub.evidenceMessageIds.includes(m)),
        'INVALID_EVIDENCE',
        '评估必须引用本次提交材料。',
      );
    // The service never executes code. A runtime claim cannot be accepted as a content review.
    assert(
      !parsed.criteriaResults.some(
        (r) =>
          claimsExecutionSuccess(r.reason) ||
          (r.result === '符合' &&
            requiresExecution(task.criteria.find((c) => c.id === r.criterionId)!.description)),
      ) &&
        !parsed.skillEvidence.some(
          (e) => claimsExecutionSuccess(e.skill) || claimsExecutionSuccess(e.level),
        ) &&
        !claimsExecutionSuccess(parsed.nextAction, true),
      'UNVERIFIED_EXECUTION',
      '未执行代码，不能记录运行或测试通过。',
    );
    const review: Review = { id: id(), ...parsed, createdAt: now() };
    this.db.put('review', review.id, review);
    return review;
  }
}
