export interface ReadinessInput {
  controlRunId: string;
  correlationKey: string;
  repository: string;
  issueNumber: number | null;
  title: string;
  body: string;
  labels: string[];
  clarifications: string[];
}

export interface ReadinessEvaluation<TDecision> {
  decision: TDecision;
  modelId: string;
  promptVersion: string;
  traceId: string | null;
  finishReason: string | null;
  usage: unknown;
}

export interface ReadinessEvaluator<TDecision> {
  readonly modelId: string;
  readonly promptVersion: string;
  evaluate(
    input: ReadinessInput,
    options: { abortSignal: AbortSignal },
  ): Promise<ReadinessEvaluation<TDecision>>;
}
