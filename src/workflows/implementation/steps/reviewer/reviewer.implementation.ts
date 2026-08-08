import type { EventStore } from "../../../../persistence/event-store";
import type { SnapshotOutput } from "../snapshot/snapshot.definition";
import type { ReviewerOutput } from "./reviewer.definition";

export class ReviewerImplementation {
  constructor(private readonly store: EventStore) {}

  async execute(input: SnapshotOutput): Promise<ReviewerOutput> {
    this.store.setImplementationStage(input.attemptId, "reviewing");
    const review = {
      mode: "stub" as const,
      decision: "approved" as const,
      summary:
        "Temporary control-flow approval only. No independent specialist review was performed.",
    };
    this.store.recordStubReview(input.attemptId, review);
    return { ...input, review };
  }
}
