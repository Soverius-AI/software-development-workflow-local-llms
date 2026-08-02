import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  IngestResult,
  NormalizedGitHubEvent,
  RunStatus,
  WorkflowRunRecord,
} from "./types.js";

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
        pending_question TEXT,
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
    `);
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
               WHERE re.run_id = wr.id AND re.kind = 'human_comment' AND re.state = 'queued'
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

  getRunOptions(runId: string): { requiresHuman: boolean } {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM github_deliveries
         WHERE workflow_run_id = ? ORDER BY received_at LIMIT 1`,
      )
      .get(runId) as { payload_json: string } | undefined;
    if (!row) return { requiresHuman: false };
    const payload = JSON.parse(row.payload_json) as Record<string, any>;
    const requiresHuman =
      payload.issue?.labels?.some(
        (label: unknown) =>
          typeof label === "object" &&
          label !== null &&
          (label as { name?: unknown }).name === "needs-human",
      ) === true;
    return { requiresHuman };
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
    options: { question?: string | null; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_runs SET status = ?, pending_question = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        options.question ?? null,
        options.error ?? null,
        new Date().toISOString(),
        id,
      );
  }

  consumeHumanComment(runId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id, body FROM run_events
         WHERE run_id = ? AND kind = 'human_comment' AND state = 'queued'
         ORDER BY id LIMIT 1`,
      )
      .get(runId) as { id: number; body: string | null } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE run_events SET state = 'consumed', consumed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    return row.body ?? "Approved via GitHub comment";
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

  private mapRun(row: Record<string, unknown>): WorkflowRunRecord {
    return {
      id: String(row.id),
      correlationKey: String(row.correlation_key),
      repository: String(row.repository),
      issueNumber: row.issue_number === null ? null : Number(row.issue_number),
      status: String(row.status) as RunStatus,
      mastraRunId: row.mastra_run_id === null ? null : String(row.mastra_run_id),
      pendingQuestion:
        row.pending_question === null ? null : String(row.pending_question),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastError: row.last_error === null ? null : String(row.last_error),
    };
  }
}
