import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { z } from "zod";
import { PRODUCTION_GRAPH_VERSION } from "./graph-definition";
import { readinessDecisionSchema, type ReadinessEvaluator } from "./readiness";
import type { EventStore } from "./store";

const workflowInputSchema = z.object({
  controlRunId: z.string(),
  correlationKey: z.string(),
  implementationMs: z.number().int().nonnegative(),
  queuedEventsSeen: z.number().int().nonnegative().default(0),
});

const readyDataSchema = workflowInputSchema.extend({
  readiness: readinessDecisionSchema,
  readinessEvaluationId: z.number().int().positive(),
});

const resumeSchema = z.object({ answer: z.string().min(1) });
const readinessSuspendSchema = z.object({
  question: z.string(),
  missingInformation: z.array(z.string()),
  decision: readinessDecisionSchema,
  evaluationId: z.number().int().positive(),
});

export function createImplementationMastra(params: {
  databaseUrl: string;
  eventStore: EventStore;
  readinessEvaluator: ReadinessEvaluator;
  readinessAgent?: Agent;
}) {
  const readiness = createStep({
    id: "readiness",
    description: "Verify that the work item is sufficiently specified.",
    inputSchema: workflowInputSchema,
    outputSchema: readyDataSchema,
    resumeSchema,
    suspendSchema: readinessSuspendSchema,
    retries: 1,
    execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
      const readinessInput = params.eventStore.getReadinessInput(
        inputData.controlRunId,
      );
      if (
        resumeData?.answer &&
        !readinessInput.clarifications.includes(resumeData.answer)
      ) {
        readinessInput.clarifications.push(resumeData.answer);
      }
      const evaluationId = params.eventStore.startReadinessEvaluation(
        inputData.controlRunId,
        readinessInput,
        params.readinessEvaluator.modelId,
        params.readinessEvaluator.promptVersion,
        PRODUCTION_GRAPH_VERSION,
      );

      try {
        const evaluation = await params.readinessEvaluator.evaluate(
          readinessInput,
          { abortSignal },
        );
        params.eventStore.completeReadinessEvaluation(evaluationId, evaluation);
        if (!evaluation.decision.ready) {
          return suspend({
            question:
              evaluation.decision.question ??
              "What information is required before implementation can begin?",
            missingInformation: evaluation.decision.missingInformation,
            decision: evaluation.decision,
            evaluationId,
          });
        }
        return {
          ...inputData,
          readiness: evaluation.decision,
          readinessEvaluationId: evaluationId,
        };
      } catch (error) {
        params.eventStore.failReadinessEvaluation(evaluationId, error);
        throw error;
      }
    },
  });

  const implementation = createStep({
    id: "implementation",
    inputSchema: readyDataSchema,
    outputSchema: readyDataSchema,
    execute: async ({ inputData, abortSignal }) => {
      await abortableDelay(inputData.implementationMs, abortSignal);
      const queuedEventsSeen = params.eventStore.countQueuedEvents(
        inputData.controlRunId,
      );
      return { ...inputData, queuedEventsSeen };
    },
  });

  const workflow = createWorkflow({
    id: "github-implementation",
    inputSchema: workflowInputSchema,
    outputSchema: readyDataSchema,
  })
    .then(readiness)
    .then(implementation)
    .commit();

  const storage = new LibSQLStore({ id: "loop-storage", url: params.databaseUrl });
  const mastra = new Mastra({
    storage,
    ...(params.readinessAgent
      ? { agents: { readiness: params.readinessAgent } }
      : {}),
    workflows: { implementation: workflow },
    logger: new PinoLogger({ name: "Implementer", level: "info" }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: "implementer",
          exporters: [new MastraStorageExporter()],
          logging: { enabled: true, level: "info" },
        },
      },
    }),
  });

  return { mastra, workflow, storage };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
