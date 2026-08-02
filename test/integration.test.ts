import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

function config(implementationMs = 150): AppConfig {
  const id = randomUUID();
  return {
    port: 0,
    databasePath: path.join("/tmp", `loop-events-${id}.sqlite`),
    mastraDatabaseUrl: `file:${path.join("/tmp", `loop-mastra-${id}.sqlite`)}`,
    githubWebhookSecret: null,
    githubBotLogin: "loop-bot",
    maxActiveImplementations: 1,
    simulatedImplementationMs: implementationMs,
  };
}

function payload(issue: number, labels: string[] = []) {
  return {
    action: "opened",
    repository: { full_name: "example/app" },
    issue: { number: issue, labels: labels.map((name) => ({ name })) },
    sender: { login: "alice" },
  };
}

test("an event arriving during a run is attached without starting a second run", async () => {
  const app = await createApp(config(250));
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
  const app = await createApp(config(10));
  try {
    const first = app.eventStore.ingest(
      event("d1", "issues", payload(7, ["needs-human"])),
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
        issue: { number: 7, labels: [{ name: "needs-human" }] },
        comment: { body: "Prefer the simpler architecture." },
        sender: { login: "reviewer" },
      }),
      "loop-bot",
    );
    assert.equal(comment.outcome, "resume_requested");
    app.coordinator.wake();
    await waitFor(() => app.eventStore.getRun(first.runId!)?.status === "completed");
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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for state change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
