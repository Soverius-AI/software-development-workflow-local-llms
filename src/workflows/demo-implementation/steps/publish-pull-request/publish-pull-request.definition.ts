import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { demoCodexImplementationOutputSchema } from "../codex-implementation/codex-implementation.definition";
import type { DemoPublishPullRequestImplementation } from "./publish-pull-request.implementation";

export const demoPublishPullRequestOutputSchema =
  demoCodexImplementationOutputSchema.extend({
    commitSha: z.string(),
    pullRequestUrl: z.string().url(),
  });

export type DemoPublishPullRequestOutput = z.infer<
  typeof demoPublishPullRequestOutputSchema
>;

export function createDemoPublishPullRequestStep(
  implementation: Pick<DemoPublishPullRequestImplementation, "execute">,
) {
  return createStep({
    id: "demo-publish-pull-request",
    description:
      "Commit and publish the demo result without deterministic checks or review.",
    inputSchema: demoCodexImplementationOutputSchema,
    outputSchema: demoPublishPullRequestOutputSchema,
    execute: async ({ inputData, abortSignal }) =>
      implementation.execute(inputData, abortSignal),
  });
}
