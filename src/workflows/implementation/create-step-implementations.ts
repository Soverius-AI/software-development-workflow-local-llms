import type { AppConfig } from "../../config";
import type { EventStore } from "../../persistence/event-store";
import type { GitHubPullRequestPublisher } from "../../services/github/client";
import type { ReadinessEvaluator } from "../../services/readiness/contracts";
import { CodexImplementation } from "./steps/codex-implementation/codex-implementation.implementation";
import { DeterministicChecksImplementation } from "./steps/deterministic-checks/deterministic-checks.implementation";
import { PrepareWorktreeImplementation } from "./steps/prepare-worktree/prepare-worktree.implementation";
import { PublishPullRequestImplementation } from "./steps/publish-pull-request/publish-pull-request.implementation";
import type { ReadinessDecision } from "./steps/readiness/readiness.definition";
import { ReadinessImplementation } from "./steps/readiness/readiness.implementation";
import { ReviewerImplementation } from "./steps/reviewer/reviewer.implementation";
import { SnapshotImplementation } from "./steps/snapshot/snapshot.implementation";

export interface ImplementationWorkflowImplementations {
  readiness: Pick<ReadinessImplementation, "execute">;
  prepareWorktree: Pick<PrepareWorktreeImplementation, "execute">;
  codexImplementation: Pick<CodexImplementation, "execute">;
  deterministicChecks: Pick<DeterministicChecksImplementation, "execute">;
  snapshot: Pick<SnapshotImplementation, "execute">;
  reviewer: Pick<ReviewerImplementation, "execute">;
  publishPullRequest: Pick<PublishPullRequestImplementation, "execute">;
}

export function createImplementationWorkflowImplementations(input: {
  config: AppConfig["implementation"];
  store: EventStore;
  readinessEvaluator: ReadinessEvaluator<ReadinessDecision>;
  publisher: GitHubPullRequestPublisher | null;
}): ImplementationWorkflowImplementations {
  return {
    readiness: new ReadinessImplementation(input.store, input.readinessEvaluator),
    prepareWorktree: new PrepareWorktreeImplementation(
      input.config,
      input.store,
      input.publisher,
    ),
    codexImplementation: new CodexImplementation(input.config, input.store),
    deterministicChecks: new DeterministicChecksImplementation(
      input.config,
      input.store,
    ),
    snapshot: new SnapshotImplementation(input.config, input.store),
    reviewer: new ReviewerImplementation(input.store),
    publishPullRequest: new PublishPullRequestImplementation(
      input.config,
      input.store,
      input.publisher,
    ),
  };
}
