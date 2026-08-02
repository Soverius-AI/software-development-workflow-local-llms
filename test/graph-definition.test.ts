import assert from "node:assert/strict";
import test from "node:test";
import {
  productionGraph,
  reviewers,
  selfImprovementGraph,
} from "../src/graph-definition.js";

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

test("production and learning remain separate graphs with explicit status", () => {
  assert.ok(productionGraph.some(({ id }) => id === "recorder"));
  assert.ok(selfImprovementGraph.some(({ id }) => id === "human-promotion"));
  assert.equal(
    productionGraph.find(({ id }) => id === "codex-goal-implementation")?.status,
    "planned",
  );
  assert.equal(
    selfImprovementGraph.find(({ id }) => id === "baseline-versus-candidate-replay")
      ?.status,
    "planned",
  );
});
