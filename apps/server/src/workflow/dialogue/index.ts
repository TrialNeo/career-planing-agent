import type { Message, SourceRef } from '@career/contracts';
import type { AgentRunner } from '../../platform/agent/index.js';
import { id } from '../../platform/runtime/index.js';
import { AppError, assert, publicError } from '../../platform/http/errors.js';
import type { Services } from '../services.js';
import { toolDefinitions, executeTool } from './tools.js';
import { systemPrompt } from './prompt.js';
export class Dialogue {
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  constructor(
    private s: Services,
    private runner: AgentRunner,
  ) {}
  send(conversationId: string, input: { clientRequestId: string; text: string }) {
    const response = this.s.db.transaction(() =>
      this.s.conversation.deduplicate(
        `message:${conversationId}`,
        input.clientRequestId,
        input,
        () => {
          this.s.conversation.get(conversationId);
          const run = this.s.conversation.createRun(conversationId);
          const message = this.s.conversation.addMessage(conversationId, 'user', input.text);
          return { messageId: message.id, runId: run.id };
        },
      ),
    );
    if (!response.replayed) this.launch(response.result.runId);
    return response.result;
  }
  launch(runId: string) {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    // Start after the HTTP transaction has committed; a model request never holds a transaction.
    const job = Promise.resolve()
      .then(() => this.execute(runId, controller))
      .finally(() => {
        this.controllers.delete(runId);
        this.jobs.delete(runId);
      });
    this.jobs.set(runId, job);
  }
  private async execute(runId: string, controller: AbortController) {
    const s = this.s;
    const run = s.conversation.getRun(runId);
    let messageId: string = id();
    let text = '';
    let sources: SourceRef[] = [];
    const flush = () => {
      if (text) {
        const message = s.conversation.addMessage(
          run.conversationId,
          'assistant',
          text,
          messageId,
          sources,
        );
        s.conversation.append(runId, 'message.completed', { message });
        text = '';
        messageId = id();
        sources = [];
      }
    };
    const timeout = setTimeout(() => controller.abort('timeout'), 180000);
    try {
      if (controller.signal.aborted) throw new AppError('CANCELLED', '运行已停止。');
      s.conversation.setStatus(runId, 'running');
      s.conversation.append(runId, 'run.started', { runId });
      const all = s.conversation.messages(run.conversationId);
      const recent = all.slice(-40);
      const summary = all
        .slice(0, -40)
        .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
        .slice(-30)
        .join('\n');
      if (summary)
        s.db.put('conversation_summary', run.conversationId, {
          text: summary,
          throughMessageId: all.at(-41)?.id,
        });
      const overdue = s.planning
        .tasks()
        .filter(
          (t) =>
            t.dueAt &&
            Date.parse(t.dueAt) < Date.now() &&
            !['completed', 'superseded'].includes(t.status),
        );
      const state = {
        ...s.learner.state(),
        plans: s.planning.plans(),
        tasks: s.planning.tasks(),
        recentReviews: s.learning.reviews().slice(-5),
        pendingInteraction: s.conversation.pending(run.conversationId),
        overdue,
      };
      await this.runner.run({
        messages: recent,
        systemPrompt: `${systemPrompt}\n当前业务状态：\n${JSON.stringify(state)}\n历史片段（不作为确认事实）：\n${summary || '无'}`,
        tools: toolDefinitions,
        signal: controller.signal,
        credentials: s.settings.credentials(),
        emitText: (delta) => {
          if (controller.signal.aborted) return;
          text += delta;
          s.conversation.append(runId, 'message.delta', { messageId, delta });
        },
        completeMessage: flush,
        shouldStop: () => s.conversation.pending(run.conversationId)?.runId === runId,
        callTool: async (name, callId, args) => {
          assert(!controller.signal.aborted, 'CANCELLED', '运行已停止。', 409);
          const input = JSON.stringify({ name, args });
          const old = s.db.sql
            .prepare('SELECT input,result FROM tool_calls WHERE run_id=? AND call_id=?')
            .get(runId, callId) as { input: string; result: string } | undefined;
          if (old) {
            assert(old.input === input, 'TOOL_ID_CONFLICT', '工具调用标识重复且参数不同。', 409);
            return JSON.parse(old.result);
          }
          assert(
            s.conversation.pending(run.conversationId)?.runId !== runId,
            'INTERACTION_PENDING',
            '请先等待用户回答卡片。',
            409,
          );
          s.conversation.append(runId, 'tool.started', {
            toolCallId: callId,
            label: toolDefinitions.find((t) => t.name === name)?.description ?? name,
          });
          try {
            const result: any = s.db.transaction(() => {
              const result = executeTool(s, run.conversationId, runId, name, args);
              s.db.sql
                .prepare('INSERT INTO tool_calls VALUES(?,?,?,?)')
                .run(runId, callId, input, JSON.stringify(result));
              return result;
            });
            if (name === 'knowledge_search' && result?.sources) sources.push(...result.sources);
            s.conversation.append(runId, 'tool.completed', {
              toolCallId: callId,
              status: 'completed',
              summary: '已完成',
            });
            return result;
          } catch (e) {
            s.conversation.append(runId, 'tool.completed', {
              toolCallId: callId,
              status: 'failed',
              summary: publicError(e).message,
            });
            throw e;
          }
        },
      });
      flush();
      const status = controller.signal.aborted
        ? 'cancelled'
        : s.conversation.pending(run.conversationId)
          ? 'waiting_input'
          : 'completed';
      if (controller.signal.reason === 'timeout')
        throw new AppError('RUN_TIMEOUT', '模型响应超时，请重试。', 504, true);
      s.conversation.setStatus(runId, status);
      s.conversation.append(runId, 'run.finished', { status });
    } catch (e) {
      flush();
      const cancelled = controller.signal.aborted && controller.signal.reason !== 'timeout';
      const error =
        controller.signal.reason === 'timeout'
          ? { code: 'RUN_TIMEOUT', message: '模型响应超时，请重试。', retryable: true }
          : publicError(e);
      s.conversation.setStatus(
        runId,
        cancelled ? 'cancelled' : 'failed',
        cancelled ? undefined : error,
      );
      s.conversation.append(runId, 'run.finished', {
        status: cancelled ? 'cancelled' : 'failed',
        ...(cancelled ? {} : { error }),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  cancel(runId: string) {
    const run = this.s.conversation.getRun(runId);
    if (['queued', 'running', 'cancelling'].includes(run.status)) {
      this.s.conversation.setStatus(runId, 'cancelling');
      this.controllers.get(runId)?.abort('user');
    }
    return { runId, status: this.s.conversation.getRun(runId).status };
  }
  async close() {
    for (const c of this.controllers.values()) c.abort('shutdown');
    await Promise.allSettled(this.jobs.values());
  }
}
