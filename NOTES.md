# Submission notes

## 1. How to run it locally

Prerequisites: Node.js 22.18+ (24 recommended) or Docker, and a GitHub token with read-only access to public repositories. An Anthropic API key is optional and only needed for the narrative endpoint.

```bash
cp .env.example .env            # set GITHUB_TOKEN, optionally ANTHROPIC_API_KEY
npm ci
npm run build                   # builds the UI into web/dist
npm start                       # http://localhost:8787  (UI + API)
npm test                        # 43 tests, no network needed
```

Docker: `GITHUB_TOKEN=... ANTHROPIC_API_KEY=... docker compose up --build`, then open http://localhost:8787.

No Anthropic key? Set `LLM_PROVIDER=demo` to see the full narrative flow (evidence chain, confidence caps, grounding) driven by a clearly labeled rule engine instead of the model.

The first query for a repository syncs from GitHub (a few seconds for a mid-size repo, up to about a minute for a very busy one). Repeat queries within the sync TTL (15 minutes) are served from SQLite in milliseconds.

## 2. Architecture tour

The service is a single Node process (Hono on `@hono/node-server`) with SQLite (`node:sqlite`, WAL mode) as both the read model and the cache. A request for `/insights` goes through three layers. **Sync** decides whether GitHub needs to be called at all: it keeps per-repository, per-resource coverage (`covered_since`, `synced_at`), serves fresh data straight from the database, fetches only what changed since the last sync when data is stale, and backfills when someone asks for an older period. GraphQL lets one round trip bring a page of PRs together with their reviews and ready-for-review events; pages are ordered by `UPDATED_AT DESC`, so pagination stops at the first item older than the boundary instead of walking the whole history. Concurrent requests for the same repository share one in-flight sync. **Compute** is a pure function (`buildReport`) from stored activity and a period to a report. It is deterministic down to tie-breaking, which is what makes strong ETags and the narrative cache work, and it is where all counting rules live and are unit-tested. **Narrate** turns the report into a flat fact sheet with stable ids, asks Claude for a structured analysis, and then verifies the answer server-side (citations exist, figures are derivable from the facts, confidence is capped by sample size) before caching it.

The main decisions: I chose **review load and reciprocity** as the headline metric because it measures the collaboration work that commit counts hide, and because it produces findings worth explaining (a bus factor of 1, a maintainer self-merging most changes, contributors waiting on a single reviewer). I chose **GraphQL over REST** because review data per PR via REST is an N+1 problem that burns rate limit. I chose **verification over trust** for the LLM: the model is good at connecting facts into hypotheses, but the evidence chain is only worth something if the server checks it, so invalid citations are rejected, unverifiable figures are surfaced, and confidence is calibrated by sample size. On the frontend I followed an existing design system (tokens, typography, components, mobile-first rules, WCAG 2.2 AA) rather than inventing one, and the UI imports the server's types directly so the contract can't drift.

### Trade-offs I'd revisit

- **Sync runs inside the request.** Simple and correct, but a first sync of a very busy repository can take close to a minute (GitHub computes diff stats per PR, roughly 2 s per page of 40). The cap (`MAX_PULL_REQUESTS_PER_SYNC`) bounds it and the response says when coverage is partial. The production answer is a background job: `POST /v1/repos/{owner}/{repo}/syncs` returning `202 Accepted` with a job resource the UI polls, plus a scheduler that keeps watched repositories warm.
- **In-process state.** Rate-limit counters, single-flight maps and metrics live in memory, and SQLite is a local file. That is right for one instance. Horizontal scaling means Postgres for the store, Redis for rate limits and locks, and an OpenTelemetry exporter instead of the hand-rolled registry.
- **Synchronous SQLite.** `node:sqlite` blocks the event loop while a query runs. With indexed, bounded queries this is a few milliseconds, but at scale I'd move to an async driver or a worker thread.
- **Heuristic bot detection** (`__typename == Bot` or a `[bot]` suffix). Accounts like `renovate-bot` registered as users slip through; an exclusion list in configuration would fix it.
- **Merged without review** can't see review that happens outside GitHub. The UI and the analyst both frame it as a signal.

## 3. What I'd do next with another day

1. Background sync jobs with `202 Accepted` + polling, and scheduled refresh of watched repositories.
2. An OpenAPI 3.1 document generated from the Zod schemas, served at `/v1/openapi.json`.
3. An **eval set for the narrator**: a dozen frozen fact sheets with known "right answers" (for example a planted bus-factor-1 pattern), scored on citation validity, unverified-figure rate and whether the expected finding appears, run in CI against prompt changes.
4. Period-over-period comparison (this 30 days vs the previous 30) as first-class facts, which gives the analyst much stronger signals for root-cause hypotheses.
5. Per-reviewer latency (how long each reviewer takes to respond once requested) using review-request timeline events.
6. Postgres + Redis profile in `docker-compose` for multi-instance deployments.

## 4. How I used AI

I used Claude Code throughout as a pair programmer: to scaffold the project, draft modules, tests and documentation, and to drive a browser to check the UI at phone, tablet and wide-desktop sizes. I set the direction (the metric, the verification approach for the LLM, the design system to follow, the API semantics) and reviewed and corrected the output. Examples of things caught in review: response metadata that included per-request values and silently defeated ETag revalidation; chart labels shrinking on phones because the SVG scaled with its viewBox; axis ticks landing on uneven values; a slow GraphQL field that was fetched but never used. The product itself uses Claude (`claude-opus-5-5`) for the narrative endpoint, as described in the README.
