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
    timeoutMs: 9_000,
  });
});

test("partial GitHub App credentials fail fast", () => {
  assert.throws(
    () => loadConfig({ GITHUB_APP_ID: "123" }, "/tmp/project"),
    /must be configured together/,
  );
});
