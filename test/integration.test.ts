import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/config";
import type {
  GitHubCommentPublisher,
  PublishedGitHubComment,
} from "../src/services/github/client";
import type {
  ReadinessEvaluator,
  ReadinessInput,
} from "../src/services/readiness/contracts";
import type {
  CodexImplementationOutput,
} from "../src/workflows/implementation/steps/codex-implementation/codex-implementation.definition";
import type { DeterministicChecksOutput } from "../src/workflows/implementation/steps/deterministic-checks/deterministic-checks.definition";
import type {
  PreparedWorktree,
  PrepareWorktreeOutput,
} from "../src/workflows/implementation/steps/prepare-worktree/prepare-worktree.definition";
import type { ReviewerOutput } from "../src/workflows/implementation/steps/reviewer/reviewer.definition";
import type { SnapshotOutput } from "../src/workflows/implementation/steps/snapshot/snapshot.definition";
import type { ReadinessDecision } from "../src/workflows/implementation/steps/readiness/readiness.definition";

function config(implementationMs = 150): AppConfig {
  const id = randomUUID();
  return {
    port: 0,
    databasePath: path.join("/tmp", `loop-events-${id}.sqlite`),
    mastraDatabaseUrl: `file:${path.join("/tmp", `loop-mastra-${id}.sqlite`)}`,
    githubWebhookSecret: null,
    githubBotLogin: "loop-bot",
    githubApp: null,
    githubOutboxRetryBaseMs: 10,
    githubOutboxMaxAttempts: 3,
    maxActiveImplementations: 1,
    implementation: {
      repository: "example/app",
      repositoryPath: "/tmp/project",
      baseBranch: "main",
      worktreeRoot: "/tmp/worktrees",
      checkConfigPath: ".implementer.json",
      timeoutMs: 1_000,
      model: {
        baseUrl: "http://127.0.0.1:8888/v1",
        apiKey: "local",
        modelId: "test-implementer",
      },
      gitAuthorName: "Test Bot",
      gitAuthorEmail: "test@example.com",
    },
    readinessModel: {
      baseUrl: "http://127.0.0.1:8888/v1",
      apiKey: "local",
      modelId: "test-readiness",
      timeoutMs: 1_000,
    },
  };
}

function payload(issue: number, labels: string[] = []) {
  return {
    action: "opened",
    repository: { full_name: "example/app" },
    issue: {
      number: issue,
      title: "Export the current report",
      body: "Export the current report as CSV from the report toolbar.",
      labels: labels.map((name) => ({ name })),
    },
    sender: { login: "alice" },
  };
}

test("an event arriving during a run is attached without starting a second run", async () => {
  const app = await createApp(config(250), {
    readinessEvaluator: readyEvaluator(),
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(250),
    ),
  });
  try {
    const first = app.eventStore.ingest(
      event("d1", "issues", payload(42)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "running");

    const second = app.eventStore.ingest(
      event("d2", "issues", payload(42)),
      "loop-bot",
    );
    app.coordinator.wake();
    assert.equal(second.outcome, "attached");
    assert.equal(second.runId, first.runId);
    assert.equal(app.eventStore.listRuns().length, 1);

    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "completed");
    assert.equal(app.coordinator.activeCount, 0);
  } finally {
    await app.close();
  }
});

test("a human comment resumes the suspended Mastra run", async () => {
  const app = await createApp(config(10), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(10),
    ),
    readinessEvaluator: evaluator((input) =>
      input.clarifications.length === 0
        ? {
            ready: false,
            summary: "The issue does not define its acceptance criteria.",
            acceptanceCriteria: [],
            missingInformation: ["Acceptance criteria"],
            question: "What observable result should this change produce?",
          }
        : readyDecision(),
    ),
  });
  try {
    const first = app.eventStore.ingest(
      event("d1", "issues", payload(7)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(
      () => app.eventStore.getRun(first.runId!)?.status === "waiting_human",
    );

    const comment = app.eventStore.ingest(
      event("d2", "issue_comment", {
        action: "created",
        repository: { full_name: "example/app" },
        issue: {
          number: 7,
          title: "Export the current report",
          body: "Export the current report as CSV from the report toolbar.",
          labels: [],
        },
        comment: {
          body: "Done means the downloaded CSV contains the visible report rows.",
        },
        sender: { login: "reviewer" },
      }),
      "loop-bot",
    );
    assert.equal(comment.outcome, "resume_requested");
    app.coordinator.wake();
    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "completed");
    assert.equal(app.eventStore.getRun(first.runId!)?.pendingStep, null);
    assert.deepEqual(
      app.eventStore
        .listReadinessEvaluations(first.runId!)
        .map((evaluation) => evaluation.output?.decision.ready),
      [false, true],
    );
    assert.deepEqual(
      app.eventStore.listReadinessEvaluations(first.runId!)[1]?.input
        .clarifications,
      ["Done means the downloaded CSV contains the visible report rows."],
    );
  } finally {
    await app.close();
  }
});

test("a suspended readiness run posts its question through the durable outbox", async () => {
  const publisher = new FakeGitHubCommentPublisher();
  const app = await createApp(config(0), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => notReadyDecision()),
    githubCommentPublisher: publisher,
  });
  try {
    const result = app.eventStore.ingest(
      event("question-1", "issues", payload(21)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(
      () =>
        app.eventStore.listGitHubCommentOutbox(result.runId!)[0]?.status ===
        "sent",
    );
    const item = app.eventStore.listGitHubCommentOutbox(result.runId!)[0]!;
    assert.equal(publisher.publishCalls, 1);
    assert.equal(item.attempts, 1);
    assert.match(item.body, /Readiness needs clarification/);
    assert.match(item.body, /What observable result/);
    assert.match(item.body, /<!-- mastra-loop:/);
    assert.equal(app.eventStore.getRun(result.runId!)?.status, "waiting_human");
  } finally {
    await app.close();
  }
});

test("GitHub comment delivery retries a transient API failure", async () => {
  const publisher = new FakeGitHubCommentPublisher(1);
  const app = await createApp(config(0), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => notReadyDecision()),
    githubCommentPublisher: publisher,
  });
  try {
    const result = app.eventStore.ingest(
      event("question-retry", "issues", payload(22)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(
      () =>
        app.eventStore.listGitHubCommentOutbox(result.runId!)[0]?.status ===
        "sent",
    );
    const item = app.eventStore.listGitHubCommentOutbox(result.runId!)[0]!;
    assert.equal(publisher.publishCalls, 2);
    assert.equal(item.attempts, 2);
    assert.equal(item.lastError, null);
  } finally {
    await app.close();
  }
});

test("restart recovery reconciles an existing GitHub comment instead of duplicating it", async () => {
  const appConfig = config(0);
  const firstApp = await createApp(appConfig, {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => notReadyDecision()),
  });
  const result = firstApp.eventStore.ingest(
    event("question-restart", "issues", payload(23)),
    "loop-bot",
  );
  firstApp.coordinator.wake();
  await waitFor(
    () => firstApp.eventStore.getRun(result.runId!)?.status === "waiting_human",
  );
  const pending = firstApp.eventStore.listGitHubCommentOutbox(result.runId!)[0]!;
  assert.equal(pending.status, "pending");
  await firstApp.close();

  const publisher = new FakeGitHubCommentPublisher();
  publisher.comments.push({
    id: 99,
    url: "https://github.test/comments/99",
    body: `Recovered comment\n\n${pending.marker}`,
  });
  const secondApp = await createApp(appConfig, {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => notReadyDecision()),
    githubCommentPublisher: publisher,
  });
  try {
    await waitFor(
      () =>
        secondApp.eventStore.listGitHubCommentOutbox(result.runId!)[0]?.status ===
        "sent",
    );
    const recovered = secondApp.eventStore.listGitHubCommentOutbox(result.runId!)[0]!;
    assert.equal(publisher.publishCalls, 0);
    assert.equal(recovered.githubCommentId, 99);
  } finally {
    await secondApp.close();
  }
});

test("the comment that starts a run cannot answer a question created later", async () => {
  const app = await createApp(config(0), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => notReadyDecision()),
  });
  try {
    const result = app.eventStore.ingest(
      event("status-comment", "issue_comment", {
        action: "created",
        repository: { full_name: "example/app" },
        issue: {
          number: 24,
          title: "Unspecified design request",
          body: "Create a design.",
          labels: [],
        },
        comment: { body: "What is the status?" },
        sender: { login: "reviewer" },
      }),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(
      () => app.eventStore.getRun(result.runId!)?.status === "waiting_human",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      app.eventStore.listReadinessEvaluations(result.runId!).length,
      1,
    );
    assert.equal(app.eventStore.getRun(result.runId!)?.answerAfterEventId, 1);
  } finally {
    await app.close();
  }
});

test("a transient readiness error is recorded and retried", async () => {
  let attempts = 0;
  const app = await createApp(config(0), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary model failure");
      return readyDecision();
    }),
  });
  try {
    const first = app.eventStore.ingest(
      event("d1", "issues", payload(9)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "completed");
    const evaluations = app.eventStore.listReadinessEvaluations(first.runId!);
    assert.equal(attempts, 2);
    assert.deepEqual(
      evaluations.map((evaluation) => evaluation.status),
      ["error", "success"],
    );
    assert.equal(evaluations[0]?.error, "temporary model failure");
    assert.equal(evaluations[1]?.modelId, "test-readiness");
    assert.equal(evaluations[1]?.promptVersion, "readiness-test-v1");
    assert.equal(evaluations[1]?.graphVersion, "production-v1");
  } finally {
    await app.close();
  }
});

test("an exhausted readiness retry fails with both attempts recorded", async () => {
  const app = await createApp(config(0), {
    stepImplementations: fakeStepImplementations(
      new FakeImplementationService(),
    ),
    readinessEvaluator: evaluator(() => {
      throw new Error("model unavailable");
    }),
  });
  try {
    const first = app.eventStore.ingest(
      event("d1", "issues", payload(10)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "failed");
    const evaluations = app.eventStore.listReadinessEvaluations(first.runId!);
    assert.deepEqual(
      evaluations.map((evaluation) => evaluation.status),
      ["error", "error"],
    );
    assert.equal(app.eventStore.getRun(first.runId!)?.lastError, "model unavailable");
  } finally {
    await app.close();
  }
});

test("a terminal implementation failure is posted through the durable outbox", async () => {
  const publisher = new FakeGitHubCommentPublisher();
  const app = await createApp(config(0), {
    readinessEvaluator: readyEvaluator(),
    stepImplementations: fakeStepImplementations(
      new FailingImplementationService(),
    ),
    githubCommentPublisher: publisher,
  });
  try {
    const result = app.eventStore.ingest(
      event("implementation-failure", "issues", payload(31)),
      "loop-bot",
    );
    app.coordinator.wake();
    await waitFor(
      () =>
        app.eventStore.listGitHubCommentOutbox(result.runId!)[0]?.status ===
        "sent",
    );
    const run = app.eventStore.getRun(result.runId!);
    const comment = app.eventStore.listGitHubCommentOutbox(result.runId!)[0]!;
    assert.equal(run?.status, "failed");
    assert.equal(run?.lastError, "permission denied by automatic review");
    assert.match(comment.body, /Implementation stopped/);
    assert.match(comment.body, /permission denied by automatic review/);
    assert.match(comment.marker, /implementation:failed/);
  } finally {
    await app.close();
  }
});

function event(
  deliveryId: string,
  eventName: string,
  githubPayload: Record<string, any>,
) {
  return {
    deliveryId,
    eventName,
    action: githubPayload.action ?? null,
    repository: githubPayload.repository.full_name,
    correlationKey: `${githubPayload.repository.full_name}#${githubPayload.issue.number}`,
    issueNumber: githubPayload.issue.number,
    senderLogin: githubPayload.sender.login,
    isHumanComment: eventName === "issue_comment" && githubPayload.action === "created",
    commentBody: githubPayload.comment?.body ?? null,
    requiresHuman:
      githubPayload.issue.labels?.some((label: { name: string }) => label.name === "needs-human") ??
      false,
    payload: githubPayload,
  };
}

function readyDecision(): ReadinessDecision {
  return {
    ready: true,
    summary: "The desired export behavior is sufficiently specified.",
    acceptanceCriteria: [
      "A CSV download contains the rows visible in the current report.",
    ],
    missingInformation: [],
    question: null,
  };
}

function notReadyDecision(): ReadinessDecision {
  return {
    ready: false,
    summary: "The issue does not define its acceptance criteria.",
    acceptanceCriteria: [],
    missingInformation: ["Acceptance criteria"],
    question: "What observable result should this change produce?",
  };
}

function readyEvaluator(): ReadinessEvaluator<ReadinessDecision> {
  return evaluator(() => readyDecision());
}

function evaluator(
  evaluateDecision: (
    input: ReadinessInput,
  ) => ReadinessDecision | Promise<ReadinessDecision>,
): ReadinessEvaluator<ReadinessDecision> {
  return {
    modelId: "test-readiness",
    promptVersion: "readiness-test-v1",
    async evaluate(input) {
      const decision = await evaluateDecision(input);
      return {
        decision,
        modelId: "test-readiness",
        promptVersion: "readiness-test-v1",
        traceId: null,
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeGitHubCommentPublisher implements GitHubCommentPublisher {
  readonly comments: Array<PublishedGitHubComment & { body: string }> = [];
  publishCalls = 0;

  constructor(private failuresRemaining = 0) {}

  async findByMarker(
    _repository: string,
    _issueNumber: number,
    marker: string,
  ): Promise<PublishedGitHubComment | null> {
    return this.comments.find((comment) => comment.body.includes(marker)) ?? null;
  }

  async publish(
    _repository: string,
    _issueNumber: number,
    body: string,
  ): Promise<PublishedGitHubComment> {
    this.publishCalls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary GitHub API failure");
    }
    const comment = {
      id: this.comments.length + 1,
      url: `https://github.test/comments/${this.comments.length + 1}`,
      body,
    };
    this.comments.push(comment);
    return comment;
  }
}

class FakeImplementationService {
  constructor(private readonly delayMs = 0) {}

  async prepare(): Promise<PreparedWorktree> {
    return {
      attemptId: 1,
      worktreePath: "/tmp/worktree",
      branch: "codex/test",
      baseSha: "base",
      goal: "Implement the test issue",
    };
  }

  async implement(
    input: PrepareWorktreeOutput,
  ): Promise<CodexImplementationOutput> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return {
      ...input,
      codexThreadId: "thread-test",
      finalResponse: "Implemented",
    };
  }

  async check(
    input: CodexImplementationOutput,
  ): Promise<DeterministicChecksOutput> {
    return { ...input, checkResults: [] };
  }

  async snapshot(
    input: DeterministicChecksOutput,
  ): Promise<SnapshotOutput> {
    return { ...input, commitSha: "commit" };
  }

  async review(input: SnapshotOutput): Promise<ReviewerOutput> {
    return {
      ...input,
      review: {
        mode: "stub",
        decision: "approved",
        summary: "Stub approval",
      },
    };
  }

  async publish(input: ReviewerOutput) {
    return { ...input, pullRequestUrl: "https://github.test/pull/1" };
  }
}

class FailingImplementationService extends FakeImplementationService {
  override async implement(): Promise<CodexImplementationOutput> {
    throw new Error("permission denied by automatic review");
  }
}

function fakeStepImplementations(service: FakeImplementationService) {
  return {
    prepareWorktree: {
      execute: () => service.prepare(),
    },
    codexImplementation: {
      execute: (input: PrepareWorktreeOutput) => service.implement(input),
    },
    deterministicChecks: {
      execute: (input: CodexImplementationOutput) => service.check(input),
    },
    snapshot: {
      execute: (input: DeterministicChecksOutput) => service.snapshot(input),
    },
    reviewer: {
      execute: (input: SnapshotOutput) => service.review(input),
    },
    publishPullRequest: {
      execute: async (input: ReviewerOutput) => ({
        ...(await service.publish(input)),
        queuedEventsSeen: 0,
      }),
    },
  };
}
