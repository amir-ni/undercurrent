import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Config } from "./config.ts";
import { AppError } from "./http/errors.ts";
import { parseLeaderboardKind, parseLimit, parseRepo, parseWindow } from "./http/params.ts";
import { rateLimit } from "./http/rate-limit.ts";
import type { InsightService, ReportResult } from "./insights/insight-service.ts";
import type { Logger } from "./logger.ts";
import type { Narrator } from "./narrative/narrator.ts";
import { metrics, renderMetrics, routeTemplate } from "./observability/metrics.ts";
import type { ActivityStore } from "./store/activity-store.ts";

export type AppDeps = {
  config: Pick<Config, "maxWindowDays" | "rateLimitPerMinute" | "narrativeRateLimitPerMinute" | "corsOrigins">;
  insights: Pick<InsightService, "report">;
  narrator: Pick<Narrator, "narrate" | "enabled" | "provider">;
  store: Pick<ActivityStore, "ping">;
  logger: Logger;
  staticRoot?: string;
};

const LEADERBOARD_MAX_LIMIT = 100;
const EXPECTED_CODES = new Set(["LLM_NOT_CONFIGURED"]);

export function createApp(deps: AppDeps) {
  const { config, insights, narrator, store, logger } = deps;
  const app = new Hono<{ Variables: { requestId: string; errorCode?: string } }>();

  app.use(requestId());
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    const ms = performance.now() - started;
    const route = routeTemplate(c.req.path);
    metrics.httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
    metrics.httpDuration.observe(ms / 1000, { route });
    const fields = {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path, // path only: query strings are not logged
      status: c.res.status,
      ms: Math.round(ms),
    };
    // A server-side failure is a warning; "LLM not configured" is a known deployment state, not a fault.
    if (c.res.status >= 500 && !EXPECTED_CODES.has(c.get("errorCode") ?? "")) logger.warn("request", fields);
    else if (route !== "static") logger.info("request", fields);
    else logger.debug("request", fields);
  });
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com", "https://github.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  if (config.corsOrigins.length > 0) app.use("/v1/*", cors({ origin: config.corsOrigins, allowMethods: ["GET"] }));

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/metrics", (c) => c.text(renderMetrics(), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }));
  app.get("/readyz", (c) => {
    try {
      store.ping();
      return c.json({ status: "ready", narratives: narrator.provider ?? "disabled" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });

  const v1 = new Hono<{ Variables: { requestId: string } }>();
  v1.use(rateLimit(config.rateLimitPerMinute, "api"));
  v1.use(etag());

  v1.get("/", (c) =>
    c.json({
      endpoints: {
        insights: "GET /v1/repos/{owner}/{repo}/insights?since=&until=&days=",
        leaderboard: "GET /v1/repos/{owner}/{repo}/leaderboards/{contributors|reviewers|closers}?since=&until=&days=&limit=",
        narrative: "GET /v1/repos/{owner}/{repo}/narrative?since=&until=&days=",
      },
      narratives: narrator.provider === "demo" ? "demo rule engine (not an LLM)" : narrator.provider ?? "disabled (set ANTHROPIC_API_KEY)",
    }),
  );

  v1.get("/repos/:owner/:repo/insights", async (c) => {
    const repo = parseRepo(c.req.param("owner"), c.req.param("repo"));
    const window = parseWindow(c.req.query(), config.maxWindowDays);
    const result = await insights.report(repo, window);
    c.header("Cache-Control", "private, max-age=60");
    c.header("Server-Timing", serverTiming(result));
    return c.json({ data: result.report, meta: meta(result) });
  });

  v1.get("/repos/:owner/:repo/leaderboards/:kind", async (c) => {
    const repo = parseRepo(c.req.param("owner"), c.req.param("repo"));
    const kind = parseLeaderboardKind(c.req.param("kind"));
    const limit = parseLimit(c.req.query("limit"), 10, LEADERBOARD_MAX_LIMIT);
    const window = parseWindow(c.req.query(), config.maxWindowDays);
    const result = await insights.report(repo, window, limit);
    c.header("Cache-Control", "private, max-age=60");
    c.header("Server-Timing", serverTiming(result));
    return c.json({ data: { kind, window: result.report.window, rows: result.report.leaderboards[kind] }, meta: meta(result) });
  });

  const requireNarrator: MiddlewareHandler = async (_c, next) => {
    if (!narrator.enabled) throw new AppError("LLM_NOT_CONFIGURED", "Narratives need ANTHROPIC_API_KEY to be set on the server.");
    await next();
  };

  v1.get("/repos/:owner/:repo/narrative", requireNarrator, rateLimit(config.narrativeRateLimitPerMinute, "narrative"), async (c) => {
    const repo = parseRepo(c.req.param("owner"), c.req.param("repo"));
    const window = parseWindow(c.req.query(), config.maxWindowDays);
    const result = await insights.report(repo, window);
    const llmStarted = performance.now();
    const narrative = await narrator.narrate(repo, result.report);
    c.header("Cache-Control", "private, max-age=300");
    c.header("Server-Timing", `${serverTiming(result)}, llm;desc="${narrative.meta.cached ? "cache hit" : "generated"}";dur=${Math.round(performance.now() - llmStarted)}`);
    return c.json({ data: narrative, meta: meta(result) });
  });

  app.route("/v1", v1);
  app.all("/v1/*", () => {
    throw new AppError("NOT_FOUND", "No such endpoint. See GET /v1 for the list.");
  });

  if (deps.staticRoot) {
    const root = deps.staticRoot;
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable"); // content-hashed filenames
    });
    app.get("*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" })); // SPA fallback
  }

  app.onError((error, c) => {
    const id = c.get("requestId");
    if (error instanceof AppError) {
      c.set("errorCode", error.code);
      if (error.status >= 500 && !EXPECTED_CODES.has(error.code)) logger.warn("request failed", { requestId: id, code: error.code, message: error.message, cause: error.cause });
      if (error.retryAfterSeconds) c.header("Retry-After", String(error.retryAfterSeconds));
      return problem(c, error.status, error.code, error.message, id);
    }
    logger.error("unhandled error", { requestId: id, error, stack: error instanceof Error ? error.stack : undefined });
    return problem(c, 500, "INTERNAL", "Something went wrong on our side.", id);
  });
  app.notFound((c) => problem(c, 404, "NOT_FOUND", "Not found.", c.get("requestId")));

  return app;
}

/**
 * Response metadata. Deliberately free of per-request values (request id, timestamps of this call):
 * identical data must serialize to identical bytes so the ETag/304 path works. The request id travels
 * in the X-Request-Id header instead.
 */
function meta(result: ReportResult) {
  const coverage = Object.fromEntries(
    Object.entries(result.sync.coverage).map(([resource, s]) => [
      resource,
      { complete: s.complete, coveredSince: new Date(s.coveredSince).toISOString(), syncedAt: new Date(s.syncedAt).toISOString(), truncated: s.truncated },
    ]),
  );
  return { coverage };
}

/** Shows where request time went in browser devtools (Network → Timing). */
function serverTiming(result: ReportResult): string {
  return `sync;desc="GitHub sync";dur=${Math.round(result.timings.syncMs)}, compute;desc="metrics";dur=${Math.round(result.timings.computeMs)}`;
}

/** RFC 9457 problem details. */
function problem(c: Context, status: AppError["status"], code: string, detail: string, requestId: string) {
  return c.json({ type: "about:blank", title: STATUS_TITLES[status] ?? "Error", status, code, detail, requestId }, status, {
    "content-type": "application/problem+json",
  });
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};
