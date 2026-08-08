import { Agent } from "@mastra/core/agent";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { ReadinessEvaluator, ReadinessInput } from "./contracts";

export const READINESS_PROMPT_VERSION = "readiness-v1";

export function createReadinessEvaluator<TDecision>(
  config: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    timeoutMs: number;
  },
  decisionSchema: z.ZodType<TDecision>,
): {
  evaluator: ReadinessEvaluator<TDecision>;
  agent: Agent;
} {
  const provider = createOpenAICompatible({
    name: "local-llama",
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    supportsStructuredOutputs: true,
  });
  const agent = new Agent({
    id: "issue-readiness",
    name: "Issue readiness",
    description: "Checks whether a GitHub work item is sufficiently specified.",
    instructions: [
      "You assess whether a software-development work item is ready for implementation.",
      "Use only the supplied issue and clarification text. Never invent product decisions, constraints, visual references, or acceptance criteria.",
      "A ready item states a clear desired outcome and enough observable acceptance criteria and constraints for an implementer to work without guessing.",
      "When information is missing, return ready=false, list only the material gaps, and ask one concise question that helps the human resolve them.",
      "When ready=true, missingInformation must be empty and question must be null.",
    ].join("\n"),
    model: provider(config.modelId),
    maxRetries: 0,
  });

  return {
    agent,
    evaluator: {
      modelId: config.modelId,
      promptVersion: READINESS_PROMPT_VERSION,
      async evaluate(input, options) {
        const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
        const result = await agent.generate(buildReadinessPrompt(input), {
          structuredOutput: {
            schema: decisionSchema,
            jsonPromptInjection: "auto",
          },
          abortSignal: AbortSignal.any([options.abortSignal, timeoutSignal]),
        });
        const decision = decisionSchema.parse(result.object);
        return {
          decision,
          modelId: config.modelId,
          promptVersion: READINESS_PROMPT_VERSION,
          traceId: result.traceId ?? null,
          finishReason: result.finishReason
            ? String(result.finishReason)
            : null,
          usage: JSON.parse(JSON.stringify(result.totalUsage ?? null)) as unknown,
        };
      },
    },
  };
}

function buildReadinessPrompt(input: ReadinessInput): string {
  return [
    "Assess this work item for implementation readiness.",
    "Do not infer requirements that are absent from the input.",
    JSON.stringify(
      {
        repository: input.repository,
        issueNumber: input.issueNumber,
        title: input.title,
        body: input.body,
        labels: input.labels,
        humanClarifications: input.clarifications,
      },
      null,
      2,
    ),
  ].join("\n\n");
}
