import { inWindow, repoKey, type PullRequest, type RepoActivity, type Review, type Window } from "../domain.ts";
import { busFactor, DAY, gini, HOUR, median, percentile, round, topShare } from "./stats.ts";

/**
 * The insight engine: a pure function from stored activity + a period to a report.
 * No I/O, deterministic ordering (ties broken by login) so identical inputs give byte-identical
 * output — which is what makes ETags and the LLM narrative cache effective.
 *
 * Counting rules (applied everywhere):
 *  - Bot accounts are excluded from human metrics and counted separately in `dataQuality`.
 *  - A "review" is a submitted review (approve / request changes / comment / dismissed) by someone
 *    other than the PR author. Authors replying in their own PR's review UI are not reviewing.
 *  - An event counts toward the period when its own timestamp is inside [since, until).
 */

export type Role = "carrying" | "balanced" | "receiving" | "light";

export type PersonLoad = {
  login: string;
  reviewsGiven: number;
  prsReviewed: number;
  approvals: number;
  changesRequested: number;
  reviewComments: number;
  reviewsReceived: number;
  prsAuthored: number;
  prsMerged: number;
  /** reviewsGiven / reviewsReceived; null when nothing was received. */
  reciprocity: number | null;
  role: Role;
};

export type ContributorRow = { login: string; linked: boolean; prsMerged: number; linesChanged: number; commits: number; prsOpened: number };
export type ReviewerRow = { login: string; reviews: number; prsReviewed: number; approvals: number; changesRequested: number; comments: number };
export type CloserRow = { login: string; closed: number; completed: number; notPlanned: number };
export type PrRef = { number: number; title: string; url: string; author: string | null; hours: number };

export type WeekBucket = {
  weekStart: string;
  partial: boolean;
  prsOpened: number;
  prsMerged: number;
  reviews: number;
  activeReviewers: number;
  medianTtfrHours: number | null;
  ttfrSample: number;
};

export type InsightReport = {
  repo: string;
  defaultBranch: string | null;
  window: { since: string; until: string; days: number };
  totals: {
    prsOpened: number;
    prsMerged: number;
    prsClosedUnmerged: number;
    reviews: number;
    reviewComments: number;
    issuesOpened: number;
    issuesClosed: number;
    commits: number;
    activePeople: number;
  };
  flow: {
    timeToFirstReview: { sample: number; p50Hours: number | null; p90Hours: number | null; awaiting: number; awaitingOldestHours: number | null };
    cycleTime: { sample: number; p50Hours: number | null; p90Hours: number | null };
    unreviewedMerges: { merged: number; unreviewed: number; rate: number | null };
    prSize: { p50Lines: number | null; p90Lines: number | null };
  };
  reviewLoad: {
    totalReviews: number;
    reviewers: number;
    top1Share: number | null;
    top3Share: number | null;
    gini: number | null;
    busFactor50: number | null;
    people: PersonLoad[];
  };
  leaderboards: { contributors: ContributorRow[]; reviewers: ReviewerRow[]; closers: CloserRow[] };
  weekly: WeekBucket[];
  notable: { slowestFirstReview: PrRef[]; awaitingReview: PrRef[]; largestMerged: PrRef[] };
  dataQuality: {
    botPrsExcluded: number;
    botReviewsExcluded: number;
    selfReviewsExcluded: number;
    issuesClosedByBots: number;
    prsWithTruncatedReviews: number;
    unlinkedCommitAuthors: number;
  };
};

export type LeaderboardKind = keyof InsightReport["leaderboards"];
export const LEADERBOARD_KINDS: readonly LeaderboardKind[] = ["contributors", "reviewers", "closers"];

const REPORT_LIST_LIMIT = 10;
const PEOPLE_LIMIT = 40;
const NOTABLE_LIMIT = 5;

const byLogin = (a: { login: string }, b: { login: string }) => a.login.localeCompare(b.login);

/** Reviews that count as human review of someone else's PR. */
function isPeerReview(review: Review, pr: PullRequest): boolean {
  return review.reviewer !== null && !review.reviewer.isBot && review.reviewer.login !== pr.author?.login;
}

export function buildReport(activity: RepoActivity, window: Window, options: { listLimit?: number } = {}): InsightReport {
  const listLimit = options.listLimit ?? REPORT_LIST_LIMIT;
  const humanPrs = activity.pullRequests.filter((pr) => pr.author !== null && !pr.author.isBot);
  const quality = {
    botPrsExcluded: activity.pullRequests.filter((pr) => pr.author?.isBot && (inWindow(pr.createdAt, window) || inWindow(pr.mergedAt, window))).length,
    botReviewsExcluded: 0,
    selfReviewsExcluded: 0,
    issuesClosedByBots: 0,
    prsWithTruncatedReviews: 0,
    unlinkedCommitAuthors: 0,
  };

  // ---- People ledger (review load + authorship) ----
  const people = new Map<string, PersonLoad & { reviewedPrs: Set<number> }>();
  const person = (login: string) => {
    let p = people.get(login);
    if (!p) {
      p = { login, reviewsGiven: 0, prsReviewed: 0, approvals: 0, changesRequested: 0, reviewComments: 0, reviewsReceived: 0, prsAuthored: 0, prsMerged: 0, reciprocity: null, role: "light", reviewedPrs: new Set() };
      people.set(login, p);
    }
    return p;
  };

  let totalReviews = 0;
  let totalReviewComments = 0;
  const mergedSizes: number[] = [];
  const cycleHours: number[] = [];
  let unreviewedMerges = 0;
  let mergedCount = 0;
  let closedUnmerged = 0;
  let opened = 0;

  for (const pr of activity.pullRequests) {
    if (pr.reviewsTruncated && pr.updatedAt >= window.since) quality.prsWithTruncatedReviews++;
    for (const review of pr.reviews) {
      if (!inWindow(review.submittedAt, window) || review.reviewer === null) continue;
      if (review.reviewer.isBot) {
        quality.botReviewsExcluded++;
        continue;
      }
      if (review.reviewer.login === pr.author?.login) {
        quality.selfReviewsExcluded++;
        continue;
      }
      // Reviewing a bot PR (e.g. a dependency bump) is still review work for the reviewer; nobody "receives" it.
      const reviewer = person(review.reviewer.login);
      reviewer.reviewsGiven++;
      reviewer.reviewedPrs.add(pr.number);
      reviewer.reviewComments += review.comments;
      if (review.state === "APPROVED") reviewer.approvals++;
      if (review.state === "CHANGES_REQUESTED") reviewer.changesRequested++;
      if (pr.author && !pr.author.isBot) person(pr.author.login).reviewsReceived++;
      totalReviews++;
      totalReviewComments += review.comments;
    }
  }

  // ---- Flow: authorship, merges, time to first review ----
  const ttfr: Array<{ pr: PullRequest; hours: number }> = [];
  const awaiting: Array<{ pr: PullRequest; hours: number }> = [];
  for (const pr of humanPrs) {
    const author = pr.author!.login;
    if (inWindow(pr.createdAt, window)) {
      opened++;
      person(author).prsAuthored++;
    }
    if (inWindow(pr.mergedAt, window)) {
      mergedCount++;
      person(author).prsMerged++;
      mergedSizes.push(pr.additions + pr.deletions);
      cycleHours.push((pr.mergedAt - pr.readyAt) / HOUR);
      if (!pr.reviews.some((r) => isPeerReview(r, pr) && r.submittedAt <= pr.mergedAt!)) unreviewedMerges++;
    } else if (pr.mergedAt === null && inWindow(pr.closedAt, window)) {
      closedUnmerged++;
    }

    // Time to first review: PRs that became ready for review during the period.
    if (!inWindow(pr.readyAt, window) || pr.isDraft) continue;
    const first = firstPeerReviewAt(pr);
    if (first !== null && first < window.until) {
      ttfr.push({ pr, hours: Math.max(0, first - pr.readyAt) / HOUR });
    } else {
      const endedAt = pr.mergedAt ?? pr.closedAt;
      if (endedAt === null || endedAt >= window.until) awaiting.push({ pr, hours: (window.until - pr.readyAt) / HOUR });
    }
  }

  for (const p of people.values()) {
    p.prsReviewed = p.reviewedPrs.size;
    p.reciprocity = p.reviewsReceived > 0 ? round(p.reviewsGiven / p.reviewsReceived, 2) : null;
    p.role = roleOf(p.reviewsGiven, p.reviewsReceived);
  }

  const reviewCounts = [...people.values()].map((p) => p.reviewsGiven).filter((n) => n > 0);
  const ttfrHours = ttfr.map((t) => t.hours);

  // ---- Leaderboards ----
  const contributors = new Map<string, ContributorRow>();
  const contributor = (login: string, linked: boolean) => {
    const key = linked ? login : `git:${login}`; // a git author name is not a GitHub identity
    let row = contributors.get(key);
    if (!row) {
      row = { login, linked, prsMerged: 0, linesChanged: 0, commits: 0, prsOpened: 0 };
      contributors.set(key, row);
    }
    return row;
  };
  for (const pr of humanPrs) {
    if (inWindow(pr.createdAt, window)) contributor(pr.author!.login, true).prsOpened++;
    if (inWindow(pr.mergedAt, window)) {
      const row = contributor(pr.author!.login, true);
      row.prsMerged++;
      row.linesChanged += pr.additions + pr.deletions;
    }
  }
  let commitCount = 0;
  const unlinked = new Set<string>();
  for (const commit of activity.commits) {
    if (!inWindow(commit.committedAt, window) || commit.isBot || commit.isMerge) continue;
    commitCount++;
    contributor(commit.author, commit.authorLinked).commits++;
    if (!commit.authorLinked) unlinked.add(commit.author);
  }
  quality.unlinkedCommitAuthors = unlinked.size;

  const closers = new Map<string, CloserRow>();
  let issuesOpened = 0;
  let issuesClosed = 0;
  for (const issue of activity.issues) {
    if (issue.author && !issue.author.isBot && inWindow(issue.createdAt, window)) issuesOpened++;
    if (issue.state !== "CLOSED" || !inWindow(issue.closedAt, window)) continue;
    issuesClosed++;
    if (!issue.closedBy) continue;
    if (issue.closedBy.isBot) {
      quality.issuesClosedByBots++;
      continue;
    }
    const row = closers.get(issue.closedBy.login) ?? { login: issue.closedBy.login, closed: 0, completed: 0, notPlanned: 0 };
    row.closed++;
    if (issue.stateReason === "COMPLETED") row.completed++;
    if (issue.stateReason === "NOT_PLANNED") row.notPlanned++;
    closers.set(row.login, row);
  }

  const peopleList = [...people.values()]
    .filter((p) => p.reviewsGiven + p.reviewsReceived + p.prsAuthored + p.prsMerged > 0)
    .map(({ reviewedPrs: _drop, ...rest }) => rest);

  return {
    repo: repoKey(activity.repo),
    defaultBranch: activity.defaultBranch,
    window: { since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString(), days: round((window.until - window.since) / DAY, 1)! },
    totals: {
      prsOpened: opened,
      prsMerged: mergedCount,
      prsClosedUnmerged: closedUnmerged,
      reviews: totalReviews,
      reviewComments: totalReviewComments,
      issuesOpened,
      issuesClosed,
      commits: commitCount,
      activePeople: new Set([...peopleList.map((p) => p.login), ...[...contributors.values()].filter((c) => c.linked).map((c) => c.login)]).size,
    },
    flow: {
      timeToFirstReview: {
        sample: ttfr.length,
        p50Hours: round(median(ttfrHours)),
        p90Hours: round(percentile(ttfrHours, 0.9)),
        awaiting: awaiting.length,
        awaitingOldestHours: round(awaiting.reduce<number | null>((max, a) => (max === null || a.hours > max ? a.hours : max), null)),
      },
      cycleTime: { sample: cycleHours.length, p50Hours: round(median(cycleHours)), p90Hours: round(percentile(cycleHours, 0.9)) },
      unreviewedMerges: { merged: mergedCount, unreviewed: unreviewedMerges, rate: mergedCount ? round(unreviewedMerges / mergedCount, 3) : null },
      prSize: { p50Lines: round(median(mergedSizes), 0), p90Lines: round(percentile(mergedSizes, 0.9), 0) },
    },
    reviewLoad: {
      totalReviews,
      reviewers: reviewCounts.length,
      top1Share: round(topShare(reviewCounts, 1), 3),
      top3Share: round(topShare(reviewCounts, 3), 3),
      gini: round(gini(reviewCounts), 3),
      busFactor50: busFactor(reviewCounts, 0.5),
      people: peopleList
        .sort((a, b) => b.reviewsGiven + b.reviewsReceived - (a.reviewsGiven + a.reviewsReceived) || b.prsMerged - a.prsMerged || byLogin(a, b))
        .slice(0, PEOPLE_LIMIT),
    },
    leaderboards: {
      contributors: rankContributors([...contributors.values()]).slice(0, listLimit),
      reviewers: rankReviewers(peopleList).slice(0, listLimit),
      closers: rankClosers([...closers.values()]).slice(0, listLimit),
    },
    weekly: buildWeekly(activity, humanPrs, ttfr, window),
    notable: {
      slowestFirstReview: ttfr
        .sort((a, b) => b.hours - a.hours || a.pr.number - b.pr.number)
        .slice(0, NOTABLE_LIMIT)
        .map(({ pr, hours }) => prRef(pr, hours)),
      awaitingReview: awaiting
        .sort((a, b) => b.hours - a.hours || a.pr.number - b.pr.number)
        .slice(0, NOTABLE_LIMIT)
        .map(({ pr, hours }) => prRef(pr, hours)),
      largestMerged: humanPrs
        .filter((pr) => inWindow(pr.mergedAt, window))
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.number - b.number)
        .slice(0, NOTABLE_LIMIT)
        .map((pr) => prRef(pr, (pr.mergedAt! - pr.readyAt) / HOUR)),
    },
    dataQuality: quality,
  };
}

function firstPeerReviewAt(pr: PullRequest): number | null {
  let first: number | null = null;
  for (const r of pr.reviews) if (isPeerReview(r, pr) && (first === null || r.submittedAt < first)) first = r.submittedAt;
  return first;
}

/** Classifies review reciprocity. Thresholds keep one-off reviewers out of the "carrying" bucket. */
export function roleOf(given: number, received: number): Role {
  if (given + received < 3) return "light";
  if (given >= 3 && given >= 2 * received) return "carrying";
  if (received >= 3 && received >= 2 * given) return "receiving";
  return "balanced";
}

function rankContributors(rows: ContributorRow[]): ContributorRow[] {
  return [...rows].sort((a, b) => b.prsMerged - a.prsMerged || b.commits - a.commits || b.linesChanged - a.linesChanged || byLogin(a, b));
}

function rankReviewers(people: PersonLoad[]): ReviewerRow[] {
  return people
    .filter((p) => p.reviewsGiven > 0)
    .map((p) => ({ login: p.login, reviews: p.reviewsGiven, prsReviewed: p.prsReviewed, approvals: p.approvals, changesRequested: p.changesRequested, comments: p.reviewComments }))
    .sort((a, b) => b.reviews - a.reviews || b.comments - a.comments || byLogin(a, b));
}

function rankClosers(rows: CloserRow[]): CloserRow[] {
  return [...rows].sort((a, b) => b.closed - a.closed || byLogin(a, b));
}

function prRef(pr: PullRequest, hours: number): PrRef {
  return { number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login ?? null, hours: round(hours)! };
}

/** ISO-week buckets (Monday 00:00 UTC). First/last buckets are flagged partial when the period cuts them. */
function buildWeekly(activity: RepoActivity, humanPrs: PullRequest[], ttfr: Array<{ pr: PullRequest; hours: number }>, window: Window): WeekBucket[] {
  const WEEK = 7 * DAY;
  const firstMonday = (() => {
    const d = new Date(window.since);
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
  })();
  const count = Math.max(1, Math.ceil((window.until - firstMonday) / WEEK));
  const buckets = Array.from({ length: count }, (_, i) => ({
    start: firstMonday + i * WEEK,
    prsOpened: 0,
    prsMerged: 0,
    reviews: 0,
    reviewers: new Set<string>(),
    ttfr: [] as number[],
  }));
  const at = (ts: number) => buckets[Math.floor((ts - firstMonday) / WEEK)];

  for (const pr of humanPrs) {
    if (inWindow(pr.createdAt, window)) at(pr.createdAt)!.prsOpened++;
    if (inWindow(pr.mergedAt, window)) at(pr.mergedAt)!.prsMerged++;
  }
  for (const pr of activity.pullRequests) {
    for (const r of pr.reviews) {
      if (!inWindow(r.submittedAt, window) || !r.reviewer || r.reviewer.isBot || r.reviewer.login === pr.author?.login) continue;
      const b = at(r.submittedAt)!;
      b.reviews++;
      b.reviewers.add(r.reviewer.login);
    }
  }
  for (const t of ttfr) at(t.pr.readyAt)!.ttfr.push(t.hours);

  return buckets.map((b) => ({
    weekStart: new Date(b.start).toISOString().slice(0, 10),
    partial: b.start < window.since || b.start + WEEK > window.until,
    prsOpened: b.prsOpened,
    prsMerged: b.prsMerged,
    reviews: b.reviews,
    activeReviewers: b.reviewers.size,
    medianTtfrHours: round(median(b.ttfr)),
    ttfrSample: b.ttfr.length,
  }));
}
