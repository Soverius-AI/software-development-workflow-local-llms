import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
  },
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const maxOutputBytes = options.maxOutputBytes ?? 200_000;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;

    const capture = (chunk: Buffer | string) => {
      if (outputBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - outputBytes;
      chunks.push(buffer.subarray(0, remaining));
      outputBytes += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) truncated = true;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", reject);
    child.once("close", (code, childSignal) => {
      const suffix = truncated ? "\n[output truncated]" : "";
      const output = `${Buffer.concat(chunks).toString("utf8")}${suffix}`;
      if (childSignal) {
        reject(new Error(`${command} was terminated by ${childSignal}. ${output}`));
        return;
      }
      resolve({
        exitCode: code ?? 1,
        output,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runCheckedProcess(
  command: string,
  args: string[],
  options: Parameters<typeof runProcess>[2],
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.exitCode}.\n${result.output}`,
    );
  }
  return result;
}
