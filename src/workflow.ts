import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";
import type { EventStore } from "./store.js";

const workflowDataSchema = z.object({
  controlRunId: z.string(),
  correlationKey: z.string(),
  requiresHuman: z.boolean(),
  implementationMs: z.number().int().nonnegative(),
  humanAnswer: z.string().optional(),
  queuedEventsSeen: z.number().int().nonnegative().default(0),
});

const resumeSchema = z.object({ answer: z.string().min(1) });
const suspendSchema = z.object({ question: z.string() });

export function createImplementationMastra(params: {
  databaseUrl: string;
  eventStore: EventStore;
}) {
  const implementation = createStep({
    id: "implementation",
    inputSchema: workflowDataSchema,
    outputSchema: workflowDataSchema,
    resumeSchema,
    suspendSchema,
    execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
      if (inputData.requiresHuman && !resumeData) {
        return suspend({
          question: `Clarification required for ${inputData.correlationKey}`,
        });
      }

      await abortableDelay(inputData.implementationMs, abortSignal);
      const queuedEventsSeen = params.eventStore.countQueuedEvents(
        inputData.controlRunId,
      );
      return {
        ...inputData,
        ...(resumeData ? { humanAnswer: resumeData.answer } : {}),
        queuedEventsSeen,
      };
    },
  });

  const workflow = createWorkflow({
    id: "github-implementation",
    inputSchema: workflowDataSchema,
    outputSchema: workflowDataSchema,
  })
    .then(implementation)
    .commit();

  const storage = new LibSQLStore({ id: "loop-storage", url: params.databaseUrl });
  const mastra = new Mastra({
    storage,
    workflows: { implementation: workflow },
    logger: false,
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
