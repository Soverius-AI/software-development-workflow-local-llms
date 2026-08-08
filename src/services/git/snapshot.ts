import { runCheckedProcess } from "../../shared/process";

export async function commitImplementationSnapshot(input: {
  worktreePath: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  signal: AbortSignal;
}): Promise<string> {
  const status = await runCheckedProcess("git", ["status", "--porcelain"], {
    cwd: input.worktreePath,
    timeoutMs: 30_000,
    signal: input.signal,
  });
  if (!status.output.trim()) {
    throw new Error("Codex completed the goal without producing a repository change.");
  }
  await runCheckedProcess("git", ["add", "--all"], {
    cwd: input.worktreePath,
    timeoutMs: 30_000,
    signal: input.signal,
  });
  await runCheckedProcess(
    "git",
    [
      "-c",
      `user.name=${input.authorName}`,
      "-c",
      `user.email=${input.authorEmail}`,
      "commit",
      "-m",
      input.subject.slice(0, 200),
    ],
    { cwd: input.worktreePath, timeoutMs: 60_000, signal: input.signal },
  );
  return (
    await runCheckedProcess("git", ["rev-parse", "HEAD"], {
      cwd: input.worktreePath,
      timeoutMs: 30_000,
      signal: input.signal,
    })
  ).output.trim();
}
