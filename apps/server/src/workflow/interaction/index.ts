import { z } from 'zod';
import type { Interaction } from '@career/contracts';
import type { Services } from '../services.js';
import type { Dialogue } from '../dialogue/index.js';
import { assert } from '../../platform/http/errors.js';
import { confirmProposal } from '../planning/index.js';
export const answerInput = z.discriminatedUnion('kind', [
  z
    .object({
      clientRequestId: z.string().min(1).max(200),
      kind: z.literal('answers'),
      answers: z
        .array(
          z
            .object({
              questionId: z.string().min(1),
              optionIds: z.array(z.string().min(1)).max(8),
              text: z.string().max(8000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  z
    .object({
      clientRequestId: z.string().min(1).max(200),
      kind: z.literal('decision'),
      action: z.enum(['confirm', 'request_changes', 'reject']),
      comment: z.string().max(8000).optional(),
    })
    .strict(),
]);
export function answerInteraction(
  s: Services,
  dialogue: Dialogue,
  interactionId: string,
  input: unknown,
) {
  const parsed = answerInput.parse(input);
  const outcome = s.db.transaction(() =>
    s.conversation.deduplicate(
      `interaction:${interactionId}`,
      parsed.clientRequestId,
      parsed,
      () => {
        const interaction = s.conversation.getInteraction(interactionId);
        assert(
          interaction.status === 'pending',
          'INTERACTION_CLOSED',
          '卡片已经处理或失效，请使用最新卡片。',
          409,
        );
        s.conversation.assertIdle();
        let text: string;
        let status: Interaction['status'];
        if (interaction.kind === 'questions') {
          assert(parsed.kind === 'answers', 'ANSWER_KIND_MISMATCH', '请提交问题回答。');
          const qs = interaction.questions!;
          assert(
            parsed.answers.length === qs.length &&
              new Set(parsed.answers.map((a) => a.questionId)).size === qs.length,
            'INVALID_ANSWERS',
            '请回答卡片里的每个问题。',
          );
          text = parsed.answers
            .map((a) => {
              const q = qs.find((q) => q.id === a.questionId);
              assert(q, 'INVALID_QUESTION', '问题不属于此卡片。');
              assert(
                new Set(a.optionIds).size === a.optionIds.length &&
                  a.optionIds.every((o) => q.options.some((x) => x.id === o)),
                'INVALID_OPTION',
                '选项不属于此问题。',
              );
              assert(q.multiple || a.optionIds.length <= 1, 'INVALID_OPTION', '此题只能选择一项。');
              assert(
                a.optionIds.length || a.text?.trim(),
                'EMPTY_ANSWER',
                '请选择选项或填写回答。',
              );
              return `${q.title}：${a.optionIds.map((o) => q.options.find((x) => x.id === o)!.label).join('、')} ${a.text ?? ''}`;
            })
            .join('\n');
          status = 'answered';
        } else {
          assert(parsed.kind === 'decision', 'ANSWER_KIND_MISMATCH', '请使用确认或修改操作。');
          if (parsed.action === 'confirm') confirmProposal(s, interaction);
          else if (parsed.action === 'reject') {
            if (interaction.kind === 'goal') s.learner.rejectGoal(interaction.targetId!);
            else s.planning.reject(interaction.targetId!, interaction.targetVersion!);
          }
          status =
            parsed.action === 'confirm'
              ? 'confirmed'
              : parsed.action === 'reject'
                ? 'rejected'
                : 'changes_requested';
          text = `用户通过卡片操作：${parsed.action}。${interaction.title}\n${interaction.summary}${parsed.comment ? `\n用户意见：${parsed.comment}` : ''}`;
        }
        const run = s.conversation.createRun(interaction.conversationId);
        s.conversation.updateInteraction(interactionId, status, run.id);
        s.conversation.addMessage(interaction.conversationId, 'user', text);
        return { interactionId, status, runId: run.id };
      },
    ),
  );
  if (!outcome.replayed) dialogue.launch(outcome.result.runId);
  return outcome.result;
}
