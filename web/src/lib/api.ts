import type { InsightReport } from "../../../src/insights/report.ts";
import type { Narrative } from "../../../src/narrative/types.ts";

export type { InsightReport, Narrative };

export type Coverage = Record<"pull_requests" | "issues" | "commits", { complete: boolean; coveredSince: string; syncedAt: string; truncated: boolean }>;
export type Envelope<T> = { data: T; meta: { coverage: Coverage } };

/** Error shape the UI renders: the API's stable code plus the request id to quote in a bug report. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(message: string, code: string, status: number, requestId: string | null, retryAfter: number | null) {
    super(message);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

export type Query = { owner: string; name: string; days: number };

async function get<T>(path: string, signal: AbortSignal): Promise<Envelope<T>> {
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError("Could not reach the server. Check that it is running.", "NETWORK", 0, null, null);
  }
  const requestId = res.headers.get("x-request-id");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; detail?: string } | null;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(body?.detail ?? `Request failed (HTTP ${res.status}).`, body?.code ?? "HTTP_ERROR", res.status, requestId, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return (await res.json()) as Envelope<T>;
}

const base = (q: Query) => `/v1/repos/${encodeURIComponent(q.owner)}/${encodeURIComponent(q.name)}`;

export const fetchInsights = (q: Query, signal: AbortSignal) => get<InsightReport>(`${base(q)}/insights?days=${q.days}`, signal);
export const fetchNarrative = (q: Query, signal: AbortSignal) => get<Narrative>(`${base(q)}/narrative?days=${q.days}`, signal);

/** Accepts "owner/name", "github.com/owner/name" or a full GitHub URL. */
export function parseRepoInput(raw: string): { owner: string; name: string } | null {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:\/.*)?$/.exec(cleaned);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1]!, name: match[2]! };
}

/** Only ever render links that point at github.com (defense in depth against odd upstream data). */
export function safeGitHubUrl(url: string): string | undefined {
  return /^https:\/\/github\.com\//.test(url) ? url : undefined;
}
