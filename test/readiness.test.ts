import assert from "node:assert/strict";
import test from "node:test";
import { readinessDecisionSchema } from "../src/workflows/implementation/steps/readiness/readiness.definition";

test("a ready decision cannot retain missing information", () => {
  const result = readinessDecisionSchema.safeParse({
    ready: true,
    summary: "Ready",
    acceptanceCriteria: ["The requested behavior is observable."],
    missingInformation: ["Product decision"],
    question: null,
  });
  assert.equal(result.success, false);
});

test("an unready decision must ask a clarification question", () => {
  const result = readinessDecisionSchema.safeParse({
    ready: false,
    summary: "Not ready",
    acceptanceCriteria: [],
    missingInformation: ["Acceptance criteria"],
    question: null,
  });
  assert.equal(result.success, false);
});
