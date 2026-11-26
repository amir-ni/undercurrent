import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Window } from "../src/domain.ts";
import { buildReport, roleOf } from "../src/insights/report.ts";
import { activity, bot, commit, D, H, human, issue, pr, review, T0 } from "./fixtures.ts";

const window: Window = { since: T0, until: T0 + 14 * D };
const alice = human("alice");
const bob = human("bob");
const carol = human("carol");

describe("buildReport", () => {
  it("counts peer reviews and excludes bots and self-reviews", () => {
    const report = buildReport(
      activity({
        pullRequests: [
          pr(1, alice, { reviews: [review(bob, T0 + 2 * D), review(alice, T0 + 2 * D, "COMMENTED"), review(bot("ci-bot"), T0 + 2 * D)] }),
        ],
      }),
      window,
    );
    assert.equal(report.totals.reviews, 1);
    assert.equal(report.dataQuality.selfReviewsExcluded, 1);
    assert.equal(report.dataQuality.botReviewsExcluded, 1);
    assert.deepEqual(report.leaderboards.reviewers.map((r) => r.login), ["bob"]);
  });

  it("uses half-open windows: an event at `until` is outside, at `since` inside", () => {
    const report = buildReport(
      activity({
        pullRequests: [
          pr(1, alice, { createdAt: T0 - D, readyAt: T0 - D, mergedAt: window.since, state: "MERGED" }),
          pr(2, alice, { createdAt: T0 - D, readyAt: T0 - D, mergedAt: window.until, state: "MERGED" }),
        ],
      }),
      window,
    );
    assert.equal(report.totals.prsMerged, 1);
  });

  it("measures time to first review from ready-for-review, not from draft creation", () => {
    const created = T0 + D;
    const ready = created + 48 * H;
    const report = buildReport(
      activity({ pullRequests: [pr(1, alice, { createdAt: created, readyAt: ready, reviews: [review(bob, ready + 6 * H)] })] }),
      window,
    );
    assert.equal(report.flow.timeToFirstReview.sample, 1);
    assert.equal(report.flow.timeToFirstReview.p50Hours, 6);
  });

  it("keeps unreviewed open PRs out of the TTFR sample and reports them as awaiting", () => {
    const report = buildReport(activity({ pullRequests: [pr(1, alice, { readyAt: T0 + D, createdAt: T0 + D })] }), window);
    assert.equal(report.flow.timeToFirstReview.sample, 0);
    assert.equal(report.flow.timeToFirstReview.p50Hours, null);
    assert.equal(report.flow.timeToFirstReview.awaiting, 1);
    assert.equal(report.flow.timeToFirstReview.awaitingOldestHours, 13 * 24);
    assert.equal(report.notable.awaitingReview[0]?.number, 1);
  });

  it("flags merges with no peer review before the merge", () => {
    const mergedAt = T0 + 3 * D;
    const report = buildReport(
      activity({
        pullRequests: [
          pr(1, alice, { mergedAt, state: "MERGED", reviews: [review(bob, mergedAt - H)] }),
          pr(2, alice, { mergedAt, state: "MERGED", reviews: [review(bob, mergedAt + H)] }), // review after merge doesn't count
          pr(3, alice, { mergedAt, state: "MERGED" }),
        ],
      }),
      window,
    );
    assert.deepEqual(report.flow.unreviewedMerges, { merged: 3, unreviewed: 2, rate: 0.667 });
  });

  it("excludes bot-authored PRs from human metrics but credits reviewers who review them", () => {
    const report = buildReport(
      activity({ pullRequests: [pr(1, bot("dependabot"), { mergedAt: T0 + 2 * D, state: "MERGED", reviews: [review(bob, T0 + D)] })] }),
      window,
    );
    assert.equal(report.totals.prsMerged, 0);
    assert.equal(report.dataQuality.botPrsExcluded, 1);
    assert.equal(report.totals.reviews, 1);
    const bobLoad = report.reviewLoad.people.find((p) => p.login === "bob")!;
    assert.equal(bobLoad.reviewsGiven, 1);
    assert.equal(report.reviewLoad.people.find((p) => p.login === "dependabot"), undefined);
  });

  it("computes reciprocity and concentration so the numbers add up", () => {
    const prs = [
      ...Array.from({ length: 6 }, (_, i) => pr(10 + i, alice, { reviews: [review(bob, T0 + D + i * H)] })),
      pr(20, bob, { reviews: [review(alice, T0 + 2 * D)] }),
      pr(21, carol, { reviews: [review(bob, T0 + 2 * D), review(alice, T0 + 2 * D)] }),
    ];
    const report = buildReport(activity({ pullRequests: prs }), window);
    const byLogin = Object.fromEntries(report.reviewLoad.people.map((p) => [p.login, p]));

    assert.equal(byLogin.bob!.reviewsGiven, 7);
    assert.equal(byLogin.bob!.reviewsReceived, 1);
    assert.equal(byLogin.bob!.role, "carrying");
    assert.equal(byLogin.alice!.reviewsReceived, 6);
    assert.equal(byLogin.alice!.role, "receiving");

    const given = report.reviewLoad.people.reduce((s, p) => s + p.reviewsGiven, 0);
    const received = report.reviewLoad.people.reduce((s, p) => s + p.reviewsReceived, 0);
    const leaderboardTotal = report.leaderboards.reviewers.reduce((s, r) => s + r.reviews, 0);
    const weeklyTotal = report.weekly.reduce((s, w) => s + w.reviews, 0);
    assert.equal(report.totals.reviews, 9);
    for (const total of [given, received, leaderboardTotal, weeklyTotal]) assert.equal(total, 9);
    assert.equal(report.reviewLoad.top1Share, round3(7 / 9));
    assert.equal(report.reviewLoad.busFactor50, 1);
  });

  it("counts issue closers, separating bots, and default-branch commits without merges", () => {
    const closedAt = T0 + 4 * D;
    const report = buildReport(
      activity({
        issues: [
          issue(1, { state: "CLOSED", closedAt, closedBy: carol, stateReason: "COMPLETED" }),
          issue(2, { state: "CLOSED", closedAt, closedBy: bot("stale"), stateReason: "NOT_PLANNED" }),
        ],
        commits: [commit("a", "alice", T0 + D), commit("b", "alice", T0 + D, { isMerge: true }), commit("c", "Dana", T0 + D, { authorLinked: false })],
      }),
      window,
    );
    assert.equal(report.totals.issuesClosed, 2);
    assert.equal(report.dataQuality.issuesClosedByBots, 1);
    assert.deepEqual(report.leaderboards.closers, [{ login: "carol", closed: 1, completed: 1, notPlanned: 0 }]);
    assert.equal(report.totals.commits, 2);
    assert.equal(report.dataQuality.unlinkedCommitAuthors, 1);
  });

  it("buckets weeks from Monday UTC and marks partial weeks", () => {
    const report = buildReport(activity(), { since: T0 + 2 * D, until: T0 + 9 * D });
    assert.deepEqual(report.weekly.map((w) => [w.weekStart, w.partial]), [
      ["2026-10-05", true],
      ["2026-10-12", true],
    ]);
  });

  it("is deterministic for identical input", () => {
    const data = activity({ pullRequests: [pr(1, alice, { reviews: [review(bob, T0 + D), review(carol, T0 + D)] })] });
    assert.equal(JSON.stringify(buildReport(data, window)), JSON.stringify(buildReport(data, window)));
  });

  it("returns empty-but-valid metrics for a quiet repository", () => {
    const report = buildReport(activity(), window);
    assert.equal(report.totals.prsMerged, 0);
    assert.equal(report.reviewLoad.gini, null);
    assert.equal(report.flow.unreviewedMerges.rate, null);
    assert.equal(report.weekly.length, 2);
  });
});

describe("roleOf", () => {
  it("needs enough activity before labelling anyone", () => {
    assert.equal(roleOf(2, 0), "light");
    assert.equal(roleOf(3, 0), "carrying");
    assert.equal(roleOf(0, 3), "receiving");
    assert.equal(roleOf(4, 3), "balanced");
  });
});

const round3 = (n: number) => Math.round(n * 1000) / 1000;

describe("contributor identity", () => {
  it("never merges a git author name with a GitHub login, and fact ids stay attribute-safe", async () => {
    const { buildFactSheet } = await import("../src/narrative/facts.ts");
    const report = buildReport(
      activity({
        commits: [commit("a", "alice", T0 + D), commit("b", "alice", T0 + D, { authorLinked: false }), commit("c", "Jane Doe", T0 + D, { authorLinked: false })],
      }),
      window,
    );
    const rows = report.leaderboards.contributors.map((c) => [c.login, c.linked, c.commits]);
    assert.deepEqual(rows, [
      ["alice", true, 1],
      ["alice", false, 1],
      ["Jane Doe", false, 1],
    ]);
    const ids = buildFactSheet(report).facts.map((f) => f.id);
    assert.ok(ids.includes("contributor.git_Jane_Doe.commits"));
    assert.ok(ids.includes("contributor.alice.commits") && ids.includes("contributor.git_alice.commits"));
    assert.equal(new Set(ids).size, ids.length, "fact ids must be unique");
    assert.ok(ids.every((id) => /^[A-Za-z0-9_.-]+$/.test(id)), "fact ids must be single attribute tokens");
  });
});
