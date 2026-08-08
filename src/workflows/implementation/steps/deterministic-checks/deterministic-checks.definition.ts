import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { codexImplementationOutputSchema } from "../codex-implementation/codex-implementation.definition";
import type { DeterministicChecksImplementation } from "./deterministic-checks.implementation";

const checkResultSchema = z.object({
  name: z.string(),
  command: z.array(z.string()),
  exitCode: z.number().int(),
  output: z.string(),
  durationMs: z.number().nonnegative(),
});

export const deterministicChecksOutputSchema =
  codexImplementationOutputSchema.extend({
    checkResults: z.array(checkResultSchema),
  });

export type DeterministicChecksOutput = z.infer<
  typeof deterministicChecksOutputSchema
>;

export function createDeterministicChecksStep(
  implementation: Pick<DeterministicChecksImplementation, "execute">,
) {
  return createStep({
    id: "deterministic-checks",
    inputSchema: codexImplementationOutputSchema,
    outputSchema: deterministicChecksOutputSchema,
    execute: async ({ inputData, abortSignal }) => ({
      ...inputData,
      ...(await implementation.execute(inputData, abortSignal)),
    }),
  });
}
