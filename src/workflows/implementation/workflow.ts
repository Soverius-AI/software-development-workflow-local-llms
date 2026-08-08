import { Mastra } from "@mastra/core/mastra";
import { createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import type { ImplementationWorkflowDependencies } from "./dependencies";
import { createCodexImplementationStep } from "./steps/codex-implementation/codex-implementation.definition";
import { createDeterministicChecksStep } from "./steps/deterministic-checks/deterministic-checks.definition";
import { createPrepareWorktreeStep } from "./steps/prepare-worktree/prepare-worktree.definition";
import {
  createPublishPullRequestStep,
  publishPullRequestOutputSchema,
} from "./steps/publish-pull-request/publish-pull-request.definition";
import {
  createReadinessStep,
  workflowInputSchema,
} from "./steps/readiness/readiness.definition";
import { createReviewerStep } from "./steps/reviewer/reviewer.definition";
import { createSnapshotStep } from "./steps/snapshot/snapshot.definition";

export function createImplementationMastra(
  dependencies: ImplementationWorkflowDependencies,
) {
  const workflow = createWorkflow({
    id: "github-implementation",
    inputSchema: workflowInputSchema,
    outputSchema: publishPullRequestOutputSchema,
  })
    .then(createReadinessStep(dependencies.implementations.readiness))
    .then(
      createPrepareWorktreeStep(dependencies.implementations.prepareWorktree),
    )
    .then(
      createCodexImplementationStep(
        dependencies.implementations.codexImplementation,
      ),
    )
    .then(
      createDeterministicChecksStep(
        dependencies.implementations.deterministicChecks,
      ),
    )
    .then(createSnapshotStep(dependencies.implementations.snapshot))
    .then(createReviewerStep(dependencies.implementations.reviewer))
    .then(
      createPublishPullRequestStep(
        dependencies.implementations.publishPullRequest,
      ),
    )
    .commit();

  const storage = new LibSQLStore({
    id: "loop-storage",
    url: dependencies.databaseUrl,
  });
  const mastra = new Mastra({
    storage,
    ...(dependencies.readinessAgent
      ? { agents: { readiness: dependencies.readinessAgent } }
      : {}),
    workflows: { implementation: workflow },
    logger: new PinoLogger({ name: "Implementer", level: "info" }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: "implementer",
          exporters: [new MastraStorageExporter()],
          logging: { enabled: true, level: "info" },
        },
      },
    }),
  });

  return { mastra, workflow, storage };
}
