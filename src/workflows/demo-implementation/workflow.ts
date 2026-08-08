import { createWorkflow } from "@mastra/core/workflows";
import type { DemoImplementationWorkflowImplementations } from "./create-step-implementations";
import { createReadinessStep, workflowInputSchema } from "../implementation/steps/readiness/readiness.definition";
import { createPrepareWorktreeStep } from "../implementation/steps/prepare-worktree/prepare-worktree.definition";
import { createDemoCodexImplementationStep } from "./steps/codex-implementation/codex-implementation.definition";
import {
  createDemoPublishPullRequestStep,
  demoPublishPullRequestOutputSchema,
} from "./steps/publish-pull-request/publish-pull-request.definition";

export function createDemoImplementationWorkflow(
  implementations: DemoImplementationWorkflowImplementations,
) {
  return createWorkflow({
    id: "github-demo-implementation",
    inputSchema: workflowInputSchema,
    outputSchema: demoPublishPullRequestOutputSchema,
  })
    .then(createReadinessStep(implementations.readiness))
    .then(createPrepareWorktreeStep(implementations.prepareWorktree))
    .then(createDemoCodexImplementationStep(implementations.codexImplementation))
    .then(createDemoPublishPullRequestStep(implementations.publishPullRequest))
    .commit();
}
