export type Id = string;
export type AuthUser = { id: Id; username: string; createdAt: string };
export type AuthState = { user: AuthUser | null; firstAccount: boolean };
export type ApiError = { code: string; message: string; retryable: boolean };
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export type Run = {
  id: Id;
  conversationId: Id;
  status: RunStatus;
  lastSequence: number;
  createdAt: string;
  error?: ApiError;
};
export type SourceRef = {
  datasetVersion: string;
  sheet: string;
  row: number;
  source: string | null;
  url: string | null;
  collectedAt: string | null;
};
export type Message = {
  id: Id;
  conversationId: Id;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  sources?: SourceRef[];
};
export type Conversation = { id: Id; title: string; createdAt: string; updatedAt: string };
export type Question = {
  id: string;
  title: string;
  multiple?: boolean;
  options: { id: string; label: string }[];
};
export type Interaction = {
  id: Id;
  conversationId: Id;
  runId: Id;
  status: 'pending' | 'answered' | 'confirmed' | 'changes_requested' | 'rejected' | 'expired';
  kind: 'questions' | 'goal' | 'plan';
  title: string;
  summary: string;
  questions?: Question[];
  targetId?: Id;
  targetVersion?: number;
  proposal?: unknown;
  createdAt: string;
};
export type InteractionAnswer = { clientRequestId: string } & (
  | { kind: 'answers'; answers: { questionId: string; optionIds: string[]; text?: string }[] }
  | { kind: 'decision'; action: 'confirm' | 'request_changes' | 'reject'; comment?: string }
);
export type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
  nextCursor: string | null;
  pendingInteraction: Interaction | null;
  activeRun: Run | null;
  interactions: Interaction[];
  reminders?: { taskId: string; purpose: string; dueAt: string }[];
};
export type ModelTest = {
  ok: boolean;
  checks: { name: string; ok: boolean }[];
  latencyMs: number;
  error?: ApiError;
};
export type StreamPayloads = {
  'run.started': { runId: string };
  'message.delta': { messageId: string; delta: string };
  'message.completed': { message: Message };
  'tool.started': { toolCallId: string; label: string };
  'tool.completed': { toolCallId: string; status: 'completed' | 'failed'; summary: string };
  'interaction.requested': { interaction: Interaction };
  'interaction.updated': { interactionId: string; status: Interaction['status'] };
  'run.finished': { status: RunStatus; error?: ApiError };
};
export type StreamEvent = {
  [K in keyof StreamPayloads]: {
    type: K;
    runId: string;
    sequence: number;
    timestamp: string;
    data: StreamPayloads[K];
  };
}[keyof StreamPayloads];
export type GoalProposal = {
  id: string;
  direction: string;
  reason: string;
  evidenceRefs: string[];
  status: 'draft' | 'confirmed' | 'superseded' | 'rejected';
  revision: number;
};
export type Criterion = { id: string; description: string };
export type Milestone = { id: string; title: string; deliverable: string; criteria: Criterion[] };
export type Plan = {
  id: string;
  goalId: string;
  version: number;
  status: 'draft' | 'active' | 'superseded' | 'rejected';
  milestones: Milestone[];
  weeklyBudgetMinutes: number;
  reason: string;
};
export type Task = {
  id: string;
  revision: number;
  planId: string;
  planVersion: number;
  purpose: string;
  deliverable: string;
  criteria: Criterion[];
  estimatedMinutes: number;
  dueAt?: string;
  status: 'planned' | 'in_progress' | 'pending_review' | 'completed' | 'needs_work' | 'superseded';
};
export type Submission = {
  id: string;
  taskId: string;
  taskRevision: number;
  evidenceMessageIds: string[];
  materials: Message[];
  actualMinutes?: number;
  difficulties?: string;
  reflection?: string;
  createdAt: string;
};
export type CriterionResult = {
  criterionId: string;
  result: '符合' | '未符合' | '证据不足';
  reason: string;
  evidenceMessageIds: string[];
};
export type SkillEvidence = {
  skill: string;
  level: string;
  evidenceMessageIds: string[];
  basis: 'content_review';
};
export type Review = {
  id: string;
  submissionId: string;
  criteriaResults: CriterionResult[];
  skillEvidence: SkillEvidence[];
  nextAction: string;
  createdAt: string;
};
