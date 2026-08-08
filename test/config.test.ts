import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config";

test("readiness model deployment settings come from the environment", () => {
  const config = loadConfig(
    {
      MODEL_BASE_URL: "http://localhost:9999/v1",
      MODEL_API_KEY: "test-key",
      READINESS_MODEL: "test/model",
      READINESS_TIMEOUT_MS: "45000",
    },
    "/tmp/project",
  );

  assert.deepEqual(config.readinessModel, {
    baseUrl: "http://localhost:9999/v1",
    apiKey: "test-key",
    modelId: "test/model",
    timeoutMs: 45_000,
  });
  assert.deepEqual(config.implementation.model, {
    baseUrl: "http://localhost:9999/v1",
    apiKey: "test-key",
    modelId: "test/model",
  });
});

test("the implementation model and worktree settings can be overridden", () => {
  const config = loadConfig(
    {
      GITHUB_REPOSITORY: "example/app",
      IMPLEMENTER_MODEL_BASE_URL: "http://localhost:8888/v1",
      IMPLEMENTER_MODEL_API_KEY: "implementation-key",
      IMPLEMENTER_MODEL: "implementation/model",
      IMPLEMENTER_REPOSITORY_PATH: "source",
      IMPLEMENTER_WORKTREE_ROOT: "worktrees",
      IMPLEMENTER_BASE_BRANCH: "develop",
    },
    "/tmp/project",
  );

  assert.equal(config.implementation.repository, "example/app");
  assert.equal(config.implementation.repositoryPath, "/tmp/project/source");
  assert.equal(config.implementation.worktreeRoot, "/tmp/project/worktrees");
  assert.equal(config.implementation.baseBranch, "develop");
  assert.deepEqual(config.implementation.model, {
    baseUrl: "http://localhost:8888/v1",
    apiKey: "implementation-key",
    modelId: "implementation/model",
  });
});

test("GitHub App credentials are resolved from the environment", () => {
  const config = loadConfig(
    {
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY_PATH: ".secrets/app.pem",
      GITHUB_API_BASE_URL: "https://github.example/api/v3/",
      GITHUB_API_TIMEOUT_MS: "9000",
    },
    "/tmp/project",
  );
  assert.deepEqual(config.githubApp, {
    appId: "123",
    installationId: "456",
    privateKeyPath: "/tmp/project/.secrets/app.pem",
    apiBaseUrl: "https://github.example/api/v3",
    gitBaseUrl: "https://github.com",
    timeoutMs: 9_000,
  });
});

test("partial GitHub App credentials fail fast", () => {
  assert.throws(
    () => loadConfig({ GITHUB_APP_ID: "123" }, "/tmp/project"),
    /must be configured together/,
  );
});
