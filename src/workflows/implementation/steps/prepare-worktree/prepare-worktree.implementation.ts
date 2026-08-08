import path from "node:path";
import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { loadRepositoryCheckConfiguration } from "../../../../services/checks/configuration";
import { runSetupCommands } from "../../../../services/checks/runner";
import {
  formatGoal,
  IMPLEMENTATION_PROMPT_VERSION,
} from "../../../../services/codex/prompts";
import { createImplementationWorktree } from "../../../../services/git/worktrees";
import type { GitHubPullRequestPublisher } from "../../../../services/github/client";
import type { ReadinessDecision } from "../readiness/readiness.definition";
import type { PreparedWorktree } from "./prepare-worktree.definition";

export class PrepareWorktreeImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
    private readonly publisher: GitHubPullRequestPublisher | null,
  ) {}

  async execute(input: {
    controlRunId: string;
    readiness: ReadinessDecision;
    signal: AbortSignal;
  }): Promise<PreparedWorktree> {
    if (!this.publisher) {
      throw new Error(
        "The GitHub App is required before implementation can create and publish a pull request.",
      );
    }
    const readinessInput = this.store.getReadinessInput(input.controlRunId);
    if (readinessInput.repository !== this.config.repository) {
      throw new Error(
        `Run targets ${readinessInput.repository}, but the implementer is configured for ${this.config.repository}.`,
      );
    }
    const suffix = input.controlRunId.replaceAll("-", "").slice(0, 10);
    const issuePart = readinessInput.issueNumber ?? "event";
    const branch = `codex/issue-${issuePart}-${suffix}`;
    const worktreePath = path.join(this.config.worktreeRoot, input.controlRunId);
    const goal = formatGoal({
      title: readinessInput.title,
      body: readinessInput.body,
      clarifications: readinessInput.clarifications,
      acceptanceCriteria: input.readiness.acceptanceCriteria,
    });
    const attemptId = this.store.startImplementationAttempt({
      runId: input.controlRunId,
      repositoryPath: this.config.repositoryPath,
      worktreePath,
      branch,
      goal,
      modelBaseUrl: this.config.model.baseUrl,
      modelId: this.config.model.modelId,
      promptVersion: IMPLEMENTATION_PROMPT_VERSION,
    });

    try {
      await this.publisher.fetchBase(
        this.config.repository,
        this.config.repositoryPath,
        this.config.baseBranch,
        input.signal,
      );
      const worktree = await createImplementationWorktree({
        repositoryPath: this.config.repositoryPath,
        worktreeRoot: this.config.worktreeRoot,
        runId: input.controlRunId,
        branch,
        baseBranch: this.config.baseBranch,
        signal: input.signal,
      });
      const repositoryConfig = loadRepositoryCheckConfiguration(
        path.join(worktree.worktreePath, this.config.checkConfigPath),
      );
      this.store.configureImplementationAttempt(
        attemptId,
        worktree.baseSha,
        repositoryConfig.checks,
      );
      await runSetupCommands({
        commands: repositoryConfig.setup,
        attemptId,
        worktreePath: worktree.worktreePath,
        signal: input.signal,
        store: this.store,
      });
      return {
        attemptId,
        worktreePath: worktree.worktreePath,
        branch,
        baseSha: worktree.baseSha,
        goal,
      };
    } catch (error) {
      this.store.failImplementationAttempt(attemptId, error);
      throw error;
    }
  }
}
