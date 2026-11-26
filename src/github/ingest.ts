import type { Actor, Commit, Issue, PullRequest, RepoRef, Review, ReviewState } from "../domain.ts";
import type { Logger } from "../logger.ts";
import type { GraphQLClient } from "./client.ts";
import {
  COMMITS_QUERY,
  ISSUES_QUERY,
  PULL_REQUESTS_QUERY,
  type CommitsPage,
  type GqlActor,
  type GqlCommit,
  type GqlIssue,
  type GqlPullRequest,
  type IssuesPage,
  type PullRequestsPage,
} from "./queries.ts";
import { AppError } from "../http/errors.ts";
import { metrics } from "../observability/metrics.ts";

/** Upstream fetchers: paginate GitHub, stop at a time boundary, normalize into domain records. */

export type FetchResult<T> = { items: T[]; truncated: boolean; defaultBranch?: string | null };

const ms = (iso: string) => Date.parse(iso);
const msOrNull = (iso: string | null) => (iso ? Date.parse(iso) : null);

export function toActor(actor: GqlActor): Actor | null {
  if (!actor) return null;
  return { login: actor.login, isBot: actor.__typename === "Bot" || actor.login.endsWith("[bot]") };
}

const REVIEW_STATES = new Set<ReviewState>(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

export function normalizePullRequest(node: GqlPullRequest): PullRequest {
  const createdAt = ms(node.createdAt);
  const readyEvent = node.readyEvents.nodes.find((n) => n?.createdAt)?.createdAt;
  const reviews: Review[] = [];
  for (const review of node.reviews.nodes) {
    // PENDING reviews are unsubmitted drafts (no submittedAt) and invisible to the author: skip.
    if (!review?.submittedAt || !REVIEW_STATES.has(review.state as ReviewState)) continue;
    reviews.push({
      id: review.id,
      reviewer: toActor(review.author),
      state: review.state as ReviewState,
      submittedAt: ms(review.submittedAt),
      comments: review.comments.totalCount,
    });
  }
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    isDraft: node.isDraft,
    author: toActor(node.author),
    createdAt,
    readyAt: readyEvent ? Math.max(createdAt, ms(readyEvent)) : createdAt,
    updatedAt: ms(node.updatedAt),
    mergedAt: msOrNull(node.mergedAt),
    closedAt: msOrNull(node.closedAt),
    additions: node.additions,
    deletions: node.deletions,
    reviewsTruncated: node.reviews.totalCount > node.reviews.nodes.length,
    reviews,
  };
}

export function normalizeIssue(node: GqlIssue): Issue {
  const closer = node.closedEvents.nodes.find((n) => n?.actor !== undefined)?.actor ?? null;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    stateReason: node.stateReason,
    author: toActor(node.author),
    createdAt: ms(node.createdAt),
    updatedAt: ms(node.updatedAt),
    closedAt: msOrNull(node.closedAt),
    closedBy: node.state === "CLOSED" ? toActor(closer) : null,
    comments: node.comments.totalCount,
  };
}

export function normalizeCommit(node: GqlCommit): Commit {
  const user = toActor(node.author?.user ?? null);
  return {
    oid: node.oid,
    committedAt: ms(node.committedDate),
    author: user?.login ?? node.author?.name ?? "unknown",
    authorLinked: user !== null,
    isBot: user?.isBot ?? false,
    additions: node.additions,
    deletions: node.deletions,
    isMerge: node.parents.totalCount > 1,
  };
}

/** PRs updated at or after `stopBefore`, newest first. A PR with any activity in a window was updated inside it. */
export async function fetchPullRequests(
  client: GraphQLClient,
  repo: RepoRef,
  stopBefore: number,
  maxItems: number,
  logger: Logger,
): Promise<FetchResult<PullRequest>> {
  const items: PullRequest[] = [];
  let cursor: string | null = null;
  let defaultBranch: string | null = null;
  for (;;) {
    const page: PullRequestsPage = await client.query(PULL_REQUESTS_QUERY, { owner: repo.owner, name: repo.name, cursor });
    if (!page.repository) throw new AppError("REPO_NOT_FOUND", "Repository not found, or it is not public.");
    defaultBranch = page.repository.defaultBranchRef?.name ?? null;
    const { nodes, pageInfo } = page.repository.pullRequests;
    metrics.githubRateLimitRemaining.set(page.rateLimit.remaining);
    logger.debug("fetched pull request page", { count: nodes.length, cost: page.rateLimit.cost, remaining: page.rateLimit.remaining });
    for (const node of nodes) {
      if (!node) continue;
      if (ms(node.updatedAt) < stopBefore) return { items, truncated: false, defaultBranch };
      items.push(normalizePullRequest(node));
      if (items.length >= maxItems) return { items, truncated: true, defaultBranch };
    }
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) return { items, truncated: false, defaultBranch };
    cursor = pageInfo.endCursor;
  }
}

export async function fetchIssues(
  client: GraphQLClient,
  repo: RepoRef,
  stopBefore: number,
  maxItems: number,
  logger: Logger,
): Promise<FetchResult<Issue>> {
  const items: Issue[] = [];
  let cursor: string | null = null;
  const since = new Date(stopBefore).toISOString();
  for (;;) {
    const page: IssuesPage = await client.query(ISSUES_QUERY, { owner: repo.owner, name: repo.name, cursor, since });
    if (!page.repository) throw new AppError("REPO_NOT_FOUND", "Repository not found, or it is not public.");
    const { nodes, pageInfo } = page.repository.issues;
    metrics.githubRateLimitRemaining.set(page.rateLimit.remaining);
    logger.debug("fetched issue page", { count: nodes.length, cost: page.rateLimit.cost, remaining: page.rateLimit.remaining });
    for (const node of nodes) {
      if (!node) continue;
      items.push(normalizeIssue(node));
      if (items.length >= maxItems) return { items, truncated: true };
    }
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) return { items, truncated: false };
    cursor = pageInfo.endCursor;
  }
}

/** Commits reachable from the default branch, committed at or after `stopBefore`. */
export async function fetchCommits(
  client: GraphQLClient,
  repo: RepoRef,
  stopBefore: number,
  maxItems: number,
  logger: Logger,
): Promise<FetchResult<Commit>> {
  const items: Commit[] = [];
  let cursor: string | null = null;
  const since = new Date(stopBefore).toISOString();
  for (;;) {
    const page: CommitsPage = await client.query(COMMITS_QUERY, { owner: repo.owner, name: repo.name, cursor, since });
    if (!page.repository) throw new AppError("REPO_NOT_FOUND", "Repository not found, or it is not public.");
    const history = page.repository.defaultBranchRef?.target?.history;
    if (!history) return { items, truncated: false }; // empty repository
    metrics.githubRateLimitRemaining.set(page.rateLimit.remaining);
    logger.debug("fetched commit page", { count: history.nodes.length, cost: page.rateLimit.cost, remaining: page.rateLimit.remaining });
    for (const node of history.nodes) {
      if (!node) continue;
      items.push(normalizeCommit(node));
      if (items.length >= maxItems) return { items, truncated: true };
    }
    if (!history.pageInfo.hasNextPage || !history.pageInfo.endCursor) return { items, truncated: false };
    cursor = history.pageInfo.endCursor;
  }
}
