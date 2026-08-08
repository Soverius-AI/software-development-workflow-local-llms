import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/config";
import type {
  GitHubCommentPublisher,
  PublishedGitHubComment,
} from "../src/github-comments";
import type { ReadinessEvaluator } from "../src/readiness";
import type { ReadinessDecision, ReadinessInput } from "../src/types";

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
    simulatedImplementationMs: implementationMs,
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

function readyEvaluator(): ReadinessEvaluator {
  return evaluator(() => readyDecision());
}

function evaluator(
  evaluateDecision: (
    input: ReadinessInput,
  ) => ReadinessDecision | Promise<ReadinessDecision>,
): ReadinessEvaluator {
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
