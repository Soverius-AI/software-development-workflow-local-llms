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
  pendingQuestion: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface IngestResult {
  outcome: "created" | "attached" | "resume_requested" | "duplicate" | "ignored";
  runId: string | null;
}
