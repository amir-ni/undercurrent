import type { Actor, Commit, Issue, PullRequest, RepoActivity, Review } from "../src/domain.ts";

export const T0 = Date.UTC(2026, 9, 5); // Monday 2026-10-05
export const H = 3_600_000;
export const D = 24 * H;

export const human = (login: string): Actor => ({ login, isBot: false });
export const bot = (login: string): Actor => ({ login, isBot: true });

let reviewSeq = 0;
export function review(reviewer: Actor | null, submittedAt: number, state: Review["state"] = "APPROVED", comments = 0): Review {
  return { id: `R${++reviewSeq}`, reviewer, state, submittedAt, comments };
}

export function pr(number: number, author: Actor | null, overrides: Partial<PullRequest> = {}): PullRequest {
  const createdAt = overrides.createdAt ?? T0 + D;
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    author,
    createdAt,
    readyAt: createdAt,
    updatedAt: createdAt,
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 5,
    reviewsTruncated: false,
    reviews: [],
    ...overrides,
  };
}

export function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    state: "OPEN",
    stateReason: null,
    author: human("reporter"),
    createdAt: T0 + D,
    updatedAt: T0 + D,
    closedAt: null,
    closedBy: null,
    comments: 0,
    ...overrides,
  };
}

export function commit(oid: string, author: string, committedAt: number, overrides: Partial<Commit> = {}): Commit {
  return { oid, committedAt, author, authorLinked: true, isBot: false, additions: 3, deletions: 1, isMerge: false, ...overrides };
}

export function activity(parts: Partial<Omit<RepoActivity, "repo">> = {}): RepoActivity {
  return { repo: { owner: "acme", name: "app" }, defaultBranch: "main", pullRequests: [], issues: [], commits: [], ...parts };
}
