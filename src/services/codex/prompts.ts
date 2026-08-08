export const IMPLEMENTATION_PROMPT_VERSION = "codex-goal-v1";
export const DEMO_IMPLEMENTATION_PROMPT_VERSION = "codex-demo-no-goal-v1";

export function formatGoal(input: {
  title: string;
  body: string;
  clarifications: string[];
  acceptanceCriteria: string[];
}): string {
  const criteria = input.acceptanceCriteria.map((item) => `- ${item}`).join("\n");
  const clarifications = input.clarifications.length
    ? input.clarifications.map((item) => `- ${item}`).join("\n")
    : "- None";
  return `Implement the accepted GitHub issue completely in the assigned worktree.

Issue: ${input.title}

Description:
${input.body}

Human clarifications:
${clarifications}

Acceptance criteria:
${criteria}

Preserve repository guidance and scope. Produce the code and tests needed to satisfy every acceptance criterion. Do not push, create a pull request, change branches, or mark the goal complete until the implementation is genuinely finished and verified.`;
}

export function formatImplementationPrompt(
  goal: string,
  checkConfigPath: string,
): string {
  return `You are the single write-capable implementation worker.

Your first action must be to call the native create_goal command with the full objective below. Do not set a token budget. Do not begin implementation before the goal exists. Continue working against that native goal until every acceptance criterion is satisfied. Call update_goal with status complete only after current evidence proves the entire objective is complete.

${goal}

Mastra owns the worktree, branch, commit, push, and pull request. Do not perform those Git operations. Do not edit ${checkConfigPath}; its commands are the independent deterministic verification boundary. You may run focused checks for self-correction, but Mastra will run the recorded checks separately after your goal completes. If an eligible permission request is necessary, use the normal approval mechanism; automatic review is configured.`;
}

export function formatDemoImplementationPrompt(
  objective: string,
  checkConfigPath: string,
): string {
  return `You are the single write-capable implementation worker in a deliberately reduced-assurance demo workflow.

${objective}

Implement the requested change completely in the assigned worktree. Do not create or update a native Codex goal. Preserve repository guidance and scope, inspect your work, and run focused checks when useful for self-correction.

Mastra owns the worktree, branch, commit, push, and pull request. Do not perform those Git operations. Do not edit ${checkConfigPath}. This demo workflow will publish your result without externally managed deterministic checks or independent review, so state any verification you performed accurately in your final response.`;
}
