import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../apps/server/src/platform/database/index.js';
import { Learner } from '../apps/server/src/module/learner/index.js';
import { Planning } from '../apps/server/src/module/planning/index.js';
import { Learning } from '../apps/server/src/module/learning/index.js';

let db: Db;
afterEach(() => db?.close());
describe('durable business state', () => {
  it('rolls back all writes in a failed transaction', () => {
    db = openDatabase(':memory:');
    expect(() =>
      db.transaction(() => {
        db.put('x', 'a', { value: 1 });
        throw Error('rollback');
      }),
    ).toThrow('rollback');
    expect(db.get('x', 'a')).toBeUndefined();
  });
  it('stores profile claims with real message evidence and protects confirmed goals', () => {
    db = openDatabase(':memory:');
    const learner = new Learner(db);
    expect(() =>
      learner.updateProfile(
        {
          changes: [
            {
              field: 'goal',
              value: 'backend',
              evidenceRefs: ['m1'],
              evidenceType: 'user_statement',
            },
          ],
        },
        ['m1'],
      ),
    ).toThrow();
    const result = learner.updateProfile(
      {
        changes: [
          {
            field: 'weeklyBudgetMinutes',
            value: 240,
            evidenceRefs: ['m1'],
            evidenceType: 'user_statement',
          },
        ],
      },
      ['m1'],
    );
    expect(result.profileRevision).toBe(1);
    expect(learner.state().profile.weeklyBudgetMinutes.value).toBe(240);
    expect(() =>
      learner.proposeGoal({ direction: '后端', reason: '用户希望', evidenceRefs: ['missing'] }, [
        'm1',
      ]),
    ).toThrow();
  });
  it('requires a confirmed goal and preserves immutable plan versions and optimistic task revisions', () => {
    db = openDatabase(':memory:');
    const learner = new Learner(db);
    const planning = new Planning(db);
    const goal = learner.proposeGoal({ direction: '后端', reason: '希望', evidenceRefs: ['m1'] }, [
      'm1',
    ]);
    learner.confirmGoal(goal.id);
    const plan = planning.saveDraft({
      goalId: goal.id,
      milestones: [
        {
          id: 'm',
          title: '基础',
          deliverable: 'API',
          criteria: [{ id: 'c', description: '有说明' }],
        },
      ],
      weeklyBudgetMinutes: 240,
      reason: '四小时',
    });
    expect(plan.status).toBe('draft');
    planning.activate(plan.id, plan.version);
    const task = planning.upsertTask({
      planVersion: 1,
      purpose: '练习',
      deliverable: '代码',
      criteria: [{ id: 'c', description: '说明' }],
      estimatedMinutes: 60,
    });
    expect(() => planning.upsertTask({ ...task, taskId: task.id, expectedRevision: 0 })).toThrow();
    const revised = planning.saveDraft({
      goalId: goal.id,
      milestones: plan.milestones,
      weeklyBudgetMinutes: 240,
      baseVersion: 1,
      reason: '减量',
    });
    expect(revised.version).toBe(2);
    expect(planning.getPlan(plan.id, 1)?.status).toBe('active');
    expect(() => planning.activate(plan.id, 1)).toThrow();
  });
  it('captures original evidence and requires every criterion in a review', () => {
    db = openDatabase(':memory:');
    const learning = new Learning(db);
    const message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user' as const,
      text: '我的实现',
      createdAt: new Date().toISOString(),
    };
    const task = {
      id: 't',
      revision: 1,
      planId: 'p',
      planVersion: 1,
      purpose: '实现',
      deliverable: '代码',
      criteria: [{ id: 'c', description: '有说明' }],
      estimatedMinutes: 60,
      status: 'planned' as const,
    };
    const sub = learning.saveSubmission(
      { taskId: 't', evidenceMessageIds: ['m1'], actualMinutes: 40 },
      task,
      [message],
    );
    expect(learning.getSubmission(sub.id).materials[0].text).toBe('我的实现');
    expect(() =>
      learning.saveReview(
        { submissionId: sub.id, criteriaResults: [], skillEvidence: [], nextAction: '继续' },
        task,
      ),
    ).toThrow();
    const review = learning.saveReview(
      {
        submissionId: sub.id,
        criteriaResults: [
          { criterionId: 'c', result: '证据不足', reason: '没有执行', evidenceMessageIds: ['m1'] },
        ],
        skillEvidence: [],
        nextAction: '补充说明',
      },
      task,
    );
    expect(review.criteriaResults[0].result).toBe('证据不足');
  });
});
