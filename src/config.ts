import path from "node:path";

export interface AppConfig {
  port: number;
  databasePath: string;
  mastraDatabaseUrl: string;
  githubWebhookSecret: string | null;
  githubBotLogin: string;
  maxActiveImplementations: number;
  simulatedImplementationMs: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): AppConfig {
  const databasePath = path.resolve(
    baseDirectory,
    env.DATABASE_PATH ?? ".data/events.sqlite",
  );
  const mastraDatabaseUrl = resolveDatabaseUrl(
    env.MASTRA_DATABASE_URL ?? "file:.data/mastra.sqlite",
    baseDirectory,
  );
  return {
    port: Number(env.PORT ?? 4317),
    databasePath,
    mastraDatabaseUrl,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
    githubBotLogin: env.GITHUB_BOT_LOGIN ?? "loop-engineering-bot",
    maxActiveImplementations: Math.max(1, Number(env.MAX_ACTIVE_IMPLEMENTATIONS ?? 1)),
    simulatedImplementationMs: Math.max(
      0,
      Number(env.SIMULATED_IMPLEMENTATION_MS ?? 250),
    ),
  };
}

function resolveDatabaseUrl(value: string, baseDirectory: string): string {
  if (!value.startsWith("file:")) return value;
  const databasePath = value.slice("file:".length);
  return `file:${path.resolve(baseDirectory, databasePath)}`;
}
