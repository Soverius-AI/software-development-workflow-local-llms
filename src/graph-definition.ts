/** Machine-readable contract for the graph we are building. */
export type NodeStatus = "implemented" | "partial" | "planned";

export interface GraphNodeDefinition {
  id: string;
  responsibility: string;
  kind: "deterministic" | "agent" | "parallel" | "human-gate" | "side-effect";
  status: NodeStatus;
}

export interface ReviewerDefinition {
  id:
    | "security"
    | "architecture"
    | "technology"
    | "performance"
    | "tests"
    | "accessibility"
    | "code-quality"
    | "bugs"
    | "visual-design";
  question: string;
  requiresVisualEvidence: boolean;
}

export const reviewers: readonly ReviewerDefinition[] = [
  { id: "security", question: "Does the change introduce exploitable behavior, unsafe trust boundaries, or leaked secrets?", requiresVisualEvidence: false },
  { id: "architecture", question: "Does the change preserve the application's boundaries, ownership, and long-term design?", requiresVisualEvidence: false },
  { id: "technology", question: "Does it follow the current framework, language, and repository-specific practices?", requiresVisualEvidence: false },
  { id: "performance", question: "Does it create unacceptable latency, memory, network, bundle-size, or scaling costs?", requiresVisualEvidence: false },
  { id: "tests", question: "Are the acceptance criteria independently covered, including important failure paths?", requiresVisualEvidence: false },
  { id: "accessibility", question: "Can people using keyboards and assistive technology perceive and operate the result?", requiresVisualEvidence: true },
  { id: "code-quality", question: "Is the change understandable, maintainable, cohesive, and appropriately simple?", requiresVisualEvidence: false },
  { id: "bugs", question: "What incorrect behavior, edge cases, races, or regressions remain?", requiresVisualEvidence: false },
  { id: "visual-design", question: "Is the rendered result visually appealing and consistent with the rest of the application?", requiresVisualEvidence: true },
] as const;

export const productionGraph: readonly GraphNodeDefinition[] = [
  { id: "github-ingest", responsibility: "Persist, deduplicate, correlate, and acknowledge GitHub events.", kind: "deterministic", status: "implemented" },
  { id: "readiness-and-decomposition", responsibility: "Verify sufficient context and decide whether the issue should be split into child issues.", kind: "agent", status: "planned" },
  { id: "human-clarification", responsibility: "Suspend and resume when missing information or a product decision requires a human.", kind: "human-gate", status: "partial" },
  { id: "codex-goal-implementation", responsibility: "Implement one accepted issue in an isolated worktree against explicit acceptance criteria.", kind: "agent", status: "planned" },
  { id: "deterministic-checks", responsibility: "Run repository-owned tests, builds, linting, type checks, and policy checks.", kind: "deterministic", status: "planned" },
  { id: "specialist-reviewers", responsibility: "Run the independent reviewer set in parallel against one fixed implementation snapshot.", kind: "parallel", status: "planned" },
  { id: "review-manager", responsibility: "Consolidate evidence, resolve compatible findings, route repairs, and expose true conflicts.", kind: "agent", status: "planned" },
  { id: "human-conflict-decision", responsibility: "Choose between irreconcilable recommendations using their evidence and trade-offs.", kind: "human-gate", status: "planned" },
  { id: "pull-request", responsibility: "Publish an approved, verified change and its evidence exactly once.", kind: "side-effect", status: "planned" },
  { id: "recorder", responsibility: "Append reconstructable run evidence without modifying the active graph.", kind: "deterministic", status: "planned" },
] as const;

export const selfImprovementGraph: readonly GraphNodeDefinition[] = [
  { id: "select-new-experiences", responsibility: "Read production evidence after lastAnalysedRunId while retaining older replay cases.", kind: "deterministic", status: "planned" },
  { id: "distil-lessons", responsibility: "Identify recurring failures and propose bounded prompt, skill, rubric, or graph changes.", kind: "agent", status: "planned" },
  { id: "baseline-versus-candidate-replay", responsibility: "Run identical representative cases against the frozen baseline and each candidate.", kind: "parallel", status: "planned" },
  { id: "improvement-gates", responsibility: "Reject regressions, safety violations, semantic drift, and unsupported gains.", kind: "deterministic", status: "planned" },
  { id: "human-promotion", responsibility: "Approve a versioned candidate for future runs; never mutate active runs.", kind: "human-gate", status: "planned" },
] as const;
