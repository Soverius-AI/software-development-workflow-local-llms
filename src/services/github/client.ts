import { createSign } from "node:crypto";
import fs from "node:fs";
import type { AppConfig } from "../../config";
import { runCheckedProcess } from "../../shared/process";

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

export interface PublishedPullRequest {
  number: number;
  url: string;
}

export interface GitHubPullRequestPublisher {
  fetchBase(
    repository: string,
    repositoryPath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<void>;
  pushBranch(
    repository: string,
    worktreePath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void>;
  publishPullRequest(
    repository: string,
    options: { head: string; base: string; title: string; body: string },
  ): Promise<PublishedPullRequest>;
}

type GitHubAppConfig = NonNullable<AppConfig["githubApp"]>;

export class GitHubAppCommentPublisher
  implements GitHubCommentPublisher, GitHubPullRequestPublisher
{
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

  async fetchBase(
    repository: string,
    repositoryPath: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.authenticatedGit(
      repository,
      repositoryPath,
      [
        "fetch",
        "--no-tags",
        this.repositoryUrl(repository),
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ],
      signal,
    );
  }

  async pushBranch(
    repository: string,
    worktreePath: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.authenticatedGit(
      repository,
      worktreePath,
      [
        "push",
        "--set-upstream",
        this.repositoryUrl(repository),
        `HEAD:refs/heads/${branch}`,
      ],
      signal,
    );
  }

  async publishPullRequest(
    repository: string,
    options: { head: string; base: string; title: string; body: string },
  ): Promise<PublishedPullRequest> {
    const { owner, name } = splitRepository(repository);
    const existing = await this.request<
      Array<{ number: number; html_url: string }>
    >(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${options.head}`)}&base=${encodeURIComponent(options.base)}`,
    );
    if (existing[0]) {
      return { number: existing[0].number, url: existing[0].html_url };
    }
    const pullRequest = await this.request<{
      number: number;
      html_url: string;
    }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: options.title,
          body: options.body,
          head: options.head,
          base: options.base,
        }),
      },
    );
    return { number: pullRequest.number, url: pullRequest.html_url };
  }

  private repositoryUrl(repository: string): string {
    const { owner, name } = splitRepository(repository);
    return `${this.config.gitBaseUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
  }

  private async authenticatedGit(
    repository: string,
    cwd: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const token = await this.installationToken();
    await runCheckedProcess("git", args, {
      cwd,
      timeoutMs: this.config.timeoutMs,
      ...(signal ? { signal } : {}),
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${this.repositoryUrl(repository)}.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
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
