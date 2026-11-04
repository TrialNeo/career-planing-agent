import { z } from 'zod';
import type { Services } from '../services.js';
import type { ToolDefinition } from '../../platform/agent/index.js';
import { assert } from '../../platform/http/errors.js';
import { profileChanges, goalInput } from '../../module/learner/index.js';
import { planInput, taskInput } from '../../module/planning/index.js';
import { submissionInput, reviewInput } from '../../module/learning/index.js';
import { saveReview, saveSubmission } from '../review/index.js';
const str = z.string().min(1).max(4000);
export const interactionInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('questions'),
      title: str,
      questions: z
        .array(
          z
            .object({
              id: str,
              title: str,
              multiple: z.boolean().optional(),
              options: z.array(z.object({ id: str, label: str }).strict()).max(8),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  z.object({ kind: z.literal('goal'), goalProposalId: str }).strict(),
  z.object({ kind: z.literal('plan'), planId: str, version: z.number().int().positive() }).strict(),
]);
const stateInput = z
  .object({
    sections: z
      .array(z.enum(['profile', 'goal', 'plans', 'tasks', 'feedback', 'all']))
      .min(1)
      .max(6),
    taskId: str.optional(),
  })
  .strict();
const knowledgeInput = z
  .object({
    kinds: z
      .array(z.enum(['jobs', 'skills', 'directions', 'paths', 'courses']))
      .min(1)
      .max(5),
    query: z.string().max(500).optional(),
    direction: z.string().max(300).optional(),
    education: z.string().max(100).optional(),
    experience: z.string().max(100).optional(),
    limit: z.number().int().positive().max(30).optional(),
  })
  .strict();
export const toolSchemas = {
  knowledge_search: knowledgeInput,
  user_state_get: stateInput,
  profile_update: profileChanges,
  goal_propose: goalInput,
  plan_save: planInput,
  task_upsert: taskInput,
  submission_save: submissionInput,
  submission_get: z.object({ submissionId: str }).strict(),
  review_save: reviewInput,
  interaction_request: interactionInput,
};
const descriptions: Record<keyof typeof toolSchemas, string> = {
  knowledge_search: '查询岗位、方向占比、技能、学习路径或课程参考，返回行级来源与资料局限。',
  user_state_get: '读取长期画像、已确认目标、计划、任务与近期反馈。',
  profile_update: '保存有真实用户消息依据的画像。不得改变已确认目标。',
  goal_propose: '提出职业方向草案，等待用户通过卡片确认。',
  plan_save: '保存计划草案或修订；只有用户确认卡片后才能启用。',
  task_upsert: '在已启用计划内创建或修订近期任务，不能超过每周时间预算。',
  submission_save: '登记用户原消息为任务成果，并将任务变为待评估。',
  submission_get: '读取提交与原始材料；不自动获取链接或执行代码。',
  review_save: '逐项保存内容审阅结论、能力证据并更新任务状态。不能声称代码运行通过。',
  interaction_request: '请求1至3个问题或目标/计划确认。保存卡片后停止当前运行等待用户。',
};
export const toolDefinitions: ToolDefinition[] = Object.entries(toolSchemas).map(
  ([name, schema]) => {
    const { $schema, ...parameters } = z.toJSONSchema(schema);
    if (name === 'interaction_request') {
      const variants = (parameters as any).oneOf as any[];
      // Responses function parameters require an object at the root. Validate the
      // discriminated alternatives again server-side, while publishing their fields.
      return {
        name,
        description: descriptions.interaction_request,
        parameters: {
          type: 'object',
          properties: {
            ...Object.assign({}, ...variants.map((v) => v.properties)),
            kind: { type: 'string', enum: ['questions', 'goal', 'plan'] },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      };
    }
    return { name, description: descriptions[name as keyof typeof toolSchemas], parameters };
  },
);
export function executeTool(
  s: Services,
  conversationId: string,
  runId: string,
  name: string,
  input: unknown,
): unknown {
  assert(name in toolSchemas, 'UNKNOWN_TOOL', '未知工具。');
  const args: any = toolSchemas[name as keyof typeof toolSchemas].parse(input);
  const refs = s.conversation
    .messages(conversationId)
    .filter((m) => m.role === 'user')
    .map((m) => m.id);
  switch (name) {
    case 'knowledge_search':
      return s.knowledge.search(args);
    case 'user_state_get': {
      const state = s.learner.state();
      const sections = args.sections as string[];
      const has = (key: string) => sections.includes('all') || sections.includes(key);
      return {
        ...(has('profile')
          ? {
              profile: state.profile,
              profileRevision: state.profileRevision,
              skillEvidence: state.skillEvidence,
            }
          : {}),
        ...(has('goal') ? { goal: state.goal } : {}),
        ...(has('plans') ? { plans: s.planning.plans() } : {}),
        ...(has('tasks')
          ? { tasks: args.taskId ? [s.planning.getTask(args.taskId)] : s.planning.tasks() }
          : {}),
        ...(has('feedback')
          ? {
              reviews: s.learning.reviews().slice(-8),
              submissions: s.learning.submissions().slice(-8),
            }
          : {}),
      };
    }
    case 'profile_update':
      return s.learner.updateProfile(args, refs);
    case 'goal_propose': {
      const g = s.learner.proposeGoal(args, refs);
      s.conversation.expire((i) => i.kind === 'goal', runId);
      return { goalProposalId: g.id, summary: g.direction, revision: g.revision };
    }
    case 'plan_save': {
      assert(
        s.learner.state().goal?.id === args.goalId,
        'GOAL_NOT_CONFIRMED',
        '请先让用户确认职业目标。',
        409,
      );
      const p = s.planning.saveDraft(args);
      s.conversation.expire((i) => i.kind === 'plan' && i.targetId === p.id, runId);
      return { planId: p.id, version: p.version, status: p.status, changeSummary: p.reason };
    }
    case 'task_upsert': {
      const t = s.planning.upsertTask(args);
      return { taskId: t.id, revision: t.revision, status: t.status, task: t };
    }
    case 'submission_save':
      return saveSubmission(s, conversationId, args);
    case 'submission_get':
      return s.learning.getSubmission(args.submissionId);
    case 'review_save':
      return saveReview(s, args);
    case 'interaction_request': {
      let data: any;
      if (args.kind === 'questions') {
        assert(
          new Set(args.questions.map((q: any) => q.id)).size === args.questions.length &&
            args.questions.every(
              (q: any) => new Set(q.options.map((o: any) => o.id)).size === q.options.length,
            ),
          'DUPLICATE_QUESTION',
          '问题和选项标识不能重复。',
        );
        data = {
          kind: 'questions',
          title: args.title,
          summary: '也可以填写自己的回答。',
          questions: args.questions,
        };
      } else if (args.kind === 'goal') {
        const goal = s.learner.getGoal(args.goalProposalId);
        assert(goal?.status === 'draft', 'STALE_PROPOSAL', '目标草案已失效。', 409);
        data = {
          kind: 'goal',
          title: '确认职业目标',
          summary: `${goal.direction}\n${goal.reason}`,
          targetId: goal.id,
          targetVersion: goal.revision,
          proposal: goal,
        };
      } else {
        const plan = s.planning.getPlan(args.planId, args.version);
        assert(
          plan?.status === 'draft' && plan.goalId === s.learner.state().goal?.id,
          'STALE_PROPOSAL',
          '计划草案已失效。',
          409,
        );
        data = {
          kind: 'plan',
          title: `确认学习计划 · 第 ${plan.version} 版`,
          summary: `每周 ${plan.weeklyBudgetMinutes} 分钟\n${plan.reason}`,
          targetId: plan.id,
          targetVersion: plan.version,
          proposal: plan,
        };
      }
      const i = s.conversation.requestInteraction({ ...data, conversationId, runId });
      return { interactionId: i.id, status: i.status };
    }
  }
}
