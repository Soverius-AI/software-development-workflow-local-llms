import path from "node:path";

export interface AppConfig {
  workflowMode: "production" | "demo";
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
    gitBaseUrl: string;
    timeoutMs: number;
  } | null;
  githubOutboxRetryBaseMs: number;
  githubOutboxMaxAttempts: number;
  maxActiveImplementations: number;
  implementation: {
    repository: string;
    repositoryPath: string;
    baseBranch: string;
    worktreeRoot: string;
    checkConfigPath: string;
    timeoutMs: number;
    model: {
      baseUrl: string;
      apiKey: string;
      modelId: string;
    };
    gitAuthorName: string;
    gitAuthorEmail: string;
  };
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
  const modelBaseUrl = env.MODEL_BASE_URL ?? "http://127.0.0.1:8888/v1";
  const modelApiKey = env.MODEL_API_KEY ?? "local";
  const readinessModelId =
    env.READINESS_MODEL ??
    "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL";
  return {
    workflowMode: parseWorkflowMode(env.IMPLEMENTER_WORKFLOW),
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
    implementation: {
      repository:
        env.GITHUB_REPOSITORY ??
        "Soverius-AI/software-development-workflow-local-llms",
      repositoryPath: path.resolve(
        baseDirectory,
        env.IMPLEMENTER_REPOSITORY_PATH ?? ".",
      ),
      baseBranch: env.IMPLEMENTER_BASE_BRANCH ?? "main",
      worktreeRoot: path.resolve(
        baseDirectory,
        env.IMPLEMENTER_WORKTREE_ROOT ?? ".data/worktrees",
      ),
      checkConfigPath: env.IMPLEMENTER_CHECK_CONFIG ?? ".implementer.json",
      timeoutMs: Math.max(
        1,
        Number(env.IMPLEMENTER_TIMEOUT_MS ?? 30 * 60_000),
      ),
      model: {
        baseUrl: env.IMPLEMENTER_MODEL_BASE_URL ?? modelBaseUrl,
        apiKey: env.IMPLEMENTER_MODEL_API_KEY ?? modelApiKey,
        modelId: env.IMPLEMENTER_MODEL ?? readinessModelId,
      },
      gitAuthorName: env.IMPLEMENTER_GIT_AUTHOR_NAME ?? "Implementer Bot",
      gitAuthorEmail:
        env.IMPLEMENTER_GIT_AUTHOR_EMAIL ?? "implementer@users.noreply.github.com",
    },
    readinessModel: {
      baseUrl: modelBaseUrl,
      apiKey: modelApiKey,
      modelId: readinessModelId,
      timeoutMs: Math.max(1, Number(env.READINESS_TIMEOUT_MS ?? 120_000)),
    },
  };
}

function parseWorkflowMode(value: string | undefined): AppConfig["workflowMode"] {
  if (!value || value === "production") return "production";
  if (value === "demo") return "demo";
  throw new Error("IMPLEMENTER_WORKFLOW must be either production or demo.");
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
    gitBaseUrl: (env.GITHUB_GIT_BASE_URL ?? "https://github.com").replace(
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
