import type {
  ImplementationCheckDefinition,
  ImplementationCheckResult,
} from "../services/checks/contracts";
import type {
  ReadinessEvaluation,
  ReadinessInput,
} from "../services/readiness/contracts";
import type { ReadinessDecision } from "../workflows/implementation/steps/readiness/readiness.definition";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "completed"
  | "failed";

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

export type ReadinessEvaluationResult = ReadinessEvaluation<ReadinessDecision>;

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

export type ImplementationStage =
  | "preparing"
  | "implementing"
  | "checking"
  | "snapshotting"
  | "reviewing"
  | "publishing"
  | "completed";

export interface ImplementationAttemptRecord {
  id: number;
  runId: string;
  attempt: number;
  status: "running" | "success" | "error";
  stage: ImplementationStage;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string | null;
  codexThreadId: string | null;
  goal: string;
  modelBaseUrl: string;
  modelId: string;
  promptVersion: string;
  checks: ImplementationCheckDefinition[];
  checkResults: ImplementationCheckResult[] | null;
  finalResponse: string | null;
  review: unknown;
  commitSha: string | null;
  pullRequestUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface IngestResult {
  outcome: "created" | "attached" | "resume_requested" | "duplicate" | "ignored";
  runId: string | null;
}
