export interface ImplementationCheckDefinition {
  name: string;
  command: string[];
  timeoutMs: number;
}

export interface ImplementationCheckResult {
  name: string;
  command: string[];
  exitCode: number;
  output: string;
  durationMs: number;
}
