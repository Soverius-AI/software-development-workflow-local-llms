import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config";
import type {
  GitHubPullRequestPublisher,
  PublishedPullRequest,
} from "../src/services/github/client";
import { createImplementationWorkflowImplementations } from "../src/workflows/implementation/create-step-implementations";
import type { CodexImplementationOutput } from "../src/workflows/implementation/steps/codex-implementation/codex-implementation.definition";
import { normalizeGitHubEvent } from "../src/services/github/webhook";
import { EventStore } from "../src/persistence/event-store";

class LocalPublisher implements GitHubPullRequestPublisher {
  pushedBranch: string | null = null;
  pullRequestOptions: {
    head: string;
    base: string;
    title: string;
    body: string;
  } | null = null;

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
    this.pullRequestOptions = options;
    return { number: 42, url: "https://github.test/example/app/pull/42" };
  }
}

test("Mastra owns the worktree, checks, snapshot, review stub, and PR handoff", async () => {
  const root = path.join("/tmp", `implementation-service-${randomUUID()}`);
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
  fs.writeFileSync(
    path.join(repositoryPath, ".implementer.json"),
    JSON.stringify({
      setup: [],
      checks: [
        {
          name: "test check",
          command: [process.execPath, "-e", "process.exit(0)"],
          timeoutMs: 10_000,
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repositoryPath });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    ],
    { cwd: repositoryPath },
  );

  const store = new EventStore(path.join(root, "events.sqlite"));
  try {
    const runId = store.ingest(
      normalizeGitHubEvent({
        deliveryId: "implementation-service",
        eventName: "issues",
        payload: {
          action: "opened",
          repository: { full_name: "example/app" },
          issue: {
            number: 12,
            title: "Add a result",
            body: "Create RESULT.md",
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
        GITHUB_REPOSITORY: "example/app",
        IMPLEMENTER_REPOSITORY_PATH: repositoryPath,
        IMPLEMENTER_WORKTREE_ROOT: path.join(root, "worktrees"),
      },
      root,
    );
    const publisher = new LocalPublisher();
    const implementations = createImplementationWorkflowImplementations({
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
        acceptanceCriteria: ["RESULT.md exists"],
        missingInformation: [],
        question: null,
      },
      signal,
    });
    fs.writeFileSync(path.join(prepared.worktreePath, "RESULT.md"), "done\n");
    const implemented: CodexImplementationOutput = {
      ...prepared,
      controlRunId: runId,
      correlationKey: "example/app#12",
      queuedEventsSeen: 0,
      readiness: {
        ready: true,
        summary: "Ready",
        acceptanceCriteria: ["RESULT.md exists"],
        missingInformation: [],
        question: null,
      },
      readinessEvaluationId: 1,
      codexThreadId: "test-thread",
      finalResponse: "Created RESULT.md.",
    };
    const checked = await implementations.deterministicChecks.execute(
      implemented,
      signal,
    );
    const snapshot = await implementations.snapshot.execute(checked, signal);
    const reviewed = await implementations.reviewer.execute(snapshot);
    const published = await implementations.publishPullRequest.execute(
      reviewed,
      signal,
    );

    assert.equal(checked.checkResults[0]?.exitCode, 0);
    assert.equal(reviewed.review.mode, "stub");
    assert.match(reviewed.review.summary, /No independent specialist review/);
    assert.equal(publisher.pushedBranch, prepared.branch);
    assert.equal(publisher.pullRequestOptions?.head, prepared.branch);
    assert.match(publisher.pullRequestOptions?.body ?? "", /test check/);
    assert.equal(
      published.pullRequestUrl,
      "https://github.test/example/app/pull/42",
    );
    assert.equal(store.getImplementationAttempt(prepared.attemptId)?.status, "success");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
