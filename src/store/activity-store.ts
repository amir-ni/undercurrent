import type { DatabaseSync } from "node:sqlite";
import { repoKey, type Actor, type Commit, type Issue, type PullRequest, type RepoActivity, type RepoRef, type Review } from "../domain.ts";
import { transaction } from "./db.ts";

export type Resource = "pull_requests" | "issues" | "commits";
export type SyncState = { coveredSince: number; syncedAt: number; truncated: boolean };
export type SyncBatch =
  | { resource: "pull_requests"; items: PullRequest[] }
  | { resource: "issues"; items: Issue[] }
  | { resource: "commits"; items: Commit[] };

type Row = Record<string, string | number | null>;

const bool = (v: unknown) => v === 1;
const actor = (login: unknown, isBot: unknown): Actor | null => (typeof login === "string" ? { login, isBot: bool(isBot) } : null);

/** Persistence for synced GitHub activity. All statements are parameterized; no SQL is built from input. */
export class ActivityStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  getSyncState(repo: RepoRef, resource: Resource): SyncState | null {
    const row = this.db
      .prepare("SELECT covered_since, synced_at, truncated FROM sync_state WHERE repo_key = ? AND resource = ?")
      .get(repoKey(repo), resource) as Row | undefined;
    if (!row) return null;
    return { coveredSince: Number(row.covered_since), syncedAt: Number(row.synced_at), truncated: bool(row.truncated) };
  }

  saveSync(
    repo: RepoRef,
    defaultBranch: string | null | undefined,
    batch: SyncBatch,
    state: SyncState,
  ): void {
    const key = repoKey(repo);
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO repos (key, owner, name, default_branch) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET default_branch = COALESCE(excluded.default_branch, repos.default_branch)`,
        )
        .run(key, repo.owner, repo.name, defaultBranch ?? null);
      if (batch.resource === "pull_requests") this.writePullRequests(key, batch.items);
      else if (batch.resource === "issues") this.writeIssues(key, batch.items);
      else this.writeCommits(key, batch.items);
      this.db
        .prepare(
          `INSERT INTO sync_state (repo_key, resource, covered_since, synced_at, truncated) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo_key, resource) DO UPDATE SET covered_since = excluded.covered_since, synced_at = excluded.synced_at, truncated = excluded.truncated`,
        )
        .run(key, batch.resource, state.coveredSince, state.syncedAt, state.truncated ? 1 : 0);
    });
  }

  private writePullRequests(key: string, prs: PullRequest[]): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO pull_requests
       (repo_key, number, title, url, state, is_draft, author, author_is_bot, created_at, ready_at, updated_at,
        merged_at, closed_at, additions, deletions, reviews_truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const clearReviews = this.db.prepare("DELETE FROM reviews WHERE repo_key = ? AND pr_number = ?");
    const insertReview = this.db.prepare(
      `INSERT OR REPLACE INTO reviews (id, repo_key, pr_number, reviewer, reviewer_is_bot, state, submitted_at, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const pr of prs) {
      clearReviews.run(key, pr.number);
      upsert.run(
        key, pr.number, pr.title, pr.url, pr.state, pr.isDraft ? 1 : 0, pr.author?.login ?? null, pr.author?.isBot ? 1 : 0,
        pr.createdAt, pr.readyAt, pr.updatedAt, pr.mergedAt, pr.closedAt, pr.additions, pr.deletions,
        pr.reviewsTruncated ? 1 : 0,
      );
      for (const r of pr.reviews) {
        insertReview.run(r.id, key, pr.number, r.reviewer?.login ?? null, r.reviewer?.isBot ? 1 : 0, r.state, r.submittedAt, r.comments);
      }
    }
  }

  private writeIssues(key: string, issues: Issue[]): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO issues
       (repo_key, number, title, url, state, state_reason, author, author_is_bot, created_at, updated_at, closed_at,
        closed_by, closed_by_is_bot, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const i of issues) {
      upsert.run(
        key, i.number, i.title, i.url, i.state, i.stateReason, i.author?.login ?? null, i.author?.isBot ? 1 : 0,
        i.createdAt, i.updatedAt, i.closedAt, i.closedBy?.login ?? null, i.closedBy?.isBot ? 1 : 0, i.comments,
      );
    }
  }

  private writeCommits(key: string, commits: Commit[]): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO commits (repo_key, oid, committed_at, author, author_linked, is_bot, additions, deletions, is_merge)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of commits) {
      upsert.run(key, c.oid, c.committedAt, c.author, c.authorLinked ? 1 : 0, c.isBot ? 1 : 0, c.additions, c.deletions, c.isMerge ? 1 : 0);
    }
  }

  /** Loads every stored record that can carry activity at or after `since` (superset of any window starting there). */
  loadActivity(repo: RepoRef, since: number): RepoActivity {
    const key = repoKey(repo);
    const repoRow = this.db.prepare("SELECT default_branch FROM repos WHERE key = ?").get(key) as Row | undefined;

    const reviewsByPr = new Map<number, Review[]>();
    const reviewRows = this.db
      .prepare(
        `SELECT r.* FROM reviews r
         JOIN pull_requests p ON p.repo_key = r.repo_key AND p.number = r.pr_number
         WHERE p.repo_key = ? AND p.updated_at >= ?
         ORDER BY r.submitted_at`,
      )
      .all(key, since) as Row[];
    for (const r of reviewRows) {
      const list = reviewsByPr.get(Number(r.pr_number)) ?? [];
      list.push({
        id: String(r.id),
        reviewer: actor(r.reviewer, r.reviewer_is_bot),
        state: r.state as Review["state"],
        submittedAt: Number(r.submitted_at),
        comments: Number(r.comments),
      });
      reviewsByPr.set(Number(r.pr_number), list);
    }

    const prRows = this.db.prepare("SELECT * FROM pull_requests WHERE repo_key = ? AND updated_at >= ?").all(key, since) as Row[];
    const pullRequests: PullRequest[] = prRows.map((p) => ({
      number: Number(p.number),
      title: String(p.title),
      url: String(p.url),
      state: p.state as PullRequest["state"],
      isDraft: bool(p.is_draft),
      author: actor(p.author, p.author_is_bot),
      createdAt: Number(p.created_at),
      readyAt: Number(p.ready_at),
      updatedAt: Number(p.updated_at),
      mergedAt: p.merged_at === null ? null : Number(p.merged_at),
      closedAt: p.closed_at === null ? null : Number(p.closed_at),
      additions: Number(p.additions),
      deletions: Number(p.deletions),
      reviewsTruncated: bool(p.reviews_truncated),
      reviews: reviewsByPr.get(Number(p.number)) ?? [],
    }));

    const issueRows = this.db.prepare("SELECT * FROM issues WHERE repo_key = ? AND updated_at >= ?").all(key, since) as Row[];
    const issues: Issue[] = issueRows.map((i) => ({
      number: Number(i.number),
      title: String(i.title),
      url: String(i.url),
      state: i.state as Issue["state"],
      stateReason: i.state_reason === null ? null : String(i.state_reason),
      author: actor(i.author, i.author_is_bot),
      createdAt: Number(i.created_at),
      updatedAt: Number(i.updated_at),
      closedAt: i.closed_at === null ? null : Number(i.closed_at),
      closedBy: actor(i.closed_by, i.closed_by_is_bot),
      comments: Number(i.comments),
    }));

    const commitRows = this.db.prepare("SELECT * FROM commits WHERE repo_key = ? AND committed_at >= ?").all(key, since) as Row[];
    const commits: Commit[] = commitRows.map((c) => ({
      oid: String(c.oid),
      committedAt: Number(c.committed_at),
      author: String(c.author),
      authorLinked: bool(c.author_linked),
      isBot: bool(c.is_bot),
      additions: Number(c.additions),
      deletions: Number(c.deletions),
      isMerge: bool(c.is_merge),
    }));

    return {
      repo,
      defaultBranch: repoRow?.default_branch == null ? null : String(repoRow.default_branch),
      pullRequests,
      issues,
      commits,
    };
  }

  getNarrative(cacheKey: string): string | null {
    const row = this.db.prepare("SELECT body FROM narratives WHERE cache_key = ?").get(cacheKey) as Row | undefined;
    return row ? String(row.body) : null;
  }

  putNarrative(cacheKey: string, repo: RepoRef, body: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO narratives (cache_key, repo_key, created_at, body) VALUES (?, ?, ?, ?)")
      .run(cacheKey, repoKey(repo), Date.now(), body);
  }
}
