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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = path.resolve(env.DATABASE_PATH ?? ".data/events.sqlite");
  return {
    port: Number(env.PORT ?? 4317),
    databasePath,
    mastraDatabaseUrl:
      env.MASTRA_DATABASE_URL ?? `file:${path.resolve(".data/mastra.sqlite")}`,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
    githubBotLogin: env.GITHUB_BOT_LOGIN ?? "loop-engineering-bot",
    maxActiveImplementations: Math.max(1, Number(env.MAX_ACTIVE_IMPLEMENTATIONS ?? 1)),
    simulatedImplementationMs: Math.max(
      0,
      Number(env.SIMULATED_IMPLEMENTATION_MS ?? 250),
    ),
  };
}
