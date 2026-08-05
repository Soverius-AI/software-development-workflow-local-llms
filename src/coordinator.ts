import type { Workflow } from "@mastra/core/workflows";
import type { EventStore } from "./store";
import type { WorkflowRunRecord } from "./types";

export class RunCoordinator {
  private active = 0;
  private wakeHandle: NodeJS.Immediate | undefined;
  private closing = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly store: EventStore,
    private readonly workflow: Workflow<any, any, any, any, any, any, any, any>,
    private readonly maxActive: number,
    private readonly implementationMs: number,
  ) {}

  wake(): void {
    if (this.closing || this.wakeHandle) return;
    this.wakeHandle = setImmediate(() => {
      this.wakeHandle = undefined;
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.wakeHandle) {
      clearImmediate(this.wakeHandle);
      this.wakeHandle = undefined;
    }
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  get activeCount(): number {
    return this.active;
  }

  private pump(): void {
    while (this.active < this.maxActive) {
      const record =
        this.store.claimWaitingRunWithAnswer() ?? this.store.claimNextRun();
      if (!record) return;
      this.active += 1;
      void this.execute(record).finally(() => {
        this.active -= 1;
        if (this.active === 0 && this.closing) {
          for (const resolve of this.idleResolvers.splice(0)) resolve();
        } else {
          this.wake();
        }
      });
    }
  }

  private async execute(record: WorkflowRunRecord): Promise<void> {
    try {
      if (record.mastraRunId) {
        const answer = this.store.consumeHumanComment(record.id);
        if (!answer) {
          this.store.setStatus(record.id, "waiting_human", {
            question: record.pendingQuestion,
          });
          return;
        }
        const run = await this.workflow.createRun({ runId: record.mastraRunId });
        const result = await run.resume({
          step: "implementation",
          resumeData: { answer },
        });
        this.finish(record.id, result);
        return;
      }

      const run = await this.workflow.createRun();
      this.store.setMastraRunId(record.id, run.runId);
      const { requiresHuman } = this.store.getRunOptions(record.id);
      let result = await run.start({
        inputData: {
          controlRunId: record.id,
          correlationKey: record.correlationKey,
          requiresHuman,
          implementationMs: this.implementationMs,
          queuedEventsSeen: 0,
        },
      });

      if (result.status === "suspended") {
        const answer = this.store.consumeHumanComment(record.id);
        if (answer) {
          result = await run.resume({
            step: "implementation",
            resumeData: { answer },
          });
        }
      }
      this.finish(record.id, result);
    } catch (error) {
      this.store.setStatus(record.id, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private finish(recordId: string, result: { status: string; [key: string]: any }): void {
    if (result.status === "success") {
      this.store.markAllEventsConsumed(recordId);
      this.store.setStatus(recordId, "completed");
      return;
    }
    if (result.status === "suspended") {
      this.store.setStatus(recordId, "waiting_human", {
        question:
          result.suspendPayload?.question ?? "A human decision is required.",
      });
      return;
    }
    this.store.setStatus(recordId, "failed", {
      error: result.error?.message ?? `Mastra ended with ${result.status}`,
    });
  }
}
