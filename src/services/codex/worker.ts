import { Codex } from "@openai/codex-sdk";
import type { AppConfig } from "../../config";
import type { EventStore } from "../../persistence/event-store";
import { readNativeGoalEvidence } from "./goal-evidence";
import { formatImplementationPrompt } from "./prompts";

export async function runCodexWorker(input: {
  prepared: {
    attemptId: number;
    worktreePath: string;
    goal: string;
  };
  signal: AbortSignal;
  config: AppConfig["implementation"];
  store: EventStore;
}): Promise<{ codexThreadId: string; finalResponse: string }> {
  const { prepared, config, store } = input;
  const codex = new Codex({
    apiKey: config.model.apiKey,
    config: {
      model_provider: "implementer_local",
      model_providers: {
        implementer_local: {
          name: "Configured local implementer",
          base_url: config.model.baseUrl,
          wire_api: "responses",
          requires_openai_auth: false,
        },
      },
      approvals_reviewer: "auto_review",
      features: { goals: true },
      web_search: "disabled",
    },
  });
  const thread = codex.startThread({
    model: config.model.modelId,
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    workingDirectory: prepared.worktreePath,
    networkAccessEnabled: false,
  });
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(config.timeoutMs),
  ]);
  const prompt = formatImplementationPrompt(
    prepared.goal,
    config.checkConfigPath,
  );
  const { events } = await thread.runStreamed(prompt, { signal });
  let finalResponse = "";
  let threadId: string | null = null;
  let turnFailure: string | null = null;

  for await (const event of events) {
    store.appendImplementationEvent(prepared.attemptId, event);
    if (event.type === "thread.started") {
      threadId = event.thread_id;
      store.setCodexThreadId(prepared.attemptId, threadId);
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      finalResponse = event.item.text;
    }
    if (event.type === "turn.failed") turnFailure = event.error.message;
  }
  if (turnFailure) throw new Error(turnFailure);
  if (!threadId) throw new Error("Codex did not return a thread ID.");

  const goalEvidence = readNativeGoalEvidence(threadId);
  store.appendImplementationEvent(prepared.attemptId, {
    type: "codex.goal.evidence",
    ...goalEvidence,
  });
  if (!goalEvidence.created) {
    throw new Error("Codex finished without using the required native goal command.");
  }
  if (!goalEvidence.completed) {
    throw new Error("Codex finished without completing its native goal.");
  }
  return { codexThreadId: threadId, finalResponse };
}
