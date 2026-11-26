import { z } from "zod";
import type { RepoRef, Window } from "../domain.ts";
import { LEADERBOARD_KINDS, type LeaderboardKind } from "../insights/report.ts";
import { DAY, HOUR } from "../insights/stats.ts";
import { AppError } from "./errors.ts";

/** GitHub's own naming rules. Anything else is rejected before it can reach a query. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepo(owner: string, name: string): RepoRef {
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new AppError("BAD_REQUEST", "Repository must look like {owner}/{repo} using GitHub naming rules.");
  }
  return { owner, name };
}

const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/, "use YYYY-MM-DD or an ISO-8601 timestamp with a timezone")
  .transform((value, ctx) => {
    const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: "custom", message: "not a valid date" });
      return z.NEVER;
    }
    return ms;
  });

const WindowQuery = z.object({
  since: instant.optional(),
  until: instant.optional(),
  days: z.coerce.number().int().min(1).optional(),
});

export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Resolves the requested period. Defaults to the last 30 days ending at the current hour:
 * snapping to the hour keeps responses (and narrative cache keys) stable for repeat queries.
 * `until` in the future is clamped to now; the resolved window is echoed in every response.
 */
export function parseWindow(query: Record<string, string | undefined>, maxDays: number, now = Date.now()): Window {
  const parsed = WindowQuery.safeParse(query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError("BAD_REQUEST", `Invalid query parameter "${issue.path.join(".")}": ${issue.message}.`);
  }
  const { since, until, days } = parsed.data;
  if (since !== undefined && days !== undefined) {
    throw new AppError("BAD_REQUEST", 'Use either "since" or "days", not both.');
  }
  const currentHour = Math.floor(now / HOUR) * HOUR;
  const end = Math.min(until ?? currentHour, now);
  const start = since ?? end - (days ?? DEFAULT_WINDOW_DAYS) * DAY;
  if (start >= end) throw new AppError("BAD_REQUEST", '"since" must be earlier than "until" (and not in the future).');
  if (end - start > maxDays * DAY) throw new AppError("BAD_REQUEST", `The period may span at most ${maxDays} days.`);
  return { since: start, until: end };
}

export function parseLeaderboardKind(kind: string): LeaderboardKind {
  if (!(LEADERBOARD_KINDS as readonly string[]).includes(kind)) {
    throw new AppError("NOT_FOUND", `Unknown leaderboard "${kind.slice(0, 40)}". Use one of: ${LEADERBOARD_KINDS.join(", ")}.`);
  }
  return kind as LeaderboardKind;
}

export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new AppError("BAD_REQUEST", `"limit" must be an integer between 1 and ${max}.`);
  return n;
}
