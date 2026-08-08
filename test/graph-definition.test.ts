import assert from "node:assert/strict";
import test from "node:test";
import {
  featureSuggestionGraph,
  productionGraph,
  refactoringGraph,
  reviewers,
  selfImprovementGraph,
} from "../src/workflows/definitions";

test("the graph contract retains every agreed independent reviewer", () => {
  assert.deepEqual(
    reviewers.map(({ id }) => id),
    [
      "security",
      "architecture",
      "technology",
      "performance",
      "tests",
      "accessibility",
      "code-quality",
      "bugs",
      "visual-design",
    ],
  );
});

test("production and scheduled loops remain separate graphs with explicit status", () => {
  assert.ok(productionGraph.some(({ id }) => id === "recorder"));
  assert.ok(selfImprovementGraph.some(({ id }) => id === "human-promotion"));
  assert.ok(
    refactoringGraph.some(({ id }) => id === "human-refactoring-approval"),
  );
  assert.ok(
    featureSuggestionGraph.some(({ id }) => id === "human-feature-approval"),
  );
  assert.equal(
    productionGraph.find(({ id }) => id === "codex-goal-implementation")?.status,
    "implemented",
  );
  assert.equal(
    productionGraph.find(({ id }) => id === "specialist-reviewers")?.status,
    "partial",
  );
  assert.equal(
    productionGraph.find(({ id }) => id === "readiness-and-decomposition")
      ?.status,
    "partial",
  );
  assert.equal(
    selfImprovementGraph.find(({ id }) => id === "baseline-versus-candidate-replay")
      ?.status,
    "planned",
  );
  assert.ok(refactoringGraph.every(({ status }) => status === "planned"));
  assert.ok(featureSuggestionGraph.every(({ status }) => status === "planned"));
});
