import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { runDeterministicChecks } from "../../../../services/checks/runner";
import { runProcess } from "../../../../shared/process";
import type { CodexImplementationOutput } from "../codex-implementation/codex-implementation.definition";
import type { DeterministicChecksOutput } from "./deterministic-checks.definition";

export class DeterministicChecksImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
  ) {}

  async execute(
    input: CodexImplementationOutput,
    signal: AbortSignal,
  ): Promise<DeterministicChecksOutput> {
    this.store.setImplementationStage(input.attemptId, "checking");
    try {
      const attempt = this.store.getImplementationAttempt(input.attemptId);
      if (!attempt) {
        throw new Error(`Implementation attempt ${input.attemptId} is missing.`);
      }
      const configDiff = await runProcess(
        "git",
        ["diff", "--quiet", input.baseSha, "--", this.config.checkConfigPath],
        { cwd: input.worktreePath, timeoutMs: 30_000, signal },
      );
      if (configDiff.exitCode !== 0) {
        throw new Error(
          `${this.config.checkConfigPath} changed during implementation; checks must remain externally defined.`,
        );
      }
      const checkResults = await runDeterministicChecks({
        checks: attempt.checks,
        attemptId: input.attemptId,
        worktreePath: input.worktreePath,
        signal,
        store: this.store,
      });
      return { ...input, checkResults };
    } catch (error) {
      this.store.failImplementationAttempt(input.attemptId, error);
      throw error;
    }
  }
}
