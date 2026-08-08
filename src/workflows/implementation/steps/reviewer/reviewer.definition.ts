import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { snapshotOutputSchema } from "../snapshot/snapshot.definition";
import type { ReviewerImplementation } from "./reviewer.implementation";

export const reviewerOutputSchema = snapshotOutputSchema.extend({
  review: z.object({
    mode: z.literal("stub"),
    decision: z.literal("approved"),
    summary: z.string(),
  }),
});

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export function createReviewerStep(
  implementation: Pick<ReviewerImplementation, "execute">,
) {
  return createStep({
    id: "stub-review",
    inputSchema: snapshotOutputSchema,
    outputSchema: reviewerOutputSchema,
    execute: async ({ inputData }) => ({
      ...inputData,
      ...(await implementation.execute(inputData)),
    }),
  });
}
