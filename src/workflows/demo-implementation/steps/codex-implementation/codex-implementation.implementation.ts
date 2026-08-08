import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { runDemoCodexWorker } from "../../../../services/codex/demo-worker";
import type { PrepareWorktreeOutput } from "../../../implementation/steps/prepare-worktree/prepare-worktree.definition";
import type { DemoCodexImplementationOutput } from "./codex-implementation.definition";

export class DemoCodexImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
  ) {}

  async execute(
    input: PrepareWorktreeOutput,
    signal: AbortSignal,
  ): Promise<DemoCodexImplementationOutput> {
    this.store.setImplementationStage(input.attemptId, "implementing");
    try {
      const result = await runDemoCodexWorker({
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
