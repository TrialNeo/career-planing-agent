import type { GoalProposal, SkillEvidence } from '@career/contracts';
import type { Db } from '../../platform/database/index.js';
import { assert } from '../../platform/http/errors.js';
import { id } from '../../platform/runtime/index.js';
import { profileChanges, type Profile } from './submodule/profile/index.js';
import { goalInput } from './submodule/goal/index.js';
export { profileChanges, goalInput };

export class Learner {
  constructor(private db: Db) {}
  state() {
    const p = this.db.get<Profile>('profile', 'local') ?? { revision: 0, fields: {} };
    return {
      profile: p.fields,
      profileRevision: p.revision,
      goal: this.db.list<GoalProposal>('goal').find((g) => g.status === 'confirmed') ?? null,
      skillEvidence: this.db.list('skill_evidence'),
    };
  }
  updateProfile(input: unknown, validMessageIds: string[]) {
    const { changes } = profileChanges.parse(input);
    const p = this.db.get<Profile>('profile', 'local') ?? { revision: 0, fields: {} };
    for (const c of changes) {
      assert(
        c.evidenceRefs.every((ref) => validMessageIds.includes(ref)),
        'INVALID_EVIDENCE',
        '画像依据必须引用真实用户消息。',
      );
      if (c.field === 'weeklyBudgetMinutes')
        assert(
          typeof c.value === 'number' && Number.isInteger(c.value),
          'INVALID_BUDGET',
          '每周投入必须是整数分钟。',
        );
      assert(c.evidenceType !== 'review', 'INVALID_EVIDENCE', '能力评估必须通过评估工具保存。');
      const verified = c.evidenceType === 'user_statement';
      if (!verified && p.fields[c.field]?.verified) continue;
      p.fields[c.field] = { ...c, verified };
    }
    p.revision++;
    this.db.put('profile', 'local', p);
    return {
      profileRevision: p.revision,
      appliedChanges: changes.filter((c) => c.evidenceType === 'user_statement'),
      unverifiedChanges: changes.filter((c) => c.evidenceType === 'inference'),
    };
  }
  proposeGoal(input: unknown, validMessageIds: string[]) {
    const parsed = goalInput.parse(input);
    assert(
      parsed.evidenceRefs.every((r) => validMessageIds.includes(r)),
      'INVALID_EVIDENCE',
      '目标依据必须引用真实用户消息。',
    );
    for (const old of this.db.list<GoalProposal>('goal').filter((g) => g.status === 'draft'))
      this.db.put('goal', old.id, { ...old, status: 'superseded' });
    const goal: GoalProposal = { id: id(), ...parsed, status: 'draft', revision: 1 };
    this.db.put('goal', goal.id, goal);
    return goal;
  }
  getGoal(goalId: string) {
    return this.db.get<GoalProposal>('goal', goalId);
  }
  confirmGoal(goalId: string) {
    const goal = this.getGoal(goalId);
    assert(goal?.status === 'draft', 'STALE_PROPOSAL', '目标提案已失效。', 409);
    for (const old of this.db.list<GoalProposal>('goal').filter((g) => g.status === 'confirmed'))
      this.db.put('goal', old.id, { ...old, status: 'superseded' });
    goal.status = 'confirmed';
    this.db.put('goal', goal.id, goal);
    return goal;
  }
  rejectGoal(goalId: string) {
    const g = this.getGoal(goalId);
    if (g) this.db.put('goal', g.id, { ...g, status: 'rejected' });
  }
  addEvidence(reviewId: string, evidence: SkillEvidence[]) {
    return evidence.map((e, i) => {
      const evidenceId = `${reviewId}:${i}`;
      this.db.put('skill_evidence', evidenceId, { id: evidenceId, reviewId, ...e });
      return evidenceId;
    });
  }
}
