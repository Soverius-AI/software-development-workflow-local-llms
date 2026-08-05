import { createApp } from "./app";
import { loadConfig } from "./config";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = loadConfig();
const app = await createApp(config);

app.server.listen(config.port, "127.0.0.1", () => {
  console.log(`GitHub loop receiver listening on http://127.0.0.1:${config.port}`);
});

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
