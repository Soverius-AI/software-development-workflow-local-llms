import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import { commitImplementationSnapshot } from "../../../../services/git/snapshot";
import type { GitHubPullRequestPublisher } from "../../../../services/github/client";
import type { DemoCodexImplementationOutput } from "../codex-implementation/codex-implementation.definition";
import type { DemoPublishPullRequestOutput } from "./publish-pull-request.definition";

export class DemoPublishPullRequestImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
    private readonly publisher: GitHubPullRequestPublisher | null,
  ) {}

  async execute(
    input: DemoCodexImplementationOutput,
    signal: AbortSignal,
  ): Promise<DemoPublishPullRequestOutput> {
    try {
      if (!this.publisher) {
        throw new Error("GitHub pull-request publishing is unavailable.");
      }
      const attempt = this.store.getImplementationAttempt(input.attemptId);
      if (!attempt) {
        throw new Error(`Implementation attempt ${input.attemptId} is missing.`);
      }
      const readinessInput = this.store.getReadinessInput(attempt.runId);
      this.store.setImplementationStage(input.attemptId, "snapshotting");
      const commitSha = await commitImplementationSnapshot({
        worktreePath: input.worktreePath,
        subject: `Demo implement #${readinessInput.issueNumber ?? "event"}: ${readinessInput.title}`,
        authorName: this.config.gitAuthorName,
        authorEmail: this.config.gitAuthorEmail,
        signal,
      });
      this.store.recordImplementationSnapshot(input.attemptId, commitSha);

      this.store.setImplementationStage(input.attemptId, "publishing");
      await this.publisher.pushBranch(
        this.config.repository,
        input.worktreePath,
        input.branch,
        signal,
      );
      const pullRequest = await this.publisher.publishPullRequest(
        this.config.repository,
        {
          head: input.branch,
          base: this.config.baseBranch,
          title:
            readinessInput.title ||
            `Demo implement issue #${readinessInput.issueNumber}`,
          body: formatDemoPullRequestBody({
            issueNumber: readinessInput.issueNumber,
            summary: input.finalResponse,
          }),
        },
      );
      this.store.completeImplementationAttempt(input.attemptId, pullRequest.url);
      return { ...input, commitSha, pullRequestUrl: pullRequest.url };
    } catch (error) {
      this.store.failImplementationAttempt(input.attemptId, error);
      throw error;
    }
  }
}

function formatDemoPullRequestBody(input: {
  issueNumber: number | null;
  summary: string;
}): string {
  const closes = input.issueNumber === null ? "" : `\n\nCloses #${input.issueNumber}`;
  return `## Demo implementation

${input.summary || "Codex completed the requested implementation."}

## Assurance boundary

This pull request was created by the reduced demo workflow after readiness and an isolated Codex implementation. It did not run the externally managed deterministic checks, persistent goal validation, or independent review used by the production workflow.${closes}`;
}
