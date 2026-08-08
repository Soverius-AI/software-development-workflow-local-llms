# Software Development Graph

This repository implements a durable, local-LLM software-development workflow orchestrated with Mastra. It is not merely a GitHub webhook receiver. Preserve the complete graph described in `docs/architecture.md` whenever changing the implementation.

## Operating model

The production graph starts from a GitHub event and first checks whether the issue contains enough information. It may ask a human for clarification or propose child issues before implementation. One write-capable Codex worker then implements the accepted issue in an isolated worktree using a persistent goal and explicit acceptance criteria.

After deterministic checks, independent read-only reviewers run in parallel. The required reviewer perspectives are security, architecture, technology/framework, performance, tests and acceptance criteria, accessibility, code quality, bug detection, and visual design consistency. A manager node consolidates their evidence, removes duplicates, resolves compatible recommendations, and identifies genuine conflicts. It may send repair work back to implementation. When competing recommendations depend on product priorities or cannot be resolved from the recorded criteria, it suspends the run and presents the arguments to a human.

Successful runs may proceed to a pull request and human approval. All steps emit evidence to the recorder. Production runs never rewrite their own prompts, skills, or graph.

The self-improvement graph is a separate scheduled process. It reads newly recorded runs after `lastAnalysedRunId`, distils recurring lessons, proposes versioned candidate changes, and evaluates each candidate against a frozen baseline using replay cases. A candidate is promoted only when it improves the agreed metrics without violating regression or safety gates and a human approves it.

Two additional scheduled graphs are planned. The refactoring graph discovers evidence-backed structural maintenance opportunities in a bounded repository scope. The feature-suggestion graph uses bounded product signals to propose new capabilities with explicit assumptions and acceptance criteria. Neither graph writes production code directly: both require human approval before creating an issue that enters the normal readiness and implementation graph.

## Validation boundaries

Keep these concepts separate in code and documentation:

1. Inner self-correction checks whether the agent's latest action worked.
2. Codex goal validation checks whether the full stated outcome and acceptance criteria are satisfied.
3. Deterministic checks execute externally defined tests, builds, linters, type checks, and policy checks.
4. Independent reviewers assess concerns not established by the implementation worker's own tests.
5. Human approval resolves product decisions and accepts high-impact changes.

Agent-written tests are useful implementation artifacts, but they are not independent proof. Acceptance criteria, existing tests, externally defined checks, review evidence, and human evaluation form the independent verification boundary.

## Safety and concurrency

GitHub delivery IDs are idempotency keys. Persist an event before acknowledging it. An event for an active issue joins that run's inbox and is consumed only at a safe boundary; it must not interrupt a model turn. Different issues may have separate durable runs, but only one write-capable worker may use a given worktree at a time. Reviewers are read-only and may run concurrently after the implementation snapshot is fixed.

Do not let the system review or merge its own bot-generated GitHub events. Version prompts, skills, rubrics, graph definitions, models, and acceptance criteria on every recorded run. Never auto-promote a learned candidate merely because it is frequent or recent.

## Current implementation status

The repository currently implements GitHub ingestion, duplicate suppression, same-issue correlation, a local implementation-slot queue, Mastra persistence, the readiness half of readiness/decomposition, append-only readiness evidence, a durable GitHub comment outbox with retry and marker reconciliation, and step-aware human suspension/resumption. Only comments received after a suspension boundary may answer that suspension. A real Codex SDK worker now implements accepted issues in Mastra-owned worktrees with a native persistent goal, the configured OpenAI-compatible model, automatic approval review, externally defined deterministic checks, a committed snapshot, and durable implementation evidence. Terminal implementation failures are posted to the issue and are not retried blindly. The current reviewer is deliberately an always-approve stub; successful runs can push the branch and create an idempotent pull request through a configured GitHub App, but this hosted side effect has not yet been exercised end to end in production. Decomposition and child-issue proposals, independent reviewer fan-out, manager and repair loops, the general recorder schema, human PR approval, and the self-improvement, refactoring, and feature-suggestion scheduled graphs remain to be implemented. Do not describe those pieces as complete until code and tests exist.

When adding a node, update `docs/architecture.md`, add durable state for its inputs and outputs, and test success, retry, suspension, and duplicate-delivery behavior where applicable.

## Code layout

Each executable graph belongs under `src/workflows/<workflow-name>/`. Keep graph composition in `workflow.ts`. Give each meaningful Mastra step a vertical slice under `steps/<step-name>/`: `<step-name>.definition.ts` contains its input/output schemas, inferred transition types, and Mastra definition, while `<step-name>.implementation.ts` contains its workflow-specific behavior. Step definitions delegate directly to their colocated implementation. Including the step name keeps editor tabs and search results unambiguous. Additional step-specific modules may live in the same folder when an implementation grows; avoid per-step barrel files so navigation remains explicit. Do not duplicate step-transition interfaces in a central types file. Put reusable Codex, readiness/model, Git, GitHub, deterministic-check, and other technical capabilities and their contracts under `src/services/`; runtime coordination belongs under `src/orchestration/`, persistence records under `src/persistence/`, and small cross-cutting infrastructure under `src/shared/`. Keep only application composition, configuration, and executable entry points at the `src/` root. The intended navigation is `workflow.ts` to `steps/<name>/<name>.definition.ts` to `steps/<name>/<name>.implementation.ts` to any shared services.
