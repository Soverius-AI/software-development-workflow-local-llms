import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  normalizeGitHubEvent,
  verifyGitHubSignature,
} from "../src/services/github/webhook";
import { EventStore } from "../src/persistence/event-store";
import { createHmac } from "node:crypto";

function makeStore(): EventStore {
  return new EventStore(path.join("/tmp", `loop-store-${randomUUID()}.sqlite`));
}

function event(deliveryId: string, issue = 12, sender = "alice") {
  return normalizeGitHubEvent({
    deliveryId,
    eventName: "issues",
    payload: {
      action: "opened",
      repository: { full_name: "example/app" },
      issue: { number: issue, labels: [] },
      sender: { login: sender },
    },
  });
}

test("a duplicate GitHub delivery is stored only once", () => {
  const store = makeStore();
  try {
    const first = store.ingest(event("delivery-1"), "loop-bot");
    const duplicate = store.ingest(event("delivery-1"), "loop-bot");
    assert.equal(first.outcome, "created");
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(store.listRuns().length, 1);
  } finally {
    store.close();
  }
});

test("events for one issue attach to its active run", () => {
  const store = makeStore();
  try {
    const first = store.ingest(event("delivery-1"), "loop-bot");
    const second = store.ingest(event("delivery-2"), "loop-bot");
    assert.equal(second.outcome, "attached");
    assert.equal(second.runId, first.runId);
    assert.equal(store.listRuns().length, 1);
    assert.equal(store.countQueuedEvents(first.runId!), 2);
  } finally {
    store.close();
  }
});

test("events for different issues create independent queued runs", () => {
  const store = makeStore();
  try {
    store.ingest(event("delivery-1", 12), "loop-bot");
    store.ingest(event("delivery-2", 13), "loop-bot");
    assert.equal(store.listRuns().length, 2);
  } finally {
    store.close();
  }
});

test("events created by the loop bot are ignored", () => {
  const store = makeStore();
  try {
    const result = store.ingest(event("delivery-1", 12, "loop-bot"), "loop-bot");
    assert.equal(result.outcome, "ignored");
    assert.equal(store.listRuns().length, 0);
  } finally {
    store.close();
  }
});

test("events containing the loop marker are ignored even if the bot login changes", () => {
  const store = makeStore();
  try {
    const marked = normalizeGitHubEvent({
      deliveryId: "delivery-marker",
      eventName: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "example/app" },
        issue: { number: 12, labels: [] },
        comment: { body: "Question\n<!-- mastra-loop:run:readiness:1 -->" },
        sender: { login: "renamed-app[bot]" },
      },
    });
    const result = store.ingest(marked, "old-bot-name");
    assert.equal(result.outcome, "ignored");
    assert.equal(store.listRuns().length, 0);
  } finally {
    store.close();
  }
});

test("signature verification uses the raw request body", () => {
  const body = Buffer.from('{"hello":"world"}');
  const secret = "test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature(body, signature, secret), true);
  assert.equal(verifyGitHubSignature(Buffer.from("changed"), signature, secret), false);
});

test("implementation evidence remains reconstructable through publication", () => {
  const store = makeStore();
  try {
    const runId = store.ingest(event("implementation-evidence"), "loop-bot").runId!;
    store.claimNextRun();
    const attemptId = store.startImplementationAttempt({
      runId,
      repositoryPath: "/repo",
      worktreePath: "/repo/.data/worktrees/run",
      branch: "codex/issue-12-run",
      goal: "Implement the accepted issue",
      modelBaseUrl: "http://127.0.0.1:8888/v1",
      modelId: "local/model",
      promptVersion: "codex-goal-v1",
    });
    const check = {
      name: "tests",
      command: ["pnpm", "test"],
      timeoutMs: 10_000,
    };
    store.configureImplementationAttempt(attemptId, "base-sha", [check]);
    store.setCodexThreadId(attemptId, "thread-id");
    store.appendImplementationEvent(attemptId, { type: "thread.started" });
    store.completeCodexImplementation(attemptId, "Implemented the issue.");
    store.recordImplementationCheck(attemptId, {
      ...check,
      exitCode: 0,
      output: "ok",
      durationMs: 25,
    });
    store.recordImplementationSnapshot(attemptId, "commit-sha");
    store.recordStubReview(attemptId, {
      mode: "stub",
      decision: "approved",
    });
    store.completeImplementationAttempt(
      attemptId,
      "https://github.test/example/app/pull/42",
    );

    const attempt = store.getImplementationAttempt(attemptId)!;
    assert.equal(attempt.status, "success");
    assert.equal(attempt.stage, "completed");
    assert.equal(attempt.baseSha, "base-sha");
    assert.equal(attempt.codexThreadId, "thread-id");
    assert.equal(attempt.checkResults?.[0]?.exitCode, 0);
    assert.equal(attempt.commitSha, "commit-sha");
    assert.equal(attempt.pullRequestUrl, "https://github.test/example/app/pull/42");
  } finally {
    store.close();
  }
});

test("restart fails an interrupted implementation and queues an issue comment", () => {
  const databasePath = path.join(
    "/tmp",
    `loop-store-restart-${randomUUID()}.sqlite`,
  );
  const firstStore = new EventStore(databasePath);
  const runId = firstStore.ingest(event("interrupted-run"), "loop-bot").runId!;
  firstStore.claimNextRun();
  firstStore.startImplementationAttempt({
    runId,
    repositoryPath: "/repo",
    worktreePath: "/repo/.data/worktrees/run",
    branch: "codex/issue-12-run",
    goal: "Implement the accepted issue",
    modelBaseUrl: "http://127.0.0.1:8888/v1",
    modelId: "local/model",
    promptVersion: "codex-goal-v1",
  });
  firstStore.close();

  const recoveredStore = new EventStore(databasePath);
  try {
    assert.equal(recoveredStore.getRun(runId)?.status, "failed");
    assert.equal(
      recoveredStore.getLatestImplementationAttempt(runId)?.status,
      "error",
    );
    const comments = recoveredStore.listGitHubCommentOutbox(runId);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.status, "pending");
    assert.match(comments[0]?.body ?? "", /stopped while this run was active/);
    assert.match(comments[0]?.marker ?? "", /implementation:interrupted/);
  } finally {
    recoveredStore.close();
  }
});
