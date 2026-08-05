import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { normalizeGitHubEvent, verifyGitHubSignature } from "./github";
import type { AppConfig } from "./config";
import { RunCoordinator } from "./coordinator";
import { EventStore } from "./store";
import { createImplementationMastra } from "./workflow";

export async function createApp(config: AppConfig) {
  const eventStore = new EventStore(config.databasePath);
  const { mastra, workflow, storage } = createImplementationMastra({
    databaseUrl: config.mastraDatabaseUrl,
    eventStore,
  });
  await storage.init();
  const coordinator = new RunCoordinator(
    eventStore,
    workflow,
    config.maxActiveImplementations,
    config.simulatedImplementationMs,
  );

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, config, eventStore, coordinator);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  coordinator.wake();

  return {
    server,
    eventStore,
    coordinator,
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await coordinator.close();
      await mastra.observability.flush();
      await mastra.shutdown();
      eventStore.close();
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  store: EventStore,
  coordinator: RunCoordinator,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, activeImplementations: coordinator.activeCount });
    return;
  }

  if (request.method === "GET" && request.url === "/runs") {
    sendJson(response, 200, { runs: store.listRuns() });
    return;
  }

  if (request.method !== "POST" || request.url !== "/webhooks/github") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const body = await readBody(request, 2_000_000);
  const signature = header(request, "x-hub-signature-256");
  if (!verifyGitHubSignature(body, signature, config.githubWebhookSecret)) {
    sendJson(response, 401, { error: "Invalid GitHub signature" });
    return;
  }

  const deliveryId = header(request, "x-github-delivery");
  const eventName = header(request, "x-github-event");
  if (!deliveryId || !eventName) {
    sendJson(response, 400, { error: "Missing GitHub delivery or event header" });
    return;
  }

  let payload: Record<string, any>;
  try {
    payload = JSON.parse(body.toString("utf8")) as Record<string, any>;
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return;
  }

  const event = normalizeGitHubEvent({ deliveryId, eventName, payload });
  const result = store.ingest(event, config.githubBotLogin);
  if (["created", "attached", "resume_requested"].includes(result.outcome)) {
    coordinator.wake();
  }
  sendJson(response, 202, result);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
