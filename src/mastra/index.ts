import { loadConfig } from "../config";
import { EventStore } from "../store";
import { createReadinessEvaluator } from "../readiness";
import { createImplementationMastra } from "../workflow";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const projectRoot = process.env.INIT_CWD ?? process.env.PWD ?? process.cwd();
const config = loadConfig(process.env, projectRoot);
const eventStore = new EventStore(config.databasePath);
const readiness = createReadinessEvaluator(config.readinessModel);

export const { mastra } = createImplementationMastra({
  databaseUrl: config.mastraDatabaseUrl,
  eventStore,
  readinessEvaluator: readiness.evaluator,
  readinessAgent: readiness.agent,
});
