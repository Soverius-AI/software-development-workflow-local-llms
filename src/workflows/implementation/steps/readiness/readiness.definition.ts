import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type { ReadinessImplementation } from "./readiness.implementation";

export const readinessDecisionSchema = z
  .object({
    ready: z.boolean(),
    summary: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    missingInformation: z.array(z.string().min(1)),
    question: z.string().min(1).nullable(),
  })
  .superRefine((decision, context) => {
    if (decision.ready && decision.missingInformation.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A ready issue cannot have missing information.",
      });
    }
    if (decision.ready && decision.question !== null) {
      context.addIssue({
        code: "custom",
        message: "A ready issue cannot ask a clarification question.",
      });
    }
    if (!decision.ready && decision.question === null) {
      context.addIssue({
        code: "custom",
        message: "An unready issue must ask a clarification question.",
      });
    }
  });

export type ReadinessDecision = z.infer<typeof readinessDecisionSchema>;

export const workflowInputSchema = z.object({
  controlRunId: z.string(),
  correlationKey: z.string(),
  queuedEventsSeen: z.number().int().nonnegative().default(0),
});

export const readinessOutputSchema = workflowInputSchema.extend({
  readiness: readinessDecisionSchema,
  readinessEvaluationId: z.number().int().positive(),
});

const resumeSchema = z.object({ answer: z.string().min(1) });
const suspendSchema = z.object({
  question: z.string(),
  missingInformation: z.array(z.string()),
  decision: readinessDecisionSchema,
  evaluationId: z.number().int().positive(),
});

export function createReadinessStep(
  implementation: Pick<ReadinessImplementation, "execute">,
) {
  return createStep({
    id: "readiness",
    description: "Verify that the work item is sufficiently specified.",
    inputSchema: workflowInputSchema,
    outputSchema: readinessOutputSchema,
    resumeSchema,
    suspendSchema,
    retries: 1,
    execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
      const result = await implementation.execute({
        controlRunId: inputData.controlRunId,
        ...(resumeData?.answer ? { resumeAnswer: resumeData.answer } : {}),
        signal: abortSignal,
      });
      if (!result.readiness.ready) {
        return suspend({
          question:
            result.readiness.question ??
            "What information is required before implementation can begin?",
          missingInformation: result.readiness.missingInformation,
          decision: result.readiness,
          evaluationId: result.readinessEvaluationId,
        });
      }
      return { ...inputData, ...result };
    },
  });
}
