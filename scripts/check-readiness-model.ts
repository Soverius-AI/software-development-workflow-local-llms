import { loadConfig } from "../src/config";
import { createReadinessEvaluator } from "../src/readiness";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = loadConfig();
const { evaluator } = createReadinessEvaluator(config.readinessModel);
const result = await evaluator.evaluate(
  {
    controlRunId: "readiness-live-check",
    correlationKey: "example/app#1",
    repository: "example/app",
    issueNumber: 1,
    title: "Add an export button",
    body: "Add an export button to the report page.",
    labels: [],
    clarifications: [],
  },
  { abortSignal: new AbortController().signal },
);

console.log(JSON.stringify(result, null, 2));
