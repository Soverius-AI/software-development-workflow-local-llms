import type { EventStore } from "../../persistence/event-store";
import type {
  ImplementationCheckDefinition,
  ImplementationCheckResult,
} from "./contracts";
import { runCheckedProcess, runProcess } from "../../shared/process";

export async function runSetupCommands(input: {
  commands: ImplementationCheckDefinition[];
  attemptId: number;
  worktreePath: string;
  signal: AbortSignal;
  store: EventStore;
}): Promise<void> {
  for (const setup of input.commands) {
    const [command, ...args] = setup.command;
    if (!command) throw new Error(`Setup command ${setup.name} is empty.`);
    const result = await runCheckedProcess(command, args, {
      cwd: input.worktreePath,
      timeoutMs: setup.timeoutMs,
      signal: input.signal,
    });
    input.store.appendImplementationEvent(input.attemptId, {
      type: "setup.completed",
      name: setup.name,
      command: setup.command,
      durationMs: result.durationMs,
      output: result.output,
    });
  }
}

export async function runDeterministicChecks(input: {
  checks: ImplementationCheckDefinition[];
  attemptId: number;
  worktreePath: string;
  signal: AbortSignal;
  store: EventStore;
}): Promise<ImplementationCheckResult[]> {
  const results: ImplementationCheckResult[] = [];
  for (const check of input.checks) {
    const [command, ...args] = check.command;
    if (!command) throw new Error(`Check ${check.name} has an empty command.`);
    const result = await runProcess(command, args, {
      cwd: input.worktreePath,
      timeoutMs: check.timeoutMs,
      signal: input.signal,
    });
    const checkResult = { ...check, ...result };
    results.push(checkResult);
    input.store.recordImplementationCheck(input.attemptId, checkResult);
    if (result.exitCode !== 0) {
      throw new Error(
        `Deterministic check ${check.name} failed with exit code ${result.exitCode}.\n${result.output}`,
      );
    }
  }
  return results;
}
