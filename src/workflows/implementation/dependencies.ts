import type { Agent } from "@mastra/core/agent";
import type { ImplementationWorkflowImplementations } from "./create-step-implementations";

export interface ImplementationWorkflowDependencies {
  databaseUrl: string;
  implementations: ImplementationWorkflowImplementations;
  readinessAgent?: Agent;
}
