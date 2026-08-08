import fs from "node:fs";
import { z } from "zod";
import type { ImplementationCheckDefinition } from "./contracts";

const commandSchema = z.object({
  name: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive(),
});

const repositoryConfigSchema = z.object({
  setup: z.array(commandSchema).default([]),
  checks: z.array(commandSchema).min(1),
});

export interface RepositoryCheckConfiguration {
  setup: ImplementationCheckDefinition[];
  checks: ImplementationCheckDefinition[];
}

export function loadRepositoryCheckConfiguration(
  configPath: string,
): RepositoryCheckConfiguration {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Repository check configuration does not exist: ${configPath}`);
  }
  return repositoryConfigSchema.parse(
    JSON.parse(fs.readFileSync(configPath, "utf8")),
  );
}
