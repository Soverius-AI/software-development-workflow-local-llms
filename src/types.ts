export type RunStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "completed"
  | "failed";

export interface NormalizedGitHubEvent {
  deliveryId: string;
  eventName: string;
  action: string | null;
  repository: string;
  correlationKey: string;
  issueNumber: number | null;
  senderLogin: string | null;
  isHumanComment: boolean;
  commentBody: string | null;
  requiresHuman: boolean;
  payload: unknown;
}

export interface WorkflowRunRecord {
  id: string;
  correlationKey: string;
  repository: string;
  issueNumber: number | null;
  status: RunStatus;
  mastraRunId: string | null;
  pendingStep: string | null;
  pendingQuestion: string | null;
  answerAfterEventId: number | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface GitHubCommentOutboxRecord {
  id: number;
  runId: string;
  repository: string;
  issueNumber: number;
  body: string;
  marker: string;
  status: "pending" | "sending" | "retry" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: string;
  githubCommentId: number | null;
  githubCommentUrl: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface ReadinessInput {
  controlRunId: string;
  correlationKey: string;
  repository: string;
  issueNumber: number | null;
  title: string;
  body: string;
  labels: string[];
  clarifications: string[];
}

export interface ReadinessDecision {
  ready: boolean;
  summary: string;
  acceptanceCriteria: string[];
  missingInformation: string[];
  question: string | null;
}

export interface ReadinessEvaluationResult {
  decision: ReadinessDecision;
  modelId: string;
  promptVersion: string;
  traceId: string | null;
  finishReason: string | null;
  usage: unknown;
}

export interface ReadinessEvaluationRecord {
  id: number;
  runId: string;
  attempt: number;
  status: "running" | "success" | "error";
  input: ReadinessInput;
  output: ReadinessEvaluationResult | null;
  modelId: string;
  promptVersion: string;
  graphVersion: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface IngestResult {
  outcome: "created" | "attached" | "resume_requested" | "duplicate" | "ignored";
  runId: string | null;
}
