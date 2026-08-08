import { createSign } from "node:crypto";
import fs from "node:fs";
import type { AppConfig } from "./config";

export interface PublishedGitHubComment {
  id: number;
  url: string;
}

export interface GitHubCommentPublisher {
  findByMarker(
    repository: string,
    issueNumber: number,
    marker: string,
  ): Promise<PublishedGitHubComment | null>;
  publish(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<PublishedGitHubComment>;
}

type GitHubAppConfig = NonNullable<AppConfig["githubApp"]>;

export class GitHubAppCommentPublisher implements GitHubCommentPublisher {
  private readonly privateKey: string;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.privateKey = fs.readFileSync(config.privateKeyPath, "utf8");
  }

  async findByMarker(
    repository: string,
    issueNumber: number,
    marker: string,
  ): Promise<PublishedGitHubComment | null> {
    const { owner, name } = splitRepository(repository);
    for (let page = 1; page <= 10; page += 1) {
      const comments = await this.request<Array<{
        id: number;
        html_url: string;
        body: string | null;
      }>>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}/comments?per_page=100&page=${page}&sort=created&direction=desc`,
      );
      const match = comments.find((comment) => comment.body?.includes(marker));
      if (match) return { id: match.id, url: match.html_url };
      if (comments.length < 100) return null;
    }
    return null;
  }

  async publish(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<PublishedGitHubComment> {
    const { owner, name } = splitRepository(repository);
    const comment = await this.request<{ id: number; html_url: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${issueNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return { id: comment.id, url: comment.html_url };
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const token = await this.installationToken();
    const response = await this.fetchImplementation(
      `${this.config.apiBaseUrl}${pathname}`,
      {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "mastra-software-development-graph",
          "x-github-api-version": "2022-11-28",
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );
    if (!response.ok) {
      if (response.status === 401) this.cachedToken = null;
      throw new Error(
        `GitHub API ${init.method ?? "GET"} ${pathname} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  private async installationToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    const response = await this.fetchImplementation(
      `${this.config.apiBaseUrl}/app/installations/${encodeURIComponent(this.config.installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.appJwt()}`,
          "content-type": "application/json",
          "user-agent": "mastra-software-development-graph",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub App token request failed with ${response.status}: ${await response.text()}`,
      );
    }
    const token = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    this.cachedToken = {
      value: token.token,
      expiresAt: Date.parse(token.expires_at),
    };
    return token.token;
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1_000);
    const header = encodeJson({ alg: "RS256", typ: "JWT" });
    const payload = encodeJson({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.config.appId,
    });
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(this.privateKey).toString("base64url")}`;
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid GitHub repository name: ${repository}`);
  }
  return { owner, name };
}
