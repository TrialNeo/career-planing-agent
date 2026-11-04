// Explicit test-only carrier. Production always defaults to PiRunner; no simulated mode is exposed in the UI.
import { createApp } from '../apps/server/src/app.js';
import type { AgentRunner } from '../apps/server/src/platform/agent/index.js';
const runner: AgentRunner = {
  async run(ctx) {
    const current: any = await ctx.callTool('user_state_get', 'state', { sections: ['all'] });
    const last = ctx.messages.filter((m) => m.role === 'user').at(-1)!;
    if (!current.goal) {
      await ctx.callTool('profile_update', 'profile', {
        changes: [
          {
            field: 'weeklyBudgetMinutes',
            value: 240,
            evidenceRefs: [last.id],
            evidenceType: 'user_statement',
          },
        ],
      });
      await ctx.callTool('knowledge_search', 'knowledge', { kinds: ['directions'], limit: 2 });
      const goal: any = await ctx.callTool('goal_propose', 'goal', {
        direction: '后端开发方向',
        reason: '基于你对后端的兴趣和每周四小时的投入。',
        evidenceRefs: [last.id],
      });
      ctx.emitText('先确认适合你的职业目标。');
      await ctx.callTool('interaction_request', 'goal-card', {
        kind: 'goal',
        goalProposalId: goal.goalProposalId,
      });
    } else if (!current.plans.some((p: any) => p.status === 'active')) {
      const latest = current.plans.at(-1);
      const plan: any = await ctx.callTool('plan_save', 'plan', {
        goalId: current.goal.id,
        ...(latest ? { baseVersion: latest.version } : {}),
        milestones: [
          {
            id: 'api',
            title: '实现第一个 HTTP API',
            deliverable: '接口代码与说明',
            criteria: [{ id: 'explain', description: '说明路由如何处理请求' }],
          },
        ],
        weeklyBudgetMinutes: 240,
        reason: '先用一周验证后端兴趣，再根据反馈调整。',
      });
      ctx.emitText('这是可以按周滚动调整的学习计划。');
      await ctx.callTool('interaction_request', 'plan-card', {
        kind: 'plan',
        planId: plan.planId,
        version: plan.version,
      });
    } else if (!current.tasks.length) {
      const task: any = await ctx.callTool('task_upsert', 'task', {
        planVersion: current.plans.find((p: any) => p.status === 'active').version,
        purpose: '理解 HTTP 路由',
        deliverable: '接口代码与说明',
        criteria: [{ id: 'explain', description: '说明路由如何处理请求' }],
        estimatedMinutes: 60,
      });
      ctx.emitText(
        `本周行动已保存：${task.task.purpose}。预计 60 分钟，完成后把代码和说明发到这里。`,
      );
    } else if (last.text.includes('成果')) {
      const task = current.tasks.find((t: any) => ['planned', 'needs_work'].includes(t.status));
      const submission: any = await ctx.callTool('submission_save', 'submission', {
        taskId: task.id,
        evidenceMessageIds: [last.id],
        actualMinutes: 45,
      });
      await ctx.callTool('review_save', 'review', {
        submissionId: submission.submissionId,
        criteriaResults: [
          {
            criterionId: 'explain',
            result: '符合',
            reason: '内容说明了路由，未执行代码。',
            evidenceMessageIds: [last.id],
          },
        ],
        skillEvidence: [
          {
            skill: 'HTTP 路由',
            level: '能解释请求处理',
            evidenceMessageIds: [last.id],
            basis: 'content_review',
          },
        ],
        nextAction: '补充参数校验',
      });
      ctx.emitText('成果已登记，内容审阅符合标准。下一步：补充参数校验。');
    } else ctx.emitText('已恢复长期计划与学习记录，可以继续行动。');
  },
};
export function createE2eApplication() {
  return createApp({ databasePath: ':memory:', runner, importKnowledge: true });
}
