import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { prepareWorktreeOutputSchema } from "../prepare-worktree/prepare-worktree.definition";
import type { CodexImplementation } from "./codex-implementation.implementation";

export const codexImplementationOutputSchema =
  prepareWorktreeOutputSchema.extend({
    codexThreadId: z.string(),
    finalResponse: z.string(),
  });

export type CodexImplementationOutput = z.infer<
  typeof codexImplementationOutputSchema
>;

export function createCodexImplementationStep(
  implementation: Pick<CodexImplementation, "execute">,
) {
  return createStep({
    id: "codex-goal-implementation",
    inputSchema: prepareWorktreeOutputSchema,
    outputSchema: codexImplementationOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      ...inputData,
      ...(await implementation.execute(inputData, abortSignal)),
    }),
  });
}
