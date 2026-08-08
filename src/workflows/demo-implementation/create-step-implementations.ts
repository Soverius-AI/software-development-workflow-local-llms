import type { AppConfig } from "../../config";
import type { EventStore } from "../../persistence/event-store";
import type { GitHubPullRequestPublisher } from "../../services/github/client";
import type { ReadinessEvaluator } from "../../services/readiness/contracts";
import { DEMO_IMPLEMENTATION_PROMPT_VERSION } from "../../services/codex/prompts";
import { DEMO_GRAPH_VERSION } from "../definitions";
import { PrepareWorktreeImplementation } from "../implementation/steps/prepare-worktree/prepare-worktree.implementation";
import type { ReadinessDecision } from "../implementation/steps/readiness/readiness.definition";
import { ReadinessImplementation } from "../implementation/steps/readiness/readiness.implementation";
import { DemoCodexImplementation } from "./steps/codex-implementation/codex-implementation.implementation";
import { DemoPublishPullRequestImplementation } from "./steps/publish-pull-request/publish-pull-request.implementation";

export interface DemoImplementationWorkflowImplementations {
  readiness: Pick<ReadinessImplementation, "execute">;
  prepareWorktree: Pick<PrepareWorktreeImplementation, "execute">;
  codexImplementation: Pick<DemoCodexImplementation, "execute">;
  publishPullRequest: Pick<DemoPublishPullRequestImplementation, "execute">;
}

export function createDemoImplementationWorkflowImplementations(input: {
  config: AppConfig["implementation"];
  store: EventStore;
  readinessEvaluator: ReadinessEvaluator<ReadinessDecision>;
  publisher: GitHubPullRequestPublisher | null;
}): DemoImplementationWorkflowImplementations {
  return {
    readiness: new ReadinessImplementation(
      input.store,
      input.readinessEvaluator,
      DEMO_GRAPH_VERSION,
    ),
    prepareWorktree: new PrepareWorktreeImplementation(
      input.config,
      input.store,
      input.publisher,
      DEMO_IMPLEMENTATION_PROMPT_VERSION,
    ),
    codexImplementation: new DemoCodexImplementation(input.config, input.store),
    publishPullRequest: new DemoPublishPullRequestImplementation(
      input.config,
      input.store,
      input.publisher,
    ),
  };
}
