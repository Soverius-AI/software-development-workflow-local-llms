import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config";
import { EventStore } from "../src/persistence/event-store";
import { normalizeGitHubEvent } from "../src/services/github/webhook";
import type {
  GitHubPullRequestPublisher,
  PublishedPullRequest,
} from "../src/services/github/client";
import { createDemoImplementationWorkflowImplementations } from "../src/workflows/demo-implementation/create-step-implementations";

class LocalPublisher implements GitHubPullRequestPublisher {
  pushedBranch: string | null = null;
  pullRequestBody: string | null = null;

  async fetchBase(
    _repository: string,
    repositoryPath: string,
    baseBranch: string,
  ): Promise<void> {
    execFileSync("git", ["update-ref", `refs/remotes/origin/${baseBranch}`, "HEAD"], {
      cwd: repositoryPath,
    });
  }

  async pushBranch(
    _repository: string,
    _worktreePath: string,
    branch: string,
  ): Promise<void> {
    this.pushedBranch = branch;
  }

  async publishPullRequest(
    _repository: string,
    options: { head: string; base: string; title: string; body: string },
  ): Promise<PublishedPullRequest> {
    this.pullRequestBody = options.body;
    return { number: 7, url: "https://github.test/example/app/pull/7" };
  }
}

test("the demo path snapshots and publishes without running configured checks", async () => {
  const root = path.join("/tmp", `demo-implementation-${randomUUID()}`);
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
  fs.writeFileSync(
    path.join(repositoryPath, ".implementer.json"),
    JSON.stringify({
      setup: [],
      checks: [
        {
          name: "must not run in demo",
          command: [process.execPath, "-e", "process.exit(1)"],
          timeoutMs: 10_000,
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"],
    { cwd: repositoryPath },
  );

  const store = new EventStore(path.join(root, "events.sqlite"));
  try {
    const runId = store.ingest(
      normalizeGitHubEvent({
        deliveryId: "demo-implementation",
        eventName: "issues",
        payload: {
          action: "opened",
          repository: { full_name: "example/app" },
          issue: {
            number: 9,
            title: "Add a demo result",
            body: "Create DEMO.md",
            labels: [],
          },
          sender: { login: "alice" },
        },
      }),
      "loop-bot",
    ).runId!;
    store.claimNextRun();
    const config = loadConfig(
      {
        IMPLEMENTER_WORKFLOW: "demo",
        GITHUB_REPOSITORY: "example/app",
        IMPLEMENTER_REPOSITORY_PATH: repositoryPath,
        IMPLEMENTER_WORKTREE_ROOT: path.join(root, "worktrees"),
      },
      root,
    );
    const publisher = new LocalPublisher();
    const implementations = createDemoImplementationWorkflowImplementations({
      config: config.implementation,
      store,
      publisher,
      readinessEvaluator: {
        modelId: "unused",
        promptVersion: "unused",
        evaluate: async () => {
          throw new Error("Readiness is outside this test.");
        },
      },
    });
    const signal = new AbortController().signal;
    const prepared = await implementations.prepareWorktree.execute({
      controlRunId: runId,
      readiness: {
        ready: true,
        summary: "Ready",
        acceptanceCriteria: ["DEMO.md exists"],
        missingInformation: [],
        question: null,
      },
      signal,
    });
    fs.writeFileSync(path.join(prepared.worktreePath, "DEMO.md"), "done\n");
    const published = await implementations.publishPullRequest.execute(
      {
        ...prepared,
        controlRunId: runId,
        correlationKey: "example/app#9",
        queuedEventsSeen: 0,
        readiness: {
          ready: true,
          summary: "Ready",
          acceptanceCriteria: ["DEMO.md exists"],
          missingInformation: [],
          question: null,
        },
        readinessEvaluationId: 1,
        codexThreadId: "demo-thread",
        finalResponse: "Created DEMO.md.",
      },
      signal,
    );

    const attempt = store.getImplementationAttempt(prepared.attemptId);
    assert.equal(attempt?.promptVersion, "codex-demo-no-goal-v1");
    assert.equal(attempt?.checkResults, null);
    assert.equal(attempt?.status, "success");
    assert.equal(publisher.pushedBranch, prepared.branch);
    assert.match(publisher.pullRequestBody ?? "", /reduced demo workflow/);
    assert.match(publisher.pullRequestBody ?? "", /did not run/);
    assert.equal(published.pullRequestUrl, "https://github.test/example/app/pull/7");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
