import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { normalizeGitHubEvent, verifyGitHubSignature } from "../src/github.js";
import { EventStore } from "../src/store.js";
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

test("signature verification uses the raw request body", () => {
  const body = Buffer.from('{"hello":"world"}');
  const secret = "test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature(body, signature, secret), true);
  assert.equal(verifyGitHubSignature(Buffer.from("changed"), signature, secret), false);
});
