import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedGitHubEvent } from "./types";

type GitHubPayload = Record<string, any>;

export function verifyGitHubSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string | null,
): boolean {
  if (!secret) return true;
  if (!signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function normalizeGitHubEvent(params: {
  deliveryId: string;
  eventName: string;
  payload: GitHubPayload;
}): NormalizedGitHubEvent {
  const { deliveryId, eventName, payload } = params;
  const repository = String(payload.repository?.full_name ?? "unknown/unknown");
  const issueNumber = numberOrNull(
    payload.issue?.number ?? payload.pull_request?.number ?? payload.number,
  );
  const ref = String(payload.ref ?? "unknown-ref");
  const correlationKey =
    issueNumber === null ? `${repository}@${ref}` : `${repository}#${issueNumber}`;
  const commentBody =
    typeof payload.comment?.body === "string" ? payload.comment.body : null;

  return {
    deliveryId,
    eventName,
    action: typeof payload.action === "string" ? payload.action : null,
    repository,
    correlationKey,
    issueNumber,
    senderLogin:
      typeof payload.sender?.login === "string" ? payload.sender.login : null,
    isHumanComment: eventName === "issue_comment" && payload.action === "created",
    commentBody,
    requiresHuman:
      payload.issue?.labels?.some(
        (label: unknown) =>
          typeof label === "object" &&
          label !== null &&
          (label as { name?: unknown }).name === "needs-human",
      ) === true,
    payload,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
