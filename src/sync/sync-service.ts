import { repoKey, type RepoRef } from "../domain.ts";
import type { GraphQLClient } from "../github/client.ts";
import { fetchCommits, fetchIssues, fetchPullRequests } from "../github/ingest.ts";
import type { Logger } from "../logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { ActivityStore, Resource, SyncBatch, SyncState } from "../store/activity-store.ts";

/** Re-fetch a little before the last sync to absorb clock skew and in-flight writes upstream. */
const OVERLAP_MS = 5 * 60_000;

export type Coverage = Record<Resource, SyncState & { complete: boolean }>;
export type SyncSummary = { fetched: Record<Resource, number>; coverage: Coverage };

type Options = { ttlMs: number; maxItems: number };

/**
 * Decides when to hit GitHub. A request is served from SQLite when stored data covers the
 * requested period and is fresher than the TTL; otherwise only the missing slice is fetched:
 *  - stale but covered → incremental: items updated since the last sync (minus overlap)
 *  - not covered       → backfill: everything updated since the requested start
 * Concurrent requests for the same repository share one in-flight sync (single-flight).
 */
export class SyncService {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly client: GraphQLClient;
  private readonly store: ActivityStore;
  private readonly logger: Logger;
  private readonly options: Options;

  constructor(client: GraphQLClient, store: ActivityStore, logger: Logger, options: Options) {
    this.client = client;
    this.store = store;
    this.logger = logger;
    this.options = options;
  }

  async ensureFresh(repo: RepoRef, since: number): Promise<SyncSummary> {
    const key = repoKey(repo);
    // Wait out any running sync for this repo, then re-evaluate: it may already cover us.
    while (this.inflight.has(key)) await this.inflight.get(key)!.catch(() => undefined);
    const run = this.syncAll(repo, since).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async syncAll(repo: RepoRef, since: number): Promise<SyncSummary> {
    const [pullRequests, issues, commits] = await Promise.all([
      this.syncResource(repo, since, "pull_requests"),
      this.syncResource(repo, since, "issues"),
      this.syncResource(repo, since, "commits"),
    ]);
    return {
      fetched: { pull_requests: pullRequests.fetched, issues: issues.fetched, commits: commits.fetched },
      coverage: { pull_requests: pullRequests.state, issues: issues.state, commits: commits.state },
    };
  }

  private async syncResource(repo: RepoRef, since: number, resource: Resource) {
    const now = Date.now();
    const previous = this.store.getSyncState(repo, resource);
    const covered = previous !== null && previous.coveredSince <= since;
    const fresh = previous !== null && now - previous.syncedAt < this.options.ttlMs;

    // A truncated sync already went as far back as the cap allows; retrying before the TTL would only repeat it.
    if (previous && fresh && (covered || previous.truncated)) {
      metrics.syncRuns.inc({ resource, mode: "fresh" });
      return { fetched: 0, state: { ...previous, complete: previous.coveredSince <= since } };
    }

    const stopBefore = covered ? previous.syncedAt - OVERLAP_MS : since;
    metrics.syncRuns.inc({ resource, mode: covered ? "incremental" : "backfill" });
    const log = this.logger.child({ repo: repoKey(repo), resource });
    log.info("sync started", { mode: covered ? "incremental" : "backfill", stopBefore: new Date(stopBefore).toISOString() });

    const result = await this.fetch(repo, resource, stopBefore, log);
    const state: SyncState = {
      // When the cap truncated the fetch, coverage only reaches back as far as the oldest item we got.
      coveredSince: result.truncated ? result.oldest : covered ? previous.coveredSince : since,
      syncedAt: now,
      truncated: result.truncated,
    };
    this.store.saveSync(repo, result.defaultBranch, result.batch, state);
    const fetched = result.batch.items.length;
    metrics.syncItems.inc({ resource }, fetched);
    metrics.syncDuration.observe((Date.now() - now) / 1000, { resource });
    log.info("sync finished", { fetched, truncated: result.truncated, ms: Date.now() - now });
    return { fetched, state: { ...state, complete: state.coveredSince <= since } };
  }

  private async fetch(repo: RepoRef, resource: Resource, stopBefore: number, log: Logger): Promise<Fetched> {
    const cap = this.options.maxItems;
    switch (resource) {
      case "pull_requests": {
        const r = await fetchPullRequests(this.client, repo, stopBefore, cap, log);
        return { batch: { resource, items: r.items }, truncated: r.truncated, defaultBranch: r.defaultBranch, oldest: oldestOf(r.items.map((i) => i.updatedAt), stopBefore) };
      }
      case "issues": {
        const r = await fetchIssues(this.client, repo, stopBefore, cap, log);
        return { batch: { resource, items: r.items }, truncated: r.truncated, oldest: oldestOf(r.items.map((i) => i.updatedAt), stopBefore) };
      }
      case "commits": {
        const r = await fetchCommits(this.client, repo, stopBefore, cap * 2, log);
        return { batch: { resource, items: r.items }, truncated: r.truncated, oldest: oldestOf(r.items.map((i) => i.committedAt), stopBefore) };
      }
    }
  }
}

type Fetched = { batch: SyncBatch; truncated: boolean; defaultBranch?: string | null; oldest: number };

function oldestOf(timestamps: number[], fallback: number): number {
  let oldest = Infinity;
  for (const ts of timestamps) if (ts < oldest) oldest = ts;
  return oldest === Infinity ? fallback : oldest;
}
