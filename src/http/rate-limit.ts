import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { AppError } from "./errors.ts";

/**
 * Fixed-window, per-client-IP limiter held in memory. Enough for a single instance; a multi-instance
 * deployment would move the counters to Redis. The client IP comes from the socket, not from
 * X-Forwarded-For, which any caller can forge.
 */
export function rateLimit(limitPerMinute: number, scope: string): MiddlewareHandler {
  const WINDOW_MS = 60_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > WINDOW_MS) {
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
      lastSweep = now;
    }
    const ip = clientIp(c);
    const key = `${scope}:${ip}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      hits.set(key, entry);
    }
    entry.count++;
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1000);
    c.header("RateLimit-Limit", String(limitPerMinute));
    c.header("RateLimit-Remaining", String(Math.max(0, limitPerMinute - entry.count)));
    c.header("RateLimit-Reset", String(resetSeconds));
    if (entry.count > limitPerMinute) {
      throw new AppError("RATE_LIMITED", "Too many requests. Slow down and retry shortly.", { retryAfterSeconds: resetSeconds });
    }
    await next();
  };
}

function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // e.g. app.request() in tests, where there is no socket
  }
}
