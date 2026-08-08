import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { readinessOutputSchema } from "../readiness/readiness.definition";
import type { PrepareWorktreeImplementation } from "./prepare-worktree.implementation";

const preparedWorktreeSchema = z.object({
  attemptId: z.number().int().positive(),
  worktreePath: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  goal: z.string(),
});

export type PreparedWorktree = z.infer<typeof preparedWorktreeSchema>;

export const prepareWorktreeOutputSchema = readinessOutputSchema.extend(
  preparedWorktreeSchema.shape,
);

export type PrepareWorktreeOutput = z.infer<
  typeof prepareWorktreeOutputSchema
>;

export function createPrepareWorktreeStep(
  implementation: Pick<PrepareWorktreeImplementation, "execute">,
) {
  return createStep({
    id: "prepare-worktree",
    inputSchema: readinessOutputSchema,
    outputSchema: prepareWorktreeOutputSchema,
    execute: async ({ inputData, abortSignal }) => {
      const prepared = await implementation.execute({
        controlRunId: inputData.controlRunId,
        readiness: inputData.readiness,
        signal: abortSignal,
      });
      return { ...inputData, ...prepared };
    },
  });
}
