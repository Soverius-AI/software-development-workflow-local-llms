import type { AppConfig } from "../../../../config";
import type { EventStore } from "../../../../persistence/event-store";
import type { GitHubPullRequestPublisher } from "../../../../services/github/client";
import { formatPullRequestBody } from "../../../../services/github/pull-request-body";
import type { ReviewerOutput } from "../reviewer/reviewer.definition";
import type { PublishPullRequestOutput } from "./publish-pull-request.definition";

export class PublishPullRequestImplementation {
  constructor(
    private readonly config: AppConfig["implementation"],
    private readonly store: EventStore,
    private readonly publisher: GitHubPullRequestPublisher | null,
  ) {}

  async execute(
    input: ReviewerOutput,
    signal: AbortSignal,
  ): Promise<PublishPullRequestOutput & { queuedEventsSeen: number }> {
    this.store.setImplementationStage(input.attemptId, "publishing");
    try {
      if (!this.publisher) {
        throw new Error("GitHub pull-request publishing is unavailable.");
      }
      const attempt = this.store.getImplementationAttempt(input.attemptId);
      if (!attempt) {
        throw new Error(`Implementation attempt ${input.attemptId} is missing.`);
      }
      const readinessInput = this.store.getReadinessInput(attempt.runId);
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
            `Implement issue #${readinessInput.issueNumber}`,
          body: formatPullRequestBody({
            issueNumber: readinessInput.issueNumber,
            summary: input.finalResponse,
            checkResults: input.checkResults,
            reviewSummary: input.review.summary,
          }),
        },
      );
      this.store.completeImplementationAttempt(input.attemptId, pullRequest.url);
      return {
        ...input,
        pullRequestUrl: pullRequest.url,
        queuedEventsSeen: this.store.countQueuedEvents(attempt.runId),
      };
    } catch (error) {
      this.store.failImplementationAttempt(input.attemptId, error);
      throw error;
    }
  }
}
