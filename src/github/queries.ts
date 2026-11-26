/**
 * GraphQL documents. One round trip per page pulls a PR together with its reviews and
 * ready-for-review event, which is what makes review-flow metrics affordable to compute.
 *
 * Connections are ordered by UPDATED_AT DESC so a sync can stop paginating as soon as it
 * reaches items older than what is already stored (incremental sync), instead of walking history.
 */

export const PR_PAGE_SIZE = 40;
export const REVIEWS_PER_PR = 60;
export const ISSUE_PAGE_SIZE = 100;
export const COMMIT_PAGE_SIZE = 100;

const ACTOR = `login __typename`;

export const PULL_REQUESTS_QUERY = /* GraphQL */ `
  query PullRequests($owner: String!, $name: String!, $cursor: String) {
    rateLimit { cost remaining }
    repository(owner: $owner, name: $name) {
      defaultBranchRef { name }
      pullRequests(first: ${PR_PAGE_SIZE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url state isDraft
          createdAt updatedAt mergedAt closedAt
          additions deletions
          author { ${ACTOR} }
          readyEvents: timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) {
            nodes { ... on ReadyForReviewEvent { createdAt } }
          }
          reviews(first: ${REVIEWS_PER_PR}) {
            totalCount
            nodes { id state submittedAt author { ${ACTOR} } comments { totalCount } }
          }
        }
      }
    }
  }
`;

export const ISSUES_QUERY = /* GraphQL */ `
  query Issues($owner: String!, $name: String!, $cursor: String, $since: DateTime!) {
    rateLimit { cost remaining }
    repository(owner: $owner, name: $name) {
      issues(first: ${ISSUE_PAGE_SIZE}, after: $cursor, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url state stateReason createdAt updatedAt closedAt
          author { ${ACTOR} }
          comments { totalCount }
          closedEvents: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
            nodes { ... on ClosedEvent { actor { ${ACTOR} } } }
          }
        }
      }
    }
  }
`;

export const COMMITS_QUERY = /* GraphQL */ `
  query Commits($owner: String!, $name: String!, $cursor: String, $since: GitTimestamp!) {
    rateLimit { cost remaining }
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: ${COMMIT_PAGE_SIZE}, after: $cursor, since: $since) {
              pageInfo { hasNextPage endCursor }
              nodes {
                oid committedDate additions deletions
                parents { totalCount }
                author { name user { ${ACTOR} } }
              }
            }
          }
        }
      }
    }
  }
`;

// ---- Response shapes (only the fields we select) ----

export type GqlActor = { login: string; __typename: string } | null;
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type RateLimit = { cost: number; remaining: number };

export type GqlPullRequest = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  author: GqlActor;
  readyEvents: { nodes: Array<{ createdAt?: string } | null> };
  reviews: {
    totalCount: number;
    nodes: Array<{ id: string; state: string; submittedAt: string | null; author: GqlActor; comments: { totalCount: number } } | null>;
  };
};

export type PullRequestsPage = {
  rateLimit: RateLimit;
  repository: { defaultBranchRef: { name: string } | null; pullRequests: { pageInfo: PageInfo; nodes: Array<GqlPullRequest | null> } } | null;
};

export type GqlIssue = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: GqlActor;
  comments: { totalCount: number };
  closedEvents: { nodes: Array<{ actor?: GqlActor } | null> };
};

export type IssuesPage = {
  rateLimit: RateLimit;
  repository: { issues: { pageInfo: PageInfo; nodes: Array<GqlIssue | null> } } | null;
};

export type GqlCommit = {
  oid: string;
  committedDate: string;
  additions: number;
  deletions: number;
  parents: { totalCount: number };
  author: { name: string | null; user: GqlActor } | null;
};

export type CommitsPage = {
  rateLimit: RateLimit;
  repository: {
    defaultBranchRef: { target: { history?: { pageInfo: PageInfo; nodes: Array<GqlCommit | null> } } | null } | null;
  } | null;
};
