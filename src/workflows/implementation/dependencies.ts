import type { Agent } from "@mastra/core/agent";
import type { DemoImplementationWorkflowImplementations } from "../demo-implementation/create-step-implementations";
import type { ImplementationWorkflowImplementations } from "./create-step-implementations";

export interface ImplementationWorkflowDependencies {
  databaseUrl: string;
  implementations: ImplementationWorkflowImplementations;
  demoImplementations: DemoImplementationWorkflowImplementations;
  readinessAgent?: Agent;
}
