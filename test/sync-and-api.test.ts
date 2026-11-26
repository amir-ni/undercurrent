import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import type { GraphQLClient } from "../src/github/client.ts";
import type { GqlPullRequest } from "../src/github/queries.ts";
import { InsightService } from "../src/insights/insight-service.ts";
import { silentLogger } from "../src/logger.ts";
import { Narrator } from "../src/narrative/narrator.ts";
import { ActivityStore } from "../src/store/activity-store.ts";
import { openDatabase } from "../src/store/db.ts";
import { SyncService } from "../src/sync/sync-service.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function gqlPr(number: number, updatedAt: number): GqlPullRequest {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "MERGED",
    isDraft: false,
    createdAt: iso(updatedAt - 2 * HOUR),
    updatedAt: iso(updatedAt),
    mergedAt: iso(updatedAt),
    closedAt: iso(updatedAt),
    additions: 5,
    deletions: 1,
    author: { login: "alice", __typename: "User" },
    readyEvents: { nodes: [] },
    reviews: { totalCount: 1, nodes: [{ id: `R${number}`, state: "APPROVED", submittedAt: iso(updatedAt - HOUR), author: { login: "bob", __typename: "User" }, comments: { totalCount: 2 } }] },
  };
}

/** Fake GitHub: serves PRs newest-first in pages of 2 and records every call. */
function fakeGitHub(prs: GqlPullRequest[]) {
  const calls: string[] = [];
  const client: GraphQLClient = {
    async query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
      const rateLimit = { cost: 1, remaining: 4999 };
      if (document.includes("query PullRequests")) {
        calls.push("pulls");
        const start = variables.cursor ? Number(variables.cursor) : 0;
        const nodes = prs.slice(start, start + 2);
        const hasNextPage = start + 2 < prs.length;
        return { rateLimit, repository: { defaultBranchRef: { name: "main" }, pullRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + 2) : null }, nodes } } } as T;
      }
      if (document.includes("query Issues")) {
        calls.push("issues");
        return { rateLimit, repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } as T;
      }
      calls.push("commits");
      return { rateLimit, repository: { defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } } as T;
    },
  };
  return { client, calls };
}

function setup(prs: GqlPullRequest[], ttlMs = 60_000) {
  const github = fakeGitHub(prs);
  const store = new ActivityStore(openDatabase(":memory:"));
  const sync = new SyncService(github.client, store, silentLogger, { ttlMs, maxItems: 1000 });
  return { github, store, sync };
}

const now = Date.now();
const repo = { owner: "acme", name: "app" };

describe("SyncService", () => {
  it("backfills once, serves fresh data from the store, and stops paginating at the boundary", async () => {
    const prs = [gqlPr(4, now - HOUR), gqlPr(3, now - 2 * HOUR), gqlPr(2, now - 50 * HOUR), gqlPr(1, now - 100 * HOUR)];
    const { github, sync } = setup(prs);

    const first = await sync.ensureFresh(repo, now - 10 * HOUR);
    assert.equal(first.fetched.pull_requests, 2); // stopped at PR 2 (older than the window)
    assert.equal(first.coverage.pull_requests.complete, true);
    assert.equal(github.calls.filter((c) => c === "pulls").length, 2); // second page revealed the boundary

    const second = await sync.ensureFresh(repo, now - 10 * HOUR);
    assert.equal(second.fetched.pull_requests, 0);
    assert.equal(github.calls.filter((c) => c === "pulls").length, 2); // no new upstream calls

    const wider = await sync.ensureFresh(repo, now - 200 * HOUR);
    assert.equal(wider.fetched.pull_requests, 4); // backfill for the wider window
  });

  it("shares one upstream sync between concurrent requests", async () => {
    const { github, sync } = setup([gqlPr(1, now - HOUR)]);
    await Promise.all([sync.ensureFresh(repo, now - 10 * HOUR), sync.ensureFresh(repo, now - 10 * HOUR), sync.ensureFresh(repo, now - 10 * HOUR)]);
    assert.equal(github.calls.filter((c) => c === "pulls").length, 1);
  });

  it("marks coverage truncated when the safety cap is hit", async () => {
    const github = fakeGitHub([gqlPr(3, now - HOUR), gqlPr(2, now - 2 * HOUR), gqlPr(1, now - 3 * HOUR)]);
    const store = new ActivityStore(openDatabase(":memory:"));
    const sync = new SyncService(github.client, store, silentLogger, { ttlMs: 60_000, maxItems: 2 });
    const result = await sync.ensureFresh(repo, now - 10 * HOUR);
    assert.equal(result.coverage.pull_requests.truncated, true);
    assert.equal(result.coverage.pull_requests.complete, false);
  });
});

describe("HTTP API", () => {
  function app(allowlist: string[] = []) {
    const { store, sync } = setup([gqlPr(2, now - 2 * HOUR), gqlPr(1, now - 3 * HOUR)]);
    return createApp({
      config: { maxWindowDays: 180, rateLimitPerMinute: 100, narrativeRateLimitPerMinute: 2, corsOrigins: [] },
      insights: new InsightService(sync, store, allowlist),
      narrator: new Narrator(null, store, silentLogger),
      store,
      logger: silentLogger,
    });
  }

  it("returns a report whose numbers match the source data, with ETag revalidation", async () => {
    const api = app();
    const res = await api.request("/v1/repos/acme/app/insights?days=7");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { totals: { prsMerged: number; reviews: number; reviewComments: number } } };
    assert.deepEqual([body.data.totals.prsMerged, body.data.totals.reviews, body.data.totals.reviewComments], [2, 2, 4]);

    const tag = res.headers.get("etag")!;
    const revalidated = await api.request("/v1/repos/acme/app/insights?days=7", { headers: { "if-none-match": tag } });
    assert.equal(revalidated.status, 304);
  });

  it("serves a single leaderboard", async () => {
    const res = await app().request("/v1/repos/acme/app/leaderboards/reviewers?days=7&limit=1");
    const body = (await res.json()) as { data: { rows: Array<{ login: string; reviews: number }> } };
    assert.deepEqual(body.data.rows, [{ login: "bob", reviews: 2, prsReviewed: 2, approvals: 2, changesRequested: 0, comments: 4 }]);
  });

  it("answers bad input with problem+json and stable codes", async () => {
    const api = app(["acme/app"]);
    const cases: Array<[string, number, string]> = [
      ["/v1/repos/acme/app/insights?days=abc", 400, "BAD_REQUEST"],
      ["/v1/repos/ac..me/app/insights", 400, "BAD_REQUEST"],
      ["/v1/repos/other/repo/insights", 403, "REPO_NOT_ALLOWED"],
      ["/v1/repos/acme/app/leaderboards/everyone", 404, "NOT_FOUND"],
      ["/v1/repos/acme/app/narrative", 503, "LLM_NOT_CONFIGURED"],
      ["/v1/nope", 404, "NOT_FOUND"],
    ];
    for (const [path, status, code] of cases) {
      const res = await api.request(path);
      assert.equal(res.status, status, path);
      assert.equal(res.headers.get("content-type"), "application/problem+json", path);
      const body = (await res.json()) as { code: string; requestId: string };
      assert.equal(body.code, code, path);
      assert.ok(body.requestId, path);
    }
  });

  it("rate limits the expensive narrative route separately, after the not-configured check", async () => {
    const disabled = app();
    for (let i = 0; i < 4; i++) assert.equal((await disabled.request("/v1/repos/acme/app/narrative")).status, 503);

    const { store, sync } = setup([gqlPr(1, now - HOUR)]);
    const enabled = createApp({
      config: { maxWindowDays: 180, rateLimitPerMinute: 100, narrativeRateLimitPerMinute: 2, corsOrigins: [] },
      insights: new InsightService(sync, store, []),
      narrator: { enabled: true, provider: "demo", narrate: async () => ({ meta: { cached: true } }) as never },
      store,
      logger: silentLogger,
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await enabled.request("/v1/repos/acme/app/narrative")).status);
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe("observability", () => {
  it("exposes Prometheus metrics with low-cardinality route labels", async () => {
    const { store, sync } = setup([gqlPr(1, now - HOUR)]);
    const api = createApp({
      config: { maxWindowDays: 180, rateLimitPerMinute: 100, narrativeRateLimitPerMinute: 2, corsOrigins: [] },
      insights: new InsightService(sync, store, []),
      narrator: new Narrator(null, store, silentLogger),
      store,
      logger: silentLogger,
    });
    const insights = await api.request("/v1/repos/acme/app/insights?days=7");
    assert.match(insights.headers.get("server-timing") ?? "", /sync;.*dur=\d+, compute;.*dur=\d+/);
    await api.request("/v1/repos/acme/some-random-path/x/y/z");

    const res = await api.request("/metrics");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /http_requests_total\{method="GET",route="\/v1\/repos\/:owner\/:repo\/insights",status="200"\} \d+/);
    assert.match(text, /route="\/v1\/unknown"/);
    assert.ok(!text.includes("acme"), "repository names must never become label values");
    assert.match(text, /sync_runs_total\{mode="backfill",resource="pull_requests"\}|sync_runs_total\{resource="pull_requests",mode="backfill"\}/);
  });
});
