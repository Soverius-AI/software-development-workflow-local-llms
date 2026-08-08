import fs from "node:fs";
import path from "node:path";
import { runCheckedProcess } from "../../shared/process";

export async function createImplementationWorktree(input: {
  repositoryPath: string;
  worktreeRoot: string;
  runId: string;
  branch: string;
  baseBranch: string;
  signal: AbortSignal;
}): Promise<{ worktreePath: string; baseSha: string }> {
  const baseSha = (
    await runCheckedProcess(
      "git",
      ["rev-parse", `refs/remotes/origin/${input.baseBranch}`],
      {
        cwd: input.repositoryPath,
        timeoutMs: 30_000,
        signal: input.signal,
      },
    )
  ).output.trim();
  fs.mkdirSync(input.worktreeRoot, { recursive: true });
  const worktreePath = path.join(input.worktreeRoot, input.runId);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  await runCheckedProcess(
    "git",
    ["worktree", "add", "-b", input.branch, worktreePath, baseSha],
    {
      cwd: input.repositoryPath,
      timeoutMs: 60_000,
      signal: input.signal,
    },
  );
  return { worktreePath, baseSha };
}
