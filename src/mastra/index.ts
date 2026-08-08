import { loadConfig } from "../config";
import { EventStore } from "../persistence/event-store";
import { createReadinessEvaluator } from "../services/readiness/evaluator";
import { createImplementationMastra } from "../workflows/implementation";
import { GitHubAppCommentPublisher } from "../services/github/client";
import { createImplementationWorkflowImplementations } from "../workflows/implementation/create-step-implementations";
import { readinessDecisionSchema } from "../workflows/implementation/steps/readiness/readiness.definition";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const projectRoot = process.env.INIT_CWD ?? process.env.PWD ?? process.cwd();
const config = loadConfig(process.env, projectRoot);
const eventStore = new EventStore(config.databasePath);
const readiness = createReadinessEvaluator(
  config.readinessModel,
  readinessDecisionSchema,
);
const githubAppClient = config.githubApp
  ? new GitHubAppCommentPublisher(config.githubApp)
  : null;
const implementations = createImplementationWorkflowImplementations({
  config: config.implementation,
  store: eventStore,
  readinessEvaluator: readiness.evaluator,
  publisher: githubAppClient,
});

export const { mastra } = createImplementationMastra({
  databaseUrl: config.mastraDatabaseUrl,
  implementations,
  readinessAgent: readiness.agent,
});
