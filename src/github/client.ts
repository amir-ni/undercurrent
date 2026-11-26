import { AppError } from "../http/errors.ts";
import type { Logger } from "../logger.ts";
import { metrics } from "../observability/metrics.ts";

/** The only upstream host this service talks to. Never derived from user input (no SSRF surface). */
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 4;

type GraphQLError = { type?: string; message: string; path?: unknown };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };

export type GraphQLClient = {
  query<T>(document: string, variables: Record<string, unknown>): Promise<T>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimal GitHub GraphQL client with the failure handling a production integration needs:
 * timeouts, bounded retries with jittered backoff for transient and secondary-rate-limit errors,
 * and typed mapping of auth / not-found / primary-rate-limit errors to AppErrors.
 */
export function createGitHubClient(token: string, logger: Logger, fetchImpl: typeof fetch = fetch): GraphQLClient {
  async function query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    const started = performance.now();
    try {
      const data = await attempt<T>(document, variables);
      metrics.githubRequests.inc({ outcome: "ok" });
      return data;
    } catch (error) {
      metrics.githubRequests.inc({ outcome: "error" });
      throw error;
    } finally {
      metrics.githubDuration.observe((performance.now() - started) / 1000);
    }
  }

  async function attempt<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
      let response: Response;
      try {
        response = await fetchImpl(GITHUB_GRAPHQL_URL, {
          method: "POST",
          headers: {
            authorization: `bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "undercurrent-insights",
            accept: "application/vnd.github+json",
          },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error;
        metrics.githubRequests.inc({ outcome: "retry" });
        logger.warn("github request failed", { attempt: attemptNo, error });
        await backoff(attemptNo);
        continue;
      }

      if (response.status === 401) {
        throw new AppError("UPSTREAM_AUTH", "GitHub rejected the configured token. Check GITHUB_TOKEN.");
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (response.status === 403 || response.status === 429) {
        if (remaining === "0") {
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          throw rateLimited(Number.isFinite(reset) ? reset * 1000 - Date.now() : 60_000);
        }
        // Secondary (abuse) rate limit: GitHub asks us to slow down; honour retry-after.
        lastError = new Error(`GitHub secondary rate limit (HTTP ${response.status})`);
        metrics.githubRequests.inc({ outcome: "retry" });
        logger.warn("github secondary rate limit", { attempt: attemptNo, retryAfter });
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoffMs(attemptNo));
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(`GitHub HTTP ${response.status}`);
        metrics.githubRequests.inc({ outcome: "retry" });
        logger.warn("github upstream error", { attempt: attemptNo, status: response.status });
        await backoff(attemptNo);
        continue;
      }

      if (!response.ok) {
        throw new AppError("UPSTREAM_UNAVAILABLE", `GitHub responded with HTTP ${response.status}.`);
      }

      let body: GraphQLResponse<T>;
      try {
        body = (await response.json()) as GraphQLResponse<T>;
      } catch (error) {
        throw new AppError("UPSTREAM_UNAVAILABLE", "GitHub returned a response that is not valid JSON.", { cause: error });
      }
      if (body.errors?.length) {
        const first = body.errors[0]!;
        if (first.type === "RATE_LIMITED") throw rateLimited(60_000);
        if (!body.data) {
          if (first.type === "NOT_FOUND") throw new AppError("REPO_NOT_FOUND", "Repository not found, or it is not public.");
          throw new AppError("UPSTREAM_UNAVAILABLE", `GitHub GraphQL error: ${first.message.slice(0, 200)}`);
        }
        // Partial data (e.g. one unresolvable nested node): keep it. A missing repository arrives as
        // data.repository === null and is reported as REPO_NOT_FOUND by the caller.
        const log = first.type === "NOT_FOUND" ? logger.debug : logger.warn; // a missing repo is a 404, not a fault
        log("github graphql partial error", { type: first.type, message: first.message.slice(0, 200) });
      }
      if (!body.data) throw new AppError("UPSTREAM_UNAVAILABLE", "GitHub returned an empty response.");
      return body.data;
    }
    throw new AppError("UPSTREAM_UNAVAILABLE", "GitHub is not responding. Try again shortly.", { cause: lastError });
  }

  return { query };
}

function backoffMs(attemptNo: number): number {
  return Math.min(8_000, 500 * 2 ** (attemptNo - 1)) * (0.75 + Math.random() * 0.5);
}

function backoff(attemptNo: number): Promise<void> {
  return attemptNo < MAX_ATTEMPTS ? sleep(backoffMs(attemptNo)) : Promise.resolve();
}

function rateLimited(msUntilReset: number): AppError {
  const retryAfterSeconds = Math.max(1, Math.ceil(msUntilReset / 1000));
  return new AppError("UPSTREAM_RATE_LIMITED", "GitHub API rate limit reached for the configured token.", { retryAfterSeconds });
}
