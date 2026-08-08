import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { prepareWorktreeOutputSchema } from "../../../implementation/steps/prepare-worktree/prepare-worktree.definition";
import type { DemoCodexImplementation } from "./codex-implementation.implementation";

export const demoCodexImplementationOutputSchema =
  prepareWorktreeOutputSchema.extend({
    codexThreadId: z.string(),
    finalResponse: z.string(),
  });

export type DemoCodexImplementationOutput = z.infer<
  typeof demoCodexImplementationOutputSchema
>;

export function createDemoCodexImplementationStep(
  implementation: Pick<DemoCodexImplementation, "execute">,
) {
  return createStep({
    id: "demo-codex-implementation",
    description: "Implement the ready issue with Codex without a persistent goal.",
    inputSchema: prepareWorktreeOutputSchema,
    outputSchema: demoCodexImplementationOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      ...inputData,
      ...(await implementation.execute(inputData, abortSignal)),
    }),
  });
}
