import type { InsightReport } from "../insights/report.ts";
import { contributorKey, factSegment as seg } from "./fact-id.ts";

/**
 * The fact sheet is the only view of the data the LLM gets: a flat list of named numbers.
 * Every claim in the narrative must cite fact ids, which lets the server verify the evidence
 * chain and lets the UI link each claim back to the exact number on screen.
 *
 * Ids are stable and hierarchical (`person.alice.reviews_given`), so the UI can resolve
 * `person.alice.*` to the ledger row for alice.
 */

export type Unit = "count" | "hours" | "ratio" | "lines" | "people" | "days" | "label";

export type Fact = {
  id: string;
  label: string;
  value: number | string | null;
  unit: Unit;
  /** Sample size behind a statistic, when it is one. Drives the server-side confidence cap. */
  sample?: number;
};

export type UntrustedText = { id: string; title: string };

export type FactSheet = { facts: Fact[]; untrustedTitles: UntrustedText[] };

const PEOPLE_IN_SHEET = 8;
const CONTRIBUTORS_IN_SHEET = 5;
const CLOSERS_IN_SHEET = 3;

export function buildFactSheet(report: InsightReport): FactSheet {
  const facts: Fact[] = [];
  const add = (id: string, label: string, value: Fact["value"], unit: Unit, sample?: number) =>
    facts.push(sample === undefined ? { id, label, value, unit } : { id, label, value, unit, sample });

  const t = report.totals;
  add("window.days", "Length of the period", report.window.days, "days");
  add("totals.prs_opened", "PRs opened", t.prsOpened, "count");
  add("totals.prs_merged", "PRs merged", t.prsMerged, "count");
  add("totals.prs_closed_unmerged", "PRs closed without merging", t.prsClosedUnmerged, "count");
  add("totals.reviews", "Peer reviews submitted", t.reviews, "count");
  add("totals.review_comments", "Inline review comments", t.reviewComments, "count");
  add("totals.issues_opened", "Issues opened", t.issuesOpened, "count");
  add("totals.issues_closed", "Issues closed", t.issuesClosed, "count");
  add("totals.commits", "Non-merge commits on the default branch", t.commits, "count");
  add("totals.active_people", "People with any activity", t.activePeople, "people");

  const f = report.flow;
  add("flow.ttfr.p50_hours", "Median time to first review", f.timeToFirstReview.p50Hours, "hours", f.timeToFirstReview.sample);
  add("flow.ttfr.p90_hours", "90th percentile time to first review", f.timeToFirstReview.p90Hours, "hours", f.timeToFirstReview.sample);
  add("flow.ttfr.sample", "PRs that became ready and received a first review", f.timeToFirstReview.sample, "count");
  add("flow.ttfr.awaiting", "PRs ready for review still waiting for a first review", f.timeToFirstReview.awaiting, "count");
  add("flow.ttfr.awaiting_oldest_hours", "Longest current wait for a first review", f.timeToFirstReview.awaitingOldestHours, "hours");
  add("flow.cycle.p50_hours", "Median ready-to-merge time", f.cycleTime.p50Hours, "hours", f.cycleTime.sample);
  add("flow.cycle.p90_hours", "90th percentile ready-to-merge time", f.cycleTime.p90Hours, "hours", f.cycleTime.sample);
  add("flow.unreviewed_merges.count", "Merged PRs with no peer review before merge", f.unreviewedMerges.unreviewed, "count");
  add("flow.unreviewed_merges.rate", "Share of merged PRs with no peer review", f.unreviewedMerges.rate, "ratio", f.unreviewedMerges.merged);
  add("flow.pr_size.p50_lines", "Median lines changed per merged PR", f.prSize.p50Lines, "lines", t.prsMerged);
  add("flow.pr_size.p90_lines", "90th percentile lines changed per merged PR", f.prSize.p90Lines, "lines", t.prsMerged);

  const l = report.reviewLoad;
  add("load.reviewers", "Distinct peer reviewers", l.reviewers, "people");
  add("load.top1_share", "Share of reviews done by the single busiest reviewer", l.top1Share, "ratio", l.totalReviews);
  add("load.top3_share", "Share of reviews done by the three busiest reviewers", l.top3Share, "ratio", l.totalReviews);
  add("load.gini", "Gini coefficient of reviews per reviewer (0 even, 1 concentrated)", l.gini, "ratio", l.reviewers);
  add("load.bus_factor_50", "Fewest reviewers who together did half of all reviews", l.busFactor50, "people", l.totalReviews);

  for (const p of l.people.slice(0, PEOPLE_IN_SHEET)) {
    const base = `person.${seg(p.login)}`;
    add(`${base}.reviews_given`, `${p.login}: reviews given`, p.reviewsGiven, "count");
    add(`${base}.reviews_received`, `${p.login}: reviews received on own PRs`, p.reviewsReceived, "count");
    add(`${base}.prs_merged`, `${p.login}: PRs merged`, p.prsMerged, "count");
    add(`${base}.reciprocity`, `${p.login}: reviews given per review received`, p.reciprocity, "ratio");
    add(`${base}.role`, `${p.login}: review role`, p.role, "label");
  }

  report.leaderboards.contributors.slice(0, CONTRIBUTORS_IN_SHEET).forEach((c, i) => {
    add(`contributor.${contributorKey(c.login, c.linked)}.prs_merged`, `#${i + 1} contributor ${c.login}: PRs merged`, c.prsMerged, "count");
    add(`contributor.${contributorKey(c.login, c.linked)}.commits`, `#${i + 1} contributor ${c.login}: commits`, c.commits, "count");
    add(`contributor.${contributorKey(c.login, c.linked)}.lines_changed`, `#${i + 1} contributor ${c.login}: lines changed in merged PRs`, c.linesChanged, "lines");
  });
  report.leaderboards.closers.slice(0, CLOSERS_IN_SHEET).forEach((c, i) => {
    add(`closer.${seg(c.login)}.closed`, `#${i + 1} issue closer ${c.login}: issues closed`, c.closed, "count");
  });

  for (const w of report.weekly) {
    const base = `week.${w.weekStart}`;
    const suffix = w.partial ? " (partial week)" : "";
    add(`${base}.prs_merged`, `Week of ${w.weekStart}: PRs merged${suffix}`, w.prsMerged, "count");
    add(`${base}.reviews`, `Week of ${w.weekStart}: reviews${suffix}`, w.reviews, "count");
    add(`${base}.active_reviewers`, `Week of ${w.weekStart}: active reviewers${suffix}`, w.activeReviewers, "people");
    add(`${base}.median_ttfr_hours`, `Week of ${w.weekStart}: median time to first review${suffix}`, w.medianTtfrHours, "hours", w.ttfrSample);
  }

  const untrustedTitles: UntrustedText[] = [];
  for (const pr of report.notable.slowestFirstReview) {
    add(`pr.${pr.number}.hours_to_first_review`, `PR #${pr.number} by ${pr.author ?? "unknown"}: hours to first review`, pr.hours, "hours");
    untrustedTitles.push({ id: `pr.${pr.number}`, title: pr.title });
  }
  for (const pr of report.notable.awaitingReview) {
    add(`pr.${pr.number}.awaiting_hours`, `PR #${pr.number} by ${pr.author ?? "unknown"}: hours waiting for a first review`, pr.hours, "hours");
    untrustedTitles.push({ id: `pr.${pr.number}`, title: pr.title });
  }

  const q = report.dataQuality;
  add("quality.bot_prs_excluded", "Bot-authored PRs excluded from human metrics", q.botPrsExcluded, "count");
  add("quality.bot_reviews_excluded", "Bot reviews excluded", q.botReviewsExcluded, "count");
  add("quality.issues_closed_by_bots", "Issues closed by bots", q.issuesClosedByBots, "count");
  add("quality.prs_with_truncated_reviews", "PRs with more reviews than were fetched", q.prsWithTruncatedReviews, "count");

  return { facts, untrustedTitles: dedupeById(untrustedTitles) };
}

function dedupeById(items: UntrustedText[]): UntrustedText[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}
