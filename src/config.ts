import path from "node:path";

export interface AppConfig {
  port: number;
  databasePath: string;
  mastraDatabaseUrl: string;
  githubWebhookSecret: string | null;
  githubBotLogin: string;
  githubApp: {
    appId: string;
    installationId: string;
    privateKeyPath: string;
    apiBaseUrl: string;
    timeoutMs: number;
  } | null;
  githubOutboxRetryBaseMs: number;
  githubOutboxMaxAttempts: number;
  maxActiveImplementations: number;
  simulatedImplementationMs: number;
  readinessModel: {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    timeoutMs: number;
  };
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
  const githubApp = loadGitHubAppConfig(env, baseDirectory);
  return {
    port: Number(env.PORT ?? 4317),
    databasePath,
    mastraDatabaseUrl,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
    githubBotLogin: env.GITHUB_BOT_LOGIN ?? "loop-engineering-bot",
    githubApp,
    githubOutboxRetryBaseMs: Math.max(
      1,
      Number(env.GITHUB_OUTBOX_RETRY_BASE_MS ?? 5_000),
    ),
    githubOutboxMaxAttempts: Math.max(
      1,
      Number(env.GITHUB_OUTBOX_MAX_ATTEMPTS ?? 8),
    ),
    maxActiveImplementations: Math.max(1, Number(env.MAX_ACTIVE_IMPLEMENTATIONS ?? 1)),
    simulatedImplementationMs: Math.max(
      0,
      Number(env.SIMULATED_IMPLEMENTATION_MS ?? 250),
    ),
    readinessModel: {
      baseUrl: env.MODEL_BASE_URL ?? "http://127.0.0.1:8888/v1",
      apiKey: env.MODEL_API_KEY ?? "local",
      modelId:
        env.READINESS_MODEL ??
        "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL",
      timeoutMs: Math.max(1, Number(env.READINESS_TIMEOUT_MS ?? 120_000)),
    },
  };
}

function loadGitHubAppConfig(
  env: NodeJS.ProcessEnv,
  baseDirectory: string,
): AppConfig["githubApp"] {
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId && !installationId && !privateKeyPath) return null;
  if (!appId || !installationId || !privateKeyPath) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY_PATH must be configured together.",
    );
  }
  return {
    appId,
    installationId,
    privateKeyPath: path.resolve(baseDirectory, privateKeyPath),
    apiBaseUrl: (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(
      /\/$/,
      "",
    ),
    timeoutMs: Math.max(1, Number(env.GITHUB_API_TIMEOUT_MS ?? 15_000)),
  };
}

function resolveDatabaseUrl(value: string, baseDirectory: string): string {
  if (!value.startsWith("file:")) return value;
  const databasePath = value.slice("file:".length);
  return `file:${path.resolve(baseDirectory, databasePath)}`;
}
