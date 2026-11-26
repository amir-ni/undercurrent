import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createGitHubClient } from "./github/client.ts";
import { InsightService } from "./insights/insight-service.ts";
import { createLogger } from "./logger.ts";
import { createAnthropicLlm } from "./narrative/anthropic-llm.ts";
import { createDemoLlm } from "./narrative/demo-llm.ts";
import { Narrator } from "./narrative/narrator.ts";
import { ActivityStore } from "./store/activity-store.ts";
import { openDatabase } from "./store/db.ts";
import { SyncService } from "./sync/sync-service.ts";

/** Composition root: the only place that knows about concrete implementations and process lifecycle. */

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const logger = createLogger(config.logLevel, { service: "undercurrent" });
const db = openDatabase(config.databasePath);
const store = new ActivityStore(db);
const github = createGitHubClient(config.githubToken, logger.child({ component: "github" }));
const sync = new SyncService(github, store, logger.child({ component: "sync" }), {
  ttlMs: config.syncTtlMs,
  maxItems: config.maxPullRequestsPerSync,
});
const insights = new InsightService(sync, store, config.repoAllowlist);
const llm =
  config.llm.provider === "anthropic" && config.anthropicApiKey
    ? createAnthropicLlm(config.anthropicApiKey, config.llm.model, config.llm.effort)
    : config.llm.provider === "demo"
      ? createDemoLlm()
      : null;
const narrator = new Narrator(llm, store, logger.child({ component: "narrator" }));

const staticRoot = "./web/dist";
const app = createApp({
  config,
  insights,
  narrator,
  store,
  logger,
  ...(existsSync(staticRoot) ? { staticRoot } : {}),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info("listening", {
    url: `http://${info.address === "0.0.0.0" ? "localhost" : info.address}:${info.port}`,
    ui: existsSync(staticRoot) ? "enabled" : "not built (run npm run build)",
    narratives: !llm ? "disabled (ANTHROPIC_API_KEY not set)" : llm.provider === "demo" ? "DEMO rule engine, not an LLM (LLM_PROVIDER=demo)" : `enabled (${llm.model})`,
  });
});

function shutdown(signal: string) {
  logger.info("shutting down", { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Idle keep-alive sockets (e.g. an open browser tab) would otherwise hold close() open.
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
