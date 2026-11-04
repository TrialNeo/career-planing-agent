import type { Services } from '../services.js';
import { submissionInput, reviewInput } from '../../module/learning/index.js';
import { assert } from '../../platform/http/errors.js';
export function saveSubmission(s: Services, conversationId: string, input: unknown) {
  return s.db.transaction(() => {
    const parsed = submissionInput.parse(input);
    const task = s.planning.getTask(parsed.taskId);
    const submission = s.learning.saveSubmission(
      parsed,
      task,
      s.conversation.messages(conversationId),
    );
    s.planning.setTaskStatus(task.id, 'pending_review', task.revision);
    return { submissionId: submission.id, taskId: task.id, createdAt: submission.createdAt };
  });
}
export function saveReview(s: Services, input: unknown) {
  return s.db.transaction(() => {
    const parsed = reviewInput.parse(input);
    const submission = s.learning.getSubmission(parsed.submissionId);
    const task = s.planning.getTask(submission.taskId);
    assert(
      task.status === 'pending_review' && task.revision === submission.taskRevision + 1,
      'STALE_SUBMISSION',
      '任务版本或状态已变化，本次提交不能继续评估。',
      409,
    );
    const review = s.learning.saveReview(parsed, task);
    const evidenceIds = s.learner.addEvidence(review.id, review.skillEvidence);
    const taskStatus = review.criteriaResults.every((c) => c.result === '符合')
      ? 'completed'
      : 'needs_work';
    s.planning.setTaskStatus(task.id, taskStatus, task.revision);
    return { reviewId: review.id, taskStatus, evidenceIds };
  });
}
