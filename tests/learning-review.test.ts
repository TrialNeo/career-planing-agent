import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../packages/contracts/src/index.js';
import { openDatabase, type Db } from '../apps/server/src/platform/database/index.js';
import { Learning } from '../apps/server/src/module/learning/index.js';

let db: Db;
let learning: Learning;
let task: Task;
let input: any;
beforeEach(() => {
  db = openDatabase(':memory:');
  learning = new Learning(db);
  task = {
    id: 'task',
    revision: 1,
    planId: 'plan',
    planVersion: 1,
    purpose: '学习',
    deliverable: '代码说明',
    criteria: [{ id: 'criterion', description: '说明接口设计' }],
    estimatedMinutes: 30,
    status: 'planned',
  };
  const submission = learning.saveSubmission(
    { taskId: task.id, evidenceMessageIds: ['message'] },
    task,
    [
      {
        id: 'message',
        conversationId: 'conversation',
        role: 'user',
        text: '这是我的代码与说明',
        createdAt: new Date().toISOString(),
      },
    ],
  );
  input = {
    submissionId: submission.id,
    criteriaResults: [
      {
        criterionId: 'criterion',
        result: '符合',
        reason: '内容说明完整，未执行代码',
        evidenceMessageIds: ['message'],
      },
    ],
    skillEvidence: [
      {
        skill: '接口设计',
        level: '能够说明接口职责',
        evidenceMessageIds: ['message'],
        basis: 'content_review',
      },
    ],
    nextAction: '请在本地运行测试并补充结果',
  };
});
afterEach(() => db.close());

describe('content-only assessment', () => {
  it.each([
    [
      'skill level',
      (v: any) => {
        v.skillEvidence[0].level = '测试通过，代码已成功运行';
      },
    ],
    [
      'skill name',
      (v: any) => {
        v.skillEvidence[0].skill = '代码运行通过';
      },
    ],
    [
      'criterion reason',
      (v: any) => {
        v.criteriaResults[0].reason = '说明完整，所有测试均已通过';
      },
    ],
    [
      'unsatisfied criterion reason',
      (v: any) => {
        v.criteriaResults[0].result = '未符合';
        v.criteriaResults[0].reason = '代码已经运行成功，但说明不完整';
      },
    ],
    [
      'next action',
      (v: any) => {
        v.nextAction = '代码已成功运行，可以继续下一阶段';
      },
    ],
    [
      'English execution claim',
      (v: any) => {
        v.skillEvidence[0].level = 'All tests have passed and code ran successfully';
      },
    ],
    [
      'negation does not hide a later claim',
      (v: any) => {
        v.nextAction = '未执行代码，但测试通过';
      },
    ],
  ])('rejects an execution-success assertion in %s without persisting a review', (_, change) => {
    change(input);
    expect(() => learning.saveReview(input, task)).toThrowError(
      expect.objectContaining({ code: 'UNVERIFIED_EXECUTION' }),
    );
    expect(learning.reviews()).toEqual([]);
  });

  it.each([
    '代码实际运行并通过全部测试',
    '运行无报错',
    '所有测试均通过',
    'Execute the application successfully',
  ])('does not satisfy execution criterion %s using a neutral explanation', (description) => {
    task.criteria[0].description = description;
    input.criteriaResults[0].reason = '实现包含所需接口和说明';
    expect(() => learning.saveReview(input, task)).toThrowError(
      expect.objectContaining({ code: 'UNVERIFIED_EXECUTION' }),
    );
    expect(learning.reviews()).toEqual([]);
  });

  it('allows explicit non-execution statements and future verification instructions', () => {
    input.skillEvidence[0].level = '内容说明完整，未执行代码，未运行测试，不能确认运行通过';
    input.nextAction = '请在本地运行测试并确认测试通过后提供日志';
    expect(learning.saveReview(input, task).criteriaResults[0].result).toBe('符合');
  });

  it('allows an execution criterion to remain unverified', () => {
    task.criteria[0].description = '运行并通过测试';
    input.criteriaResults[0].result = '证据不足';
    input.criteriaResults[0].reason = '未运行测试，不能确认测试通过';
    expect(learning.saveReview(input, task).criteriaResults[0].result).toBe('证据不足');
  });
});
