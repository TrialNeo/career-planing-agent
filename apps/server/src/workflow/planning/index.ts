import type { Interaction } from '@career/contracts';
import type { Services } from '../services.js';
import { assert } from '../../platform/http/errors.js';
export function confirmProposal(s: Services, interaction: Interaction) {
  if (interaction.kind === 'goal') {
    const proposal = s.learner.getGoal(interaction.targetId!);
    assert(
      proposal?.status === 'draft' && proposal.revision === interaction.targetVersion,
      'STALE_PROPOSAL',
      '目标提案已被替代。',
      409,
    );
    s.learner.confirmGoal(proposal.id);
    s.planning.retireActive();
    s.conversation.expire((i) => i.id !== interaction.id && i.kind !== 'questions');
  } else if (interaction.kind === 'plan') {
    const plan = s.planning.getPlan(interaction.targetId!, interaction.targetVersion!);
    assert(
      plan?.goalId === s.learner.state().goal?.id,
      'STALE_GOAL',
      '计划关联的目标已改变。',
      409,
    );
    s.planning.activate(interaction.targetId!, interaction.targetVersion!);
  }
}
