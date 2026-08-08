import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { runCodexWorker } from "../../../../services/codex/worker";
import type { PrepareWorktreeOutput } from "../prepare-worktree/prepare-worktree.definition";
import type { CodexImplementationOutput } from "./codex-implementation.definition";

export class CodexImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
  ) {}

  async execute(
    input: PrepareWorktreeOutput,
    signal: AbortSignal,
  ): Promise<CodexImplementationOutput> {
    this.store.setImplementationStage(input.attemptId, "implementing");
    try {
      const result = await runCodexWorker({
        prepared: input,
        signal,
        config: this.config,
        store: this.store,
      });
      this.store.completeCodexImplementation(
        input.attemptId,
        result.finalResponse,
      );
      return { ...input, ...result };
    } catch (error) {
      this.store.failImplementationAttempt(input.attemptId, error);
      throw error;
    }
  }
}
