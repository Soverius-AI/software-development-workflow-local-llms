import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GitHubAppCommentPublisher } from "../src/github-comments";

test("the GitHub App client exchanges a signed JWT and posts an issue comment", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPath = path.join("/tmp", `github-app-${randomUUID()}.pem`);
  fs.writeFileSync(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = (async (input: string | URL | Request, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/app/installations/456/access_tokens")) {
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (init.method === "POST") {
      return Response.json({
        id: 77,
        html_url: "https://github.test/example/app/issues/12#issuecomment-77",
      });
    }
    return Response.json([]);
  }) as typeof fetch;

  try {
    const publisher = new GitHubAppCommentPublisher(
      {
        appId: "123",
        installationId: "456",
        privateKeyPath,
        apiBaseUrl: "https://api.github.test",
        timeoutMs: 1_000,
      },
      fetchMock,
    );
    assert.equal(
      await publisher.findByMarker("example/app", 12, "<!-- marker -->"),
      null,
    );
    const comment = await publisher.publish("example/app", 12, "Question");
    assert.equal(comment.id, 77);
    assert.equal(calls.length, 3);
    const appAuthorization = new Headers(calls[0]?.init.headers).get(
      "authorization",
    );
    assert.equal(appAuthorization?.startsWith("Bearer "), true);
    assert.equal(appAuthorization?.slice("Bearer ".length).split(".").length, 3);
    assert.equal(
      new Headers(calls[1]?.init.headers).get("authorization"),
      "Bearer installation-token",
    );
    assert.equal(
      new Headers(calls[2]?.init.headers).get("authorization"),
      "Bearer installation-token",
    );
  } finally {
    fs.rmSync(privateKeyPath, { force: true });
  }
});
