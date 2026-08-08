import type { Workflow } from "@mastra/core/workflows";
import type { WorkflowRunRecord } from "../persistence/records";
import type { EventStore } from "../persistence/event-store";

export class RunCoordinator {
  private active = 0;
  private wakeHandle: NodeJS.Immediate | undefined;
  private closing = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly store: EventStore,
    private readonly workflow: Workflow<any, any, any, any, any, any, any, any>,
    private readonly maxActive: number,
    private readonly onGitHubCommentQueued: () => void = () => {},
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
        if (!record.pendingStep) {
          throw new Error(`Run ${record.id} has no suspended step to resume.`);
        }
        const result = await run.resume({
          step: record.pendingStep,
          resumeData: { answer },
        });
        this.finish(record.id, result);
        return;
      }

      const run = await this.workflow.createRun();
      this.store.setMastraRunId(record.id, run.runId);
      const result = await run.start({
        inputData: {
          controlRunId: record.id,
          correlationKey: record.correlationKey,
          queuedEventsSeen: 0,
        },
      });

      this.finish(record.id, result);
    } catch (error) {
      const queued = this.store.failRunAndEnqueueComment(record.id, error);
      if (queued) this.onGitHubCommentQueued();
    }
  }

  private finish(
    recordId: string,
    result: {
      status: string;
      steps?: Record<string, { status?: string; suspendPayload?: any }>;
      suspendPayload?: any;
      [key: string]: any;
    },
  ): void {
    if (result.status === "success") {
      this.store.markAllEventsConsumed(recordId);
      this.store.setStatus(recordId, "completed");
      return;
    }
    if (result.status === "suspended") {
      const suspension = findSuspension(result);
      const question =
        suspension?.payload?.question ?? "A human decision is required.";
      const evaluationId = suspension?.payload?.evaluationId ?? "unknown";
      const marker = `<!-- mastra-loop:${recordId}:readiness:${evaluationId} -->`;
      const missingInformation = Array.isArray(
        suspension?.payload?.missingInformation,
      )
        ? (suspension.payload.missingInformation as unknown[]).filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const body = formatReadinessQuestion(
        question,
        missingInformation,
        marker,
      );
      const queued = this.store.suspendRunAndEnqueueQuestion(recordId, {
        step: suspension?.stepId ?? null,
        question,
        marker,
        body,
      });
      if (queued) this.onGitHubCommentQueued();
      return;
    }
    const queued = this.store.failRunAndEnqueueComment(
      recordId,
      result.error?.message ?? `Mastra ended with ${result.status}`,
    );
    if (queued) this.onGitHubCommentQueued();
  }
}

function formatReadinessQuestion(
  question: string,
  missingInformation: string[],
  marker: string,
): string {
  const missing =
    missingInformation.length === 0
      ? ""
      : `\n\nMissing information:\n${missingInformation
          .map((item) => `- ${item}`)
          .join("\n")}`;
  return `### Readiness needs clarification\n\n${question}${missing}\n\nReply to this issue with the missing details. The same implementation run will continue.\n\n${marker}`;
}

function findSuspension(result: {
  steps?: Record<string, { status?: string; suspendPayload?: any }>;
  suspendPayload?: any;
}): { stepId: string; payload: any } | null {
  for (const [stepId, step] of Object.entries(result.steps ?? {})) {
    if (step.status === "suspended") {
      return {
        stepId,
        payload: step.suspendPayload ?? result.suspendPayload,
      };
    }
  }
  return null;
}
