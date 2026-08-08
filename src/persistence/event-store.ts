import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  IngestResult,
  GitHubCommentOutboxRecord,
  ImplementationAttemptRecord,
  ImplementationStage,
  ReadinessEvaluationRecord,
  ReadinessEvaluationResult,
  RunStatus,
  WorkflowRunRecord,
} from "./records";
import type {
  ImplementationCheckDefinition,
  ImplementationCheckResult,
} from "../services/checks/contracts";
import type { NormalizedGitHubEvent } from "../services/github/contracts";
import type { ReadinessInput } from "../services/readiness/contracts";

const ACTIVE_STATUSES = "'queued','running','waiting_human'";

export class EventStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        correlation_key TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER,
        status TEXT NOT NULL,
        mastra_run_id TEXT,
        pending_step TEXT,
        pending_question TEXT,
        answer_after_event_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_correlation
        ON workflow_runs(correlation_key)
        WHERE status IN (${ACTIVE_STATUSES});

      CREATE TABLE IF NOT EXISTS github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        action TEXT,
        repository TEXT NOT NULL,
        correlation_key TEXT NOT NULL,
        issue_number INTEGER,
        sender_login TEXT,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        state TEXT NOT NULL,
        workflow_run_id TEXT REFERENCES workflow_runs(id),
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        delivery_id TEXT NOT NULL UNIQUE REFERENCES github_deliveries(delivery_id),
        kind TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS readiness_evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        graph_version TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(run_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS github_comment_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        body TEXT NOT NULL,
        marker TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        github_comment_id INTEGER,
        github_comment_url TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS github_comment_outbox_due
        ON github_comment_outbox(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS implementation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_sha TEXT,
        codex_thread_id TEXT,
        goal TEXT NOT NULL,
        model_base_url TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        checks_json TEXT NOT NULL DEFAULT '[]',
        check_results_json TEXT,
        final_response TEXT,
        review_json TEXT,
        commit_sha TEXT,
        pull_request_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(run_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS implementation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL REFERENCES implementation_attempts(id),
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS implementation_events_attempt
        ON implementation_events(attempt_id, id);
    `);
    const runColumns = this.db
      .prepare("PRAGMA table_info(workflow_runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "pending_step")) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN pending_step TEXT");
    }
    if (!runColumns.some((column) => column.name === "answer_after_event_id")) {
      this.db.exec(
        "ALTER TABLE workflow_runs ADD COLUMN answer_after_event_id INTEGER",
      );
    }
    const readinessColumns = this.db
      .prepare("PRAGMA table_info(readiness_evaluations)")
      .all() as Array<{ name: string }>;
    if (!readinessColumns.some((column) => column.name === "graph_version")) {
      this.db.exec(
        "ALTER TABLE readiness_evaluations ADD COLUMN graph_version TEXT NOT NULL DEFAULT 'production-v1'",
      );
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE workflow_runs
         SET answer_after_event_id = (
           SELECT COALESCE(MAX(id), 0) FROM run_events
           WHERE run_id = workflow_runs.id
         )
         WHERE status = 'waiting_human' AND answer_after_event_id IS NULL`,
      )
      .run();
    const waitingRuns = this.db
      .prepare(
        `SELECT id, repository, issue_number, pending_question
         FROM workflow_runs
         WHERE status = 'waiting_human' AND issue_number IS NOT NULL
           AND pending_question IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM github_comment_outbox
             WHERE run_id = workflow_runs.id
           )`,
      )
      .all() as Array<{
      id: string;
      repository: string;
      issue_number: number;
      pending_question: string;
    }>;
    for (const run of waitingRuns) {
      const marker = `<!-- mastra-loop:${run.id}:readiness:recovered -->`;
      const body = `### Readiness needs clarification\n\n${run.pending_question}\n\nReply to this issue with the missing details. The same implementation run will continue.\n\n${marker}`;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO github_comment_outbox
           (run_id, repository, issue_number, body, marker, status, attempts,
            next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.repository,
          run.issue_number,
          body,
          marker,
          now,
          now,
          now,
        );
    }
    this.db
      .prepare(
        `UPDATE github_comment_outbox
         SET status = 'retry', next_attempt_at = ?, updated_at = ?
         WHERE status = 'sending'`,
      )
      .run(now, now);
    this.recoverInterruptedRuns(now);
  }

  private recoverInterruptedRuns(now: string): void {
    const interrupted = this.db
      .prepare(
        `SELECT id, repository, issue_number FROM workflow_runs
         WHERE status = 'running'`,
      )
      .all() as Array<{
      id: string;
      repository: string;
      issue_number: number | null;
    }>;
    for (const run of interrupted) {
      const error =
        "The implementer process stopped while this run was active. Its worktree was retained for diagnosis; the run was not retried automatically.";
      this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'failed', last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(error, now, run.id);
      this.db
        .prepare(
          `UPDATE implementation_attempts
           SET status = 'error', error = ?, completed_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(error, now, run.id);
      if (run.issue_number !== null) {
        const marker = `<!-- mastra-loop:${run.id}:implementation:interrupted -->`;
        this.insertGitHubCommentOutbox(
          run.id,
          run.repository,
          run.issue_number,
          formatImplementationFailureComment("interrupted", error, marker),
          marker,
          now,
        );
      }
    }
  }

  ingest(event: NormalizedGitHubEvent, botLogin: string): IngestResult {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.db
        .prepare("SELECT 1 FROM github_deliveries WHERE delivery_id = ?")
        .get(event.deliveryId);
      if (exists) {
        this.db.exec("COMMIT");
        return { outcome: "duplicate", runId: null };
      }

      const selfGenerated =
        event.senderLogin === botLogin ||
        event.commentBody?.includes("<!-- mastra-loop:") === true;
      if (selfGenerated) {
        this.insertDelivery(event, now, "ignored", null, "self-generated event");
        this.db.exec("COMMIT");
        return { outcome: "ignored", runId: null };
      }

      const active = this.db
        .prepare(
          `SELECT * FROM workflow_runs
           WHERE correlation_key = ? AND status IN (${ACTIVE_STATUSES})
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(event.correlationKey) as Record<string, unknown> | undefined;

      if (active) {
        const runId = String(active.id);
        this.insertDelivery(event, now, "attached", runId, null);
        this.insertRunEvent(runId, event, now);
        this.db.exec("COMMIT");
        return {
          outcome:
            active.status === "waiting_human" && event.isHumanComment
              ? "resume_requested"
              : "attached",
          runId,
        };
      }

      const runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO workflow_runs
           (id, correlation_key, repository, issue_number, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          runId,
          event.correlationKey,
          event.repository,
          event.issueNumber,
          now,
          now,
        );
      this.insertDelivery(event, now, "accepted", runId, null);
      this.insertRunEvent(runId, event, now);
      this.db.exec("COMMIT");
      return { outcome: "created", runId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertDelivery(
    event: NormalizedGitHubEvent,
    now: string,
    state: string,
    runId: string | null,
    reason: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO github_deliveries
         (delivery_id, event_name, action, repository, correlation_key, issue_number,
          sender_login, payload_json, received_at, state, workflow_run_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.deliveryId,
        event.eventName,
        event.action,
        event.repository,
        event.correlationKey,
        event.issueNumber,
        event.senderLogin,
        JSON.stringify(event.payload),
        now,
        state,
        runId,
        reason,
      );
  }

  private insertRunEvent(
    runId: string,
    event: NormalizedGitHubEvent,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, delivery_id, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        event.deliveryId,
        event.isHumanComment ? "human_comment" : event.eventName,
        event.commentBody,
        now,
      );
  }

  claimNextRun(): WorkflowRunRecord | null {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM workflow_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
        )
        .get() as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          "UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(now, String(row.id));
      this.db.exec("COMMIT");
      return this.mapRun({ ...row, status: "running", updated_at: now });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimWaitingRunWithAnswer(): WorkflowRunRecord | null {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT wr.* FROM workflow_runs wr
           WHERE wr.status = 'waiting_human'
             AND EXISTS (
               SELECT 1 FROM run_events re
               WHERE re.run_id = wr.id AND re.kind = 'human_comment'
                 AND re.state = 'queued'
                 AND re.id > COALESCE(wr.answer_after_event_id, 0)
             )
           ORDER BY wr.updated_at LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          "UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(now, String(row.id));
      this.db.exec("COMMIT");
      return this.mapRun({ ...row, status: "running", updated_at: now });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getReadinessInput(runId: string): ReadinessInput {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Workflow run ${runId} does not exist.`);
    const rows = this.db
      .prepare(
        `SELECT gd.event_name, gd.payload_json
         FROM run_events re
         JOIN github_deliveries gd ON gd.delivery_id = re.delivery_id
         WHERE re.run_id = ? ORDER BY re.id`,
      )
      .all(runId) as Array<{ event_name: string; payload_json: string }>;

    let title = "";
    let body = "";
    let labels: string[] = [];
    const clarifications: string[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, any>;
      const workItem = payload.issue ?? payload.pull_request;
      if (typeof workItem?.title === "string") title = workItem.title;
      if (typeof workItem?.body === "string") body = workItem.body;
      if (Array.isArray(workItem?.labels)) {
        labels = workItem.labels.flatMap((label: unknown) => {
          if (typeof label === "string") return [label];
          if (
            typeof label === "object" &&
            label !== null &&
            typeof (label as { name?: unknown }).name === "string"
          ) {
            return [(label as { name: string }).name];
          }
          return [];
        });
      }
      if (
        row.event_name === "issue_comment" &&
        typeof payload.comment?.body === "string"
      ) {
        clarifications.push(payload.comment.body);
      }
    }

    return {
      controlRunId: run.id,
      correlationKey: run.correlationKey,
      repository: run.repository,
      issueNumber: run.issueNumber,
      title,
      body,
      labels,
      clarifications,
    };
  }

  startReadinessEvaluation(
    runId: string,
    input: ReadinessInput,
    modelId: string,
    promptVersion: string,
    graphVersion: string,
  ): number {
    const attemptRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
         FROM readiness_evaluations WHERE run_id = ?`,
      )
      .get(runId) as { attempt: number };
    const result = this.db
      .prepare(
        `INSERT INTO readiness_evaluations
         (run_id, attempt, status, input_json, model_id, prompt_version,
          graph_version, created_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        attemptRow.attempt,
        JSON.stringify(input),
        modelId,
        promptVersion,
        graphVersion,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  completeReadinessEvaluation(
    evaluationId: number,
    output: ReadinessEvaluationResult,
  ): void {
    this.db
      .prepare(
        `UPDATE readiness_evaluations
         SET status = 'success', output_json = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(output), new Date().toISOString(), evaluationId);
  }

  failReadinessEvaluation(evaluationId: number, error: unknown): void {
    this.db
      .prepare(
        `UPDATE readiness_evaluations
         SET status = 'error', error = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        evaluationId,
      );
  }

  listReadinessEvaluations(runId: string): ReadinessEvaluationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM readiness_evaluations
         WHERE run_id = ? ORDER BY attempt`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      attempt: Number(row.attempt),
      status: String(row.status) as ReadinessEvaluationRecord["status"],
      input: JSON.parse(String(row.input_json)) as ReadinessInput,
      output:
        row.output_json === null
          ? null
          : (JSON.parse(String(row.output_json)) as ReadinessEvaluationResult),
      modelId: String(row.model_id),
      promptVersion: String(row.prompt_version),
      graphVersion: String(row.graph_version),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      completedAt:
        row.completed_at === null ? null : String(row.completed_at),
    }));
  }

  startImplementationAttempt(input: {
    runId: string;
    repositoryPath: string;
    worktreePath: string;
    branch: string;
    goal: string;
    modelBaseUrl: string;
    modelId: string;
    promptVersion: string;
  }): number {
    const attemptRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
         FROM implementation_attempts WHERE run_id = ?`,
      )
      .get(input.runId) as { attempt: number };
    const result = this.db
      .prepare(
        `INSERT INTO implementation_attempts
         (run_id, attempt, status, stage, repository_path, worktree_path,
          branch, goal, model_base_url, model_id, prompt_version, created_at)
         VALUES (?, ?, 'running', 'preparing', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        attemptRow.attempt,
        input.repositoryPath,
        input.worktreePath,
        input.branch,
        input.goal,
        input.modelBaseUrl,
        input.modelId,
        input.promptVersion,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  configureImplementationAttempt(
    id: number,
    baseSha: string,
    checks: ImplementationCheckDefinition[],
  ): void {
    this.db
      .prepare(
        `UPDATE implementation_attempts SET base_sha = ?, checks_json = ?
         WHERE id = ?`,
      )
      .run(baseSha, JSON.stringify(checks), id);
  }

  setImplementationStage(id: number, stage: ImplementationStage): void {
    this.db
      .prepare(
        `UPDATE implementation_attempts SET stage = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(stage, id);
  }

  setCodexThreadId(id: number, threadId: string): void {
    this.db
      .prepare(
        "UPDATE implementation_attempts SET codex_thread_id = ? WHERE id = ?",
      )
      .run(threadId, id);
  }

  appendImplementationEvent(id: number, event: unknown): void {
    this.db
      .prepare(
        `INSERT INTO implementation_events (attempt_id, event_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(id, JSON.stringify(event), new Date().toISOString());
  }

  completeCodexImplementation(id: number, finalResponse: string): void {
    this.db
      .prepare(
        "UPDATE implementation_attempts SET final_response = ? WHERE id = ?",
      )
      .run(finalResponse, id);
  }

  recordImplementationCheck(
    id: number,
    result: ImplementationCheckResult,
  ): void {
    const row = this.db
      .prepare("SELECT check_results_json FROM implementation_attempts WHERE id = ?")
      .get(id) as { check_results_json: string | null } | undefined;
    if (!row) throw new Error(`Implementation attempt ${id} does not exist.`);
    const results = row.check_results_json
      ? (JSON.parse(row.check_results_json) as ImplementationCheckResult[])
      : [];
    results.push(result);
    this.db
      .prepare(
        "UPDATE implementation_attempts SET check_results_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(results), id);
  }

  recordImplementationSnapshot(id: number, commitSha: string): void {
    this.db
      .prepare("UPDATE implementation_attempts SET commit_sha = ? WHERE id = ?")
      .run(commitSha, id);
  }

  recordStubReview(id: number, review: unknown): void {
    this.db
      .prepare("UPDATE implementation_attempts SET review_json = ? WHERE id = ?")
      .run(JSON.stringify(review), id);
  }

  completeImplementationAttempt(id: number, pullRequestUrl: string): void {
    this.db
      .prepare(
        `UPDATE implementation_attempts
         SET status = 'success', stage = 'completed', pull_request_url = ?,
           error = NULL, completed_at = ? WHERE id = ?`,
      )
      .run(pullRequestUrl, new Date().toISOString(), id);
  }

  failImplementationAttempt(id: number, error: unknown): void {
    this.db
      .prepare(
        `UPDATE implementation_attempts
         SET status = 'error', error = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(errorMessage(error), new Date().toISOString(), id);
  }

  getImplementationAttempt(id: number): ImplementationAttemptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM implementation_attempts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapImplementationAttempt(row) : null;
  }

  getLatestImplementationAttempt(runId: string): ImplementationAttemptRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM implementation_attempts
         WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapImplementationAttempt(row) : null;
  }

  listImplementationAttempts(runId?: string): ImplementationAttemptRecord[] {
    const rows = (runId
      ? this.db
          .prepare(
            "SELECT * FROM implementation_attempts WHERE run_id = ? ORDER BY attempt",
          )
          .all(runId)
      : this.db
          .prepare("SELECT * FROM implementation_attempts ORDER BY id")
          .all()) as Record<string, unknown>[];
    return rows.map((row) => this.mapImplementationAttempt(row));
  }

  failRunAndEnqueueComment(runId: string, error: unknown): boolean {
    const now = new Date().toISOString();
    const message = errorMessage(error);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db
        .prepare(
          "SELECT repository, issue_number FROM workflow_runs WHERE id = ?",
        )
        .get(runId) as
        | { repository: string; issue_number: number | null }
        | undefined;
      if (!run) throw new Error(`Workflow run ${runId} does not exist.`);
      const attempt = this.db
        .prepare(
          `SELECT stage FROM implementation_attempts
           WHERE run_id = ? ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId) as { stage: string } | undefined;
      this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'failed', pending_step = NULL,
           pending_question = NULL, answer_after_event_id = NULL,
           last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(message, now, runId);
      this.db
        .prepare(
          `UPDATE implementation_attempts
           SET status = 'error', error = ?, completed_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(message, now, runId);
      let queued = false;
      if (run.issue_number !== null) {
        const stage = attempt?.stage ?? "starting";
        const marker = `<!-- mastra-loop:${runId}:implementation:failed -->`;
        queued = this.insertGitHubCommentOutbox(
          runId,
          run.repository,
          run.issue_number,
          formatImplementationFailureComment(stage, message, marker),
          marker,
          now,
        );
      }
      this.db.exec("COMMIT");
      return queued;
    } catch (caught) {
      this.db.exec("ROLLBACK");
      throw caught;
    }
  }

  getRun(id: string): WorkflowRunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(): WorkflowRunRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC")
        .all() as Record<string, unknown>[]
    ).map((row) => this.mapRun(row));
  }

  setMastraRunId(id: string, mastraRunId: string): void {
    this.db
      .prepare("UPDATE workflow_runs SET mastra_run_id = ?, updated_at = ? WHERE id = ?")
      .run(mastraRunId, new Date().toISOString(), id);
  }

  setStatus(
    id: string,
    status: RunStatus,
    options: {
      step?: string | null;
      question?: string | null;
      error?: string | null;
    } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_runs SET status = ?, pending_step = ?, pending_question = ?,
         answer_after_event_id = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        options.step ?? null,
        options.question ?? null,
        options.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  suspendRunAndEnqueueQuestion(
    id: string,
    options: {
      step: string | null;
      question: string;
      marker: string;
      body: string;
    },
  ): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db
        .prepare(
          `SELECT repository, issue_number,
            (SELECT COALESCE(MAX(id), 0) FROM run_events WHERE run_id = ?) AS boundary
           FROM workflow_runs WHERE id = ?`,
        )
        .get(id, id) as
        | { repository: string; issue_number: number | null; boundary: number }
        | undefined;
      if (!run) throw new Error(`Workflow run ${id} does not exist.`);
      this.db
        .prepare(
          `UPDATE workflow_runs
           SET status = 'waiting_human', pending_step = ?, pending_question = ?,
             answer_after_event_id = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(options.step, options.question, run.boundary, now, id);
      let queued = false;
      if (run.issue_number !== null) {
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO github_comment_outbox
             (run_id, repository, issue_number, body, marker, status, attempts,
              next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          )
          .run(
            id,
            run.repository,
            run.issue_number,
            options.body,
            options.marker,
            now,
            now,
            now,
          );
        queued = result.changes === 1;
      }
      this.db.exec("COMMIT");
      return queued;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeHumanComment(runId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT re.id, re.body FROM run_events re
         JOIN workflow_runs wr ON wr.id = re.run_id
         WHERE re.run_id = ? AND re.kind = 'human_comment'
           AND re.state = 'queued'
           AND re.id > COALESCE(wr.answer_after_event_id, 0)
         ORDER BY re.id LIMIT 1`,
      )
      .get(runId) as { id: number; body: string | null } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE run_events SET state = 'consumed', consumed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    return row.body ?? "Approved via GitHub comment";
  }

  claimNextGitHubComment(now = new Date().toISOString()): GitHubCommentOutboxRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM github_comment_outbox
           WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
           ORDER BY next_attempt_at, id LIMIT 1`,
        )
        .get(now) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const updatedAt = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE github_comment_outbox
           SET status = 'sending', attempts = attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(updatedAt, Number(row.id));
      this.db.exec("COMMIT");
      return this.mapGitHubCommentOutbox({
        ...row,
        status: "sending",
        attempts: Number(row.attempts) + 1,
        updated_at: updatedAt,
      });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeGitHubComment(
    id: number,
    comment: { id: number; url: string },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE github_comment_outbox
         SET status = 'sent', github_comment_id = ?, github_comment_url = ?,
           last_error = NULL, sent_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(comment.id, comment.url, now, now, id);
  }

  failGitHubComment(
    id: number,
    error: unknown,
    maxAttempts: number,
    nextAttemptAt: string,
  ): void {
    const row = this.db
      .prepare("SELECT attempts FROM github_comment_outbox WHERE id = ?")
      .get(id) as { attempts: number } | undefined;
    if (!row) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE github_comment_outbox
         SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        row.attempts >= maxAttempts ? "failed" : "retry",
        nextAttemptAt,
        error instanceof Error ? error.message : String(error),
        now,
        id,
      );
  }

  nextGitHubCommentAt(): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(next_attempt_at) AS next_at FROM github_comment_outbox
         WHERE status IN ('pending', 'retry')`,
      )
      .get() as { next_at: string | null };
    return row.next_at;
  }

  listGitHubCommentOutbox(runId?: string): GitHubCommentOutboxRecord[] {
    const rows = (runId
      ? this.db
          .prepare(
            "SELECT * FROM github_comment_outbox WHERE run_id = ? ORDER BY id",
          )
          .all(runId)
      : this.db.prepare("SELECT * FROM github_comment_outbox ORDER BY id").all()) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.mapGitHubCommentOutbox(row));
  }

  countQueuedEvents(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND state = 'queued'",
      )
      .get(runId) as { count: number };
    return row.count;
  }

  markAllEventsConsumed(runId: string): void {
    this.db
      .prepare(
        `UPDATE run_events SET state = 'consumed', consumed_at = ?
         WHERE run_id = ? AND state = 'queued'`,
      )
      .run(new Date().toISOString(), runId);
  }

  private insertGitHubCommentOutbox(
    runId: string,
    repository: string,
    issueNumber: number,
    body: string,
    marker: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO github_comment_outbox
         (run_id, repository, issue_number, body, marker, status, attempts,
          next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        runId,
        repository,
        issueNumber,
        body,
        marker,
        now,
        now,
        now,
      );
    return result.changes === 1;
  }

  private mapImplementationAttempt(
    row: Record<string, unknown>,
  ): ImplementationAttemptRecord {
    return {
      id: Number(row.id),
      runId: String(row.run_id),
      attempt: Number(row.attempt),
      status: String(row.status) as ImplementationAttemptRecord["status"],
      stage: String(row.stage) as ImplementationStage,
      repositoryPath: String(row.repository_path),
      worktreePath: String(row.worktree_path),
      branch: String(row.branch),
      baseSha: row.base_sha === null ? null : String(row.base_sha),
      codexThreadId:
        row.codex_thread_id === null ? null : String(row.codex_thread_id),
      goal: String(row.goal),
      modelBaseUrl: String(row.model_base_url),
      modelId: String(row.model_id),
      promptVersion: String(row.prompt_version),
      checks: JSON.parse(String(row.checks_json)) as ImplementationCheckDefinition[],
      checkResults:
        row.check_results_json === null
          ? null
          : (JSON.parse(String(row.check_results_json)) as ImplementationCheckResult[]),
      finalResponse:
        row.final_response === null ? null : String(row.final_response),
      review:
        row.review_json === null ? null : JSON.parse(String(row.review_json)),
      commitSha: row.commit_sha === null ? null : String(row.commit_sha),
      pullRequestUrl:
        row.pull_request_url === null ? null : String(row.pull_request_url),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      completedAt:
        row.completed_at === null ? null : String(row.completed_at),
    };
  }

  private mapRun(row: Record<string, unknown>): WorkflowRunRecord {
    return {
      id: String(row.id),
      correlationKey: String(row.correlation_key),
      repository: String(row.repository),
      issueNumber: row.issue_number === null ? null : Number(row.issue_number),
      status: String(row.status) as RunStatus,
      mastraRunId: row.mastra_run_id === null ? null : String(row.mastra_run_id),
      pendingStep:
        row.pending_step === null ? null : String(row.pending_step),
      pendingQuestion:
        row.pending_question === null ? null : String(row.pending_question),
      answerAfterEventId:
        row.answer_after_event_id === null
          ? null
          : Number(row.answer_after_event_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastError: row.last_error === null ? null : String(row.last_error),
    };
  }

  private mapGitHubCommentOutbox(
    row: Record<string, unknown>,
  ): GitHubCommentOutboxRecord {
    return {
      id: Number(row.id),
      runId: String(row.run_id),
      repository: String(row.repository),
      issueNumber: Number(row.issue_number),
      body: String(row.body),
      marker: String(row.marker),
      status: String(row.status) as GitHubCommentOutboxRecord["status"],
      attempts: Number(row.attempts),
      nextAttemptAt: String(row.next_attempt_at),
      githubCommentId:
        row.github_comment_id === null ? null : Number(row.github_comment_id),
      githubCommentUrl:
        row.github_comment_url === null ? null : String(row.github_comment_url),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      sentAt: row.sent_at === null ? null : String(row.sent_at),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatImplementationFailureComment(
  stage: string,
  error: string,
  marker: string,
): string {
  const summary = error.length > 2_000 ? `${error.slice(0, 2_000)}…` : error;
  return `### Implementation stopped

The run could not complete during **${stage}**.

\`\`\`text
${summary.replaceAll("```", "''' ")}
\`\`\`

The worktree was retained for diagnosis. The run was not retried automatically.

Run ID: \`${marker.match(/mastra-loop:([^:]+)/)?.[1] ?? "unknown"}\`

${marker}`;
}
