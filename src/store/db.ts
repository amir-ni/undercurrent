import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Schema is applied idempotently on boot. Versioned via PRAGMA user_version so a future
 * migration can be appended as MIGRATIONS[n] without touching existing databases.
 */
const MIGRATIONS: string[] = [
  /* sql */ `
  CREATE TABLE repos (
    key            TEXT PRIMARY KEY,           -- lowercased "owner/name"
    owner          TEXT NOT NULL,
    name           TEXT NOT NULL,
    default_branch TEXT
  );

  -- One row per (repo, resource). covered_since: everything updated at/after it is stored,
  -- as of synced_at. truncated: the last sync hit the safety cap, so coverage is partial.
  CREATE TABLE sync_state (
    repo_key      TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    resource      TEXT NOT NULL CHECK (resource IN ('pull_requests', 'issues', 'commits')),
    covered_since INTEGER NOT NULL,
    synced_at     INTEGER NOT NULL,
    truncated     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo_key, resource)
  );

  CREATE TABLE pull_requests (
    repo_key          TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    number            INTEGER NOT NULL,
    title             TEXT NOT NULL,
    url               TEXT NOT NULL,
    state             TEXT NOT NULL,
    is_draft          INTEGER NOT NULL,
    author            TEXT,
    author_is_bot     INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    ready_at          INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    merged_at         INTEGER,
    closed_at         INTEGER,
    additions         INTEGER NOT NULL,
    deletions         INTEGER NOT NULL,
    reviews_truncated INTEGER NOT NULL,
    PRIMARY KEY (repo_key, number)
  );
  CREATE INDEX pull_requests_updated ON pull_requests (repo_key, updated_at);

  CREATE TABLE reviews (
    id              TEXT PRIMARY KEY,
    repo_key        TEXT NOT NULL,
    pr_number       INTEGER NOT NULL,
    reviewer        TEXT,
    reviewer_is_bot INTEGER NOT NULL,
    state           TEXT NOT NULL,
    submitted_at    INTEGER NOT NULL,
    comments        INTEGER NOT NULL,
    FOREIGN KEY (repo_key, pr_number) REFERENCES pull_requests(repo_key, number) ON DELETE CASCADE
  );
  CREATE INDEX reviews_pr ON reviews (repo_key, pr_number);

  CREATE TABLE issues (
    repo_key       TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    url            TEXT NOT NULL,
    state          TEXT NOT NULL,
    state_reason   TEXT,
    author         TEXT,
    author_is_bot  INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    closed_at      INTEGER,
    closed_by      TEXT,
    closed_by_is_bot INTEGER NOT NULL,
    comments       INTEGER NOT NULL,
    PRIMARY KEY (repo_key, number)
  );
  CREATE INDEX issues_updated ON issues (repo_key, updated_at);

  CREATE TABLE commits (
    repo_key      TEXT NOT NULL REFERENCES repos(key) ON DELETE CASCADE,
    oid           TEXT NOT NULL,
    committed_at  INTEGER NOT NULL,
    author        TEXT NOT NULL,
    author_linked INTEGER NOT NULL,
    is_bot        INTEGER NOT NULL,
    additions     INTEGER NOT NULL,
    deletions     INTEGER NOT NULL,
    is_merge      INTEGER NOT NULL,
    PRIMARY KEY (repo_key, oid)
  );
  CREATE INDEX commits_committed ON commits (repo_key, committed_at);

  -- LLM narratives keyed by a hash of (prompt version, model, fact sheet): identical inputs never pay twice.
  CREATE TABLE narratives (
    cache_key  TEXT PRIMARY KEY,
    repo_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    body       TEXT NOT NULL
  );
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
