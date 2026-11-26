/**
 * Normalized activity records. The GitHub adapter produces these, the store persists them,
 * and the insight engine consumes them. All timestamps are epoch milliseconds (UTC).
 */

export type RepoRef = { owner: string; name: string };

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`.toLowerCase();
}

export type Actor = { login: string; isBot: boolean };

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export type Review = {
  id: string;
  reviewer: Actor | null; // null = deleted account ("ghost")
  state: ReviewState;
  submittedAt: number;
  comments: number;
};

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: Actor | null;
  createdAt: number;
  /** When the PR left draft. Equals createdAt for PRs opened ready for review. */
  readyAt: number;
  updatedAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  /** True when GitHub reported more reviews than we fetched for this PR. */
  reviewsTruncated: boolean;
  reviews: Review[];
};

export type Issue = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  author: Actor | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  closedBy: Actor | null;
  comments: number;
};

export type Commit = {
  oid: string;
  committedAt: number;
  /** GitHub login when the commit email maps to an account, otherwise the git author name. */
  author: string;
  authorLinked: boolean;
  isBot: boolean;
  additions: number;
  deletions: number;
  isMerge: boolean;
};

/** Everything the insight engine needs for one repository and one period. */
export type RepoActivity = {
  repo: RepoRef;
  defaultBranch: string | null;
  pullRequests: PullRequest[];
  issues: Issue[];
  commits: Commit[];
};

export type Window = { since: number; until: number };

export function inWindow(ts: number | null, window: Window): ts is number {
  return ts !== null && ts >= window.since && ts < window.until;
}
