import type { ImplementationCheckResult } from "../checks/contracts";

export function formatPullRequestBody(input: {
  issueNumber: number | null;
  summary: string;
  checkResults: ImplementationCheckResult[];
  reviewSummary: string;
}): string {
  const checks = input.checkResults
    .map((check) => `- [x] ${check.name} (${check.durationMs} ms)`)
    .join("\n");
  const closes = input.issueNumber === null ? "" : `\n\nCloses #${input.issueNumber}`;
  return `## Implementation

${input.summary || "Codex completed the native implementation goal."}

## Deterministic checks

${checks}

## Review status

${input.reviewSummary}

The full accepted objective and acceptance criteria are preserved in the durable implementation record.${closes}`;
}
