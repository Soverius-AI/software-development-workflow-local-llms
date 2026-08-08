import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { deterministicChecksOutputSchema } from "../deterministic-checks/deterministic-checks.definition";
import type { SnapshotImplementation } from "./snapshot.implementation";

export const snapshotOutputSchema = deterministicChecksOutputSchema.extend({
  commitSha: z.string(),
});

export type SnapshotOutput = z.infer<typeof snapshotOutputSchema>;

export function createSnapshotStep(
  implementation: Pick<SnapshotImplementation, "execute">,
) {
  return createStep({
    id: "implementation-snapshot",
    inputSchema: deterministicChecksOutputSchema,
    outputSchema: snapshotOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      ...inputData,
      ...(await implementation.execute(inputData, abortSignal)),
    }),
  });
}
