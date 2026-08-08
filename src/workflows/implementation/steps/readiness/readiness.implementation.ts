import type { EventStore } from "../../../../persistence/event-store";
import type { ReadinessEvaluator } from "../../../../services/readiness/contracts";
import { PRODUCTION_GRAPH_VERSION } from "../../../definitions";
import type { ReadinessDecision } from "./readiness.definition";

export class ReadinessImplementation {
  constructor(
    private readonly store: EventStore,
    private readonly evaluator: ReadinessEvaluator<ReadinessDecision>,
  ) {}

  async execute(input: {
    controlRunId: string;
    resumeAnswer?: string;
    signal: AbortSignal;
  }): Promise<{ readiness: ReadinessDecision; readinessEvaluationId: number }> {
    const readinessInput = this.store.getReadinessInput(input.controlRunId);
    if (
      input.resumeAnswer &&
      !readinessInput.clarifications.includes(input.resumeAnswer)
    ) {
      readinessInput.clarifications.push(input.resumeAnswer);
    }
    const evaluationId = this.store.startReadinessEvaluation(
      input.controlRunId,
      readinessInput,
      this.evaluator.modelId,
      this.evaluator.promptVersion,
      PRODUCTION_GRAPH_VERSION,
    );
    try {
      const evaluation = await this.evaluator.evaluate(readinessInput, {
        abortSignal: input.signal,
      });
      this.store.completeReadinessEvaluation(evaluationId, evaluation);
      return {
        readiness: evaluation.decision,
        readinessEvaluationId: evaluationId,
      };
    } catch (error) {
      this.store.failReadinessEvaluation(evaluationId, error);
      throw error;
    }
  }
}
