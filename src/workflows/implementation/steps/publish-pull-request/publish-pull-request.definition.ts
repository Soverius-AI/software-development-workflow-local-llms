import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { reviewerOutputSchema } from "../reviewer/reviewer.definition";
import type { PublishPullRequestImplementation } from "./publish-pull-request.implementation";

export const publishPullRequestOutputSchema = reviewerOutputSchema.extend({
  pullRequestUrl: z.url(),
});

export type PublishPullRequestOutput = z.infer<
  typeof publishPullRequestOutputSchema
>;

export function createPublishPullRequestStep(
  implementation: Pick<PublishPullRequestImplementation, "execute">,
) {
  return createStep({
    id: "pull-request",
    inputSchema: reviewerOutputSchema,
    outputSchema: publishPullRequestOutputSchema,
    execute: async ({ inputData, abortSignal }) => {
      const published = await implementation.execute(inputData, abortSignal);
      return { ...inputData, ...published };
    },
  });
}
