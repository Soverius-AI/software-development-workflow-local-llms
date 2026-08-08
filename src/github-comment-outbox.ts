import type { GitHubCommentPublisher } from "./github-comments";
import type { EventStore } from "./store";

export class GitHubCommentOutboxWorker {
  private active = false;
  private closing = false;
  private wakeHandle: NodeJS.Immediate | undefined;
  private retryHandle: NodeJS.Timeout | undefined;
  private closeResolvers: Array<() => void> = [];

  constructor(
    private readonly store: EventStore,
    private readonly publisher: GitHubCommentPublisher,
    private readonly retryBaseMs: number,
    private readonly maxAttempts: number,
  ) {}

  wake(): void {
    if (this.closing || this.active || this.wakeHandle) return;
    if (this.retryHandle) {
      clearTimeout(this.retryHandle);
      this.retryHandle = undefined;
    }
    this.wakeHandle = setImmediate(() => {
      this.wakeHandle = undefined;
      void this.pump();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.wakeHandle) clearImmediate(this.wakeHandle);
    if (this.retryHandle) clearTimeout(this.retryHandle);
    this.wakeHandle = undefined;
    this.retryHandle = undefined;
    if (!this.active) return;
    await new Promise<void>((resolve) => this.closeResolvers.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.active || this.closing) return;
    this.active = true;
    try {
      while (!this.closing) {
        const item = this.store.claimNextGitHubComment();
        if (!item) break;
        try {
          const existing = await this.publisher.findByMarker(
            item.repository,
            item.issueNumber,
            item.marker,
          );
          const comment =
            existing ??
            (await this.publisher.publish(
              item.repository,
              item.issueNumber,
              item.body,
            ));
          this.store.completeGitHubComment(item.id, comment);
        } catch (error) {
          const delay = Math.min(
            this.retryBaseMs * 2 ** Math.max(0, item.attempts - 1),
            5 * 60_000,
          );
          this.store.failGitHubComment(
            item.id,
            error,
            this.maxAttempts,
            new Date(Date.now() + delay).toISOString(),
          );
        }
      }
    } finally {
      this.active = false;
      if (this.closing) {
        for (const resolve of this.closeResolvers.splice(0)) resolve();
      } else {
        this.scheduleNextAttempt();
      }
    }
  }

  private scheduleNextAttempt(): void {
    const nextAt = this.store.nextGitHubCommentAt();
    if (!nextAt || this.retryHandle || this.closing) return;
    const delay = Math.max(0, Date.parse(nextAt) - Date.now());
    this.retryHandle = setTimeout(() => {
      this.retryHandle = undefined;
      this.wake();
    }, delay);
  }
}
