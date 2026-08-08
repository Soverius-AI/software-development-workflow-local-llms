import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NativeGoalEvidence {
  created: boolean;
  completed: boolean;
  rolloutPath: string | null;
}

export function readNativeGoalEvidence(threadId: string): NativeGoalEvidence {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return { created: false, completed: false, rolloutPath: null };
  }
  const rolloutPath = fs
    .globSync("**/*.jsonl", { cwd: sessionsRoot })
    .map((candidate) => path.join(sessionsRoot, candidate))
    .find((candidate) => candidate.endsWith(`-${threadId}.jsonl`));
  if (!rolloutPath) {
    return { created: false, completed: false, rolloutPath: null };
  }

  const createCallIds = new Set<string>();
  const completeCallIds = new Set<string>();
  const successfulCallIds = new Set<string>();
  for (const line of fs.readFileSync(rolloutPath, "utf8").split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    if (entry?.type !== "response_item") continue;
    if (payload?.type === "function_call") {
      if (payload.name === "create_goal") createCallIds.add(payload.call_id);
      if (payload.name === "update_goal") {
        try {
          if (JSON.parse(payload.arguments)?.status === "complete") {
            completeCallIds.add(payload.call_id);
          }
        } catch {
          // An invalid tool call cannot establish completion.
        }
      }
    }
    if (payload?.type === "function_call_output") {
      try {
        const output = JSON.parse(payload.output);
        if (
          output?.goal?.status === "active" ||
          output?.goal?.status === "complete"
        ) {
          successfulCallIds.add(payload.call_id);
        }
      } catch {
        // An invalid tool result cannot establish goal state.
      }
    }
  }
  return {
    created: [...createCallIds].some((id) => successfulCallIds.has(id)),
    completed: [...completeCallIds].some((id) => successfulCallIds.has(id)),
    rolloutPath,
  };
}
