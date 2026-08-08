import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { commitImplementationSnapshot } from "../../../../services/git/snapshot";
import type { DeterministicChecksOutput } from "../deterministic-checks/deterministic-checks.definition";
import type { SnapshotOutput } from "./snapshot.definition";

export class SnapshotImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
  ) {}

  async execute(
    input: DeterministicChecksOutput,
    signal: AbortSignal,
  ): Promise<SnapshotOutput> {
    this.store.setImplementationStage(input.attemptId, "snapshotting");
    try {
      const attempt = this.store.getImplementationAttempt(input.attemptId);
      if (!attempt) {
        throw new Error(`Implementation attempt ${input.attemptId} is missing.`);
      }
      const readinessInput = this.store.getReadinessInput(attempt.runId);
      const commitSha = await commitImplementationSnapshot({
        worktreePath: input.worktreePath,
        subject: `Implement #${readinessInput.issueNumber ?? "event"}: ${readinessInput.title}`,
        authorName: this.config.gitAuthorName,
        authorEmail: this.config.gitAuthorEmail,
        signal,
      });
      this.store.recordImplementationSnapshot(input.attemptId, commitSha);
      return { ...input, commitSha };
    } catch (error) {
      this.store.failImplementationAttempt(input.attemptId, error);
      throw error;
    }
  }
}
