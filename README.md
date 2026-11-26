# Undercurrent

**See the work behind the work.** Undercurrent is a small service that reads a public GitHub repository and answers a question commit graphs can't: *who is carrying the review load, and is it healthy?* It exposes a REST API, a Prometheus endpoint, and a lightweight web UI. An LLM analyst then explains what is unusual and why, with a confidence score and an evidence chain that links every claim back to the exact number it rests on.

[![CI](https://github.com/amir-ni/undercurrent/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/amir-ni/undercurrent/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A522.18-0E7BE0) ![License](https://img.shields.io/badge/license-MIT-0E7BE0)

---

## 60-second quickstart

You need **Node.js 22.18+** (24 recommended) and a **GitHub token**. A fine-grained token with *Public repositories (read-only)* access and no other permissions is enough. The GitHub GraphQL API requires a token even for public data.

```bash
cp .env.example .env        # then set GITHUB_TOKEN (and optionally ANTHROPIC_API_KEY)
```

```bash
npm ci && npm run build && npm start
```

Open http://localhost:8787 and pick a repository, or call the API:

```bash
curl -s "localhost:8787/v1/repos/honojs/hono/insights?days=30" | jq '.data.reviewLoad | {totalReviews, busFactor50, top1Share}'
```

**Or with Docker** (no local Node needed):

```bash
GITHUB_TOKEN=github_pat_xxx ANTHROPIC_API_KEY=sk-ant-xxx docker compose up --build
```

`ANTHROPIC_API_KEY` is optional. Without it, everything works except the `/narrative` endpoint, which returns `503 LLM_NOT_CONFIGURED` and the UI explains how to switch it on. To try the full narrative flow without a key, set `LLM_PROVIDER=demo`: a deterministic rule engine stands in for the model behind the same interface and goes through the same validation and grounding. It is labeled as rule-based, not an LLM, in both the API (`meta.provider: "demo"`) and the UI.

| Command | What it does |
|---|---|
| `npm start` | API + built UI on `:8787` (reads `.env`) |
| `npm run dev` + `npm run dev:web` | API with watch mode, and the UI with hot reload on `:5173` (proxies `/v1`) |
| `npm test` | 43 unit and API tests (Node's built-in test runner, no network) |
| `npm run check` | Typecheck server and UI, then run tests |
| `npm run build` | Build the UI into `web/dist` |

---

## The insight, and why this one

Most "top contributor" dashboards count commits and lines. They reward the people who *write* code and miss the people who make it *safe to merge*. Review work is the undercurrent of a team: invisible on a commit graph, and the first thing to collapse when one person goes on holiday.

So the flagship insight is the **review load ledger**, plus the flow signals that explain its consequences:

| Metric | Definition | Why it matters |
|---|---|---|
| **Review reciprocity** | Per person: peer reviews *given* on other people's PRs vs reviews *received* on their own. Role is **Carrying** (gives ≥ 2× and ≥ 3), **Mostly receiving** (the reverse), **Balanced** or **Light** (< 3 total). | Surfaces the quiet carriers and the authors whose work leans on others. |
| **Review bus factor** | Fewest reviewers who together did half of all reviews. Also: top-1 / top-3 share and Gini coefficient. | `1` means one absence stalls the merge queue. |
| **Time to first review** | From *ready for review* (not draft creation) to the first review by someone else. p50 / p90. PRs still waiting are counted separately, not silently dropped. | The single best predictor of contributor frustration. |
| **Merged without review** | Share of merged PRs with no peer review submitted *before* the merge. | A risk signal (not a verdict: some teams fast-path trusted changes). |
| **Ready → merge** | Cycle time for PRs merged in the period, p50 / p90. | Flow efficiency. |
| **Leaderboards** | Contributors (PRs merged → commits → lines), reviewers (reviews submitted), issue closers (human closures). | The classic views, done carefully. |
| **Weekly series** | Per ISO week: merged, opened, reviews, active reviewers, median time to first review. | Lets the analyst connect cause and effect over time. |

**Counting rules** (applied everywhere, unit-tested): bots are excluded from human metrics and reported separately; an author "reviewing" their own PR doesn't count; reviews people do on bot PRs still count as their work; an event belongs to a period when *its own* timestamp falls in `[since, until)`; merge commits are excluded from commit counts. Every number is deterministic, and the test suite asserts that totals reconcile across the ledger, the leaderboards and the weekly series.

Example finding on `honojs/hono` (30 days): one maintainer did **87.5%** of the 48 peer reviews (bus factor **1**), and **57%** of merges had no prior review.

---

## API

Base path `/v1`. All endpoints are `GET`, return JSON, and accept a period as `since` / `until` (`YYYY-MM-DD` or ISO-8601 with timezone) **or** `days` (default: the last 30 days ending at the current hour, max 180).

| Endpoint | Returns |
|---|---|
| `GET /v1/repos/{owner}/{repo}/insights` | Full report: totals, flow, review load ledger, leaderboards (top 10), weekly series, notable PRs, data quality. |
| `GET /v1/repos/{owner}/{repo}/leaderboards/{contributors\|reviewers\|closers}?limit=1..100` | One ranked leaderboard. |
| `GET /v1/repos/{owner}/{repo}/narrative` | LLM analysis: headline, narrative, 2–4 findings each with hypothesis, reasoning, confidence and evidence. |
| `GET /v1` | Endpoint index. |
| `GET /healthz`, `GET /readyz` | Liveness, readiness (checks the database). |
| `GET /metrics` | Prometheus metrics. |

```bash
curl -s "localhost:8787/v1/repos/vitejs/vite/leaderboards/reviewers?days=90&limit=5" | jq '.data.rows'
curl -s "localhost:8787/v1/repos/honojs/hono/narrative" | jq '.data | {headline, findings: [.findings[] | {title, confidence, evidence: [.evidence[].id]}]}'
curl -si "localhost:8787/v1/repos/honojs/hono/insights?since=2026-13-01"   # 400 problem+json
```

**HTTP semantics.** Successful responses are `{ data, meta }`, where `meta.coverage` says how far back the stored data reaches and whether a sync was truncated. Responses carry a strong `ETag` (identical data → identical bytes), so `If-None-Match` returns `304`. Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json` with a stable `code` (`BAD_REQUEST`, `REPO_NOT_FOUND`, `REPO_NOT_ALLOWED`, `RATE_LIMITED`, `UPSTREAM_RATE_LIMITED`, `LLM_NOT_CONFIGURED`, …) and the `requestId`, also sent as `X-Request-Id`. `429`/`503` include `Retry-After`; every `/v1` response carries `RateLimit-*` headers. `Server-Timing` shows sync / compute / LLM time in browser devtools. A ready-made collection is in [`api.http`](api.http).

---

## How the AI analyst works

The narrative endpoint is built so that the model **reasons** but the server **verifies**:

1. **Fact sheet, not raw data.** The report is flattened into ~100 named facts with stable ids (`load.top1_share`, `person.alice.reviews_given`, `week.2026-11-02.median_ttfr_hours`), each with a unit and, for statistics, its sample size. This is the model's only view of the data.
2. **Structured reasoning.** One call to Claude (`claude-opus-5-5`, adaptive thinking, configurable effort) with structured outputs enforcing the schema: headline, narrative, and findings with `observation`, `hypothesis` (or `null` when the signal doesn't support one), `reasoning` (including what would falsify it), `confidence` and `evidence: [factId]`. The prompt asks for hypotheses only when at least two facts point the same way.
3. **Server-side grounding.** Every answer is re-validated with Zod, then checked:
   - **Citations:** evidence ids that don't exist are rejected and reported; a finding left with no valid evidence is dropped.
   - **Figures:** numbers in the prose must be derivable from the facts (as-is, as a percentage, or hours↔days). Anything else is flagged as *unverified* in the API and the UI, never hidden.
   - **Calibration:** confidence is capped by the smallest sample behind the cited statistics (< 10 → 0.4, < 30 → 0.7, otherwise 0.9). The model's original value is kept as `modelConfidence`.
4. **Prompt-injection hygiene.** PR titles are the only free text the model sees. They are kept out of the facts, passed in a separate `<untrusted_pr_titles>` block, and the system prompt says to treat them as data. Output is rendered as text (React escaping), never HTML.
5. **Cost control.** Narratives are cached in SQLite by `sha256(prompt version, model, effort, fact sheet)`, so the same question is never paid for twice; concurrent identical requests share one call; the route has its own stricter rate limit. Server-side model fallback keeps the endpoint answering if the primary model declines.
6. **Demo provider.** `LLM_PROVIDER=demo` swaps Claude for a rule engine behind the same `NarrativeLlm` interface, for running without a key. Its output passes the same schema and grounding checks (on real repositories it produces zero invalid citations and zero unverified figures), which also makes it a regression fixture for the grounding layer.
7. **Evidence chain in the UI.** Each finding shows its evidence as chips; clicking one scrolls to and highlights the exact tile, ledger row, chart week or PR it refers to (switching leaderboard tabs if needed).

---

## Architecture

```
            ┌──────────── HTTP (Hono) ────────────┐
 browser ──▶│ request-id · logs · metrics · CSP    │──▶ /metrics (Prometheus)
 curl    ──▶│ rate limit · ETag · problem+json     │
            └───────┬──────────────────────┬───────┘
                    ▼                      ▼
            InsightService             Narrator ──▶ Claude (structured output)
       allowlist → sync → compute      fact sheet → cache → LLM → grounding
                    │                      │
            SyncService (single-flight,    │
            incremental / backfill)        │
                    │                      │
      GitHub GraphQL ◀── client (retry,    │
      (PRs+reviews,     backoff, timeouts) │
       issues, commits)                    │
                    ▼                      ▼
                 SQLite (node:sqlite, WAL): activity, sync state, narrative cache
```

| Path | Responsibility |
|---|---|
| `src/github/` | GraphQL client (timeouts, jittered retries, secondary rate-limit handling, error mapping), queries, normalization. |
| `src/sync/` | When to call GitHub: fresh → serve from DB; stale → incremental (since last sync − 5 min); uncovered → backfill. Single-flight per repo; safety cap marks coverage as truncated. |
| `src/store/` | Schema with versioned migrations, parameterized statements, narrative cache. |
| `src/insights/` | `buildReport`: a pure, deterministic function from activity + period to report. Stats helpers. |
| `src/narrative/` | Fact sheet, prompt and schema, Anthropic adapter, grounding, cache-aware orchestrator. |
| `src/http/`, `src/app.ts` | Validation, rate limiting, errors, routes, static UI. |
| `src/observability/` | Dependency-free Prometheus registry. |
| `web/` | React + Vite UI. Shares types with the server via `import type`, so the contract can't drift. |

---

## Observability and operations

- **Logs:** one JSON line per event to stdout/stderr, with `requestId` on every request line. Secret-looking keys (`token`, `authorization`, `api_key`, …) are redacted at any depth, and query strings are not logged. 5xx are logged at `warn` with the cause; unexpected errors at `error` with a stack, while the client only sees a generic message plus the request id.
- **Metrics** (`/metrics`): HTTP requests and latency by route template; GitHub calls by outcome (`ok`, `retry`, `error`), latency and remaining rate-limit points; syncs by mode and items fetched; narratives by outcome (`generated`, `cache_hit`, `error`), LLM latency and tokens; grounding counters (invalid citations, unverified figures), which make hallucination rate a dashboardable number. Labels never include repository names or logins, which keeps cardinality bounded and usage private.
- **Health:** `/healthz` (liveness), `/readyz` (database reachable, LLM on/off). The Docker image has a `HEALTHCHECK`.
- **Shutdown:** `SIGTERM`/`SIGINT` stop accepting connections, drain, close the database.

## CI/CD

- **`.github/workflows/ci.yml`** on every push and PR: typecheck, tests and UI build on Node 22 and 24; a smoke test that boots the built server and checks health, the UI, `/metrics` and a 400 path; `npm audit` for production dependencies; then a Docker build with layer caching.
- **`.github/workflows/release.yml`** on `main` and `v*` tags: builds and publishes the image to GHCR (`:main`, `:sha-…`, semver tags). Deploy targets pull the image; no secrets are baked in.
- **Dependabot** for npm, Actions and the Docker base image.

## Security

- Token read from the environment only, never logged (redaction) or sent to the browser. Use a read-only, public-repo-only token.
- No SSRF surface: the only upstream hosts are fixed (`api.github.com`, the Anthropic API). Owner and repo names are validated against GitHub's naming rules before use; all SQL is parameterized.
- Abuse controls: per-IP rate limits (client IP from the socket, not a spoofable header), a stricter limit on the paid LLM route, a max period of 180 days, a per-sync item cap, and an optional `REPO_ALLOWLIST`.
- Strict security headers and CSP (`script-src 'self'`); the UI only renders links that point at `https://github.com/`.
- The Docker container runs as a non-root user on a read-only root filesystem with `no-new-privileges`.

## Configuration

All settings come from environment variables (see [`.env.example`](.env.example)): `GITHUB_TOKEN` (required), `ANTHROPIC_API_KEY`, `LLM_PROVIDER` (`anthropic` or `demo`), `PORT`, `HOST`, `DATABASE_PATH`, `LOG_LEVEL`, `LLM_MODEL`, `LLM_EFFORT`, `SYNC_TTL_SECONDS`, `MAX_WINDOW_DAYS`, `MAX_PULL_REQUESTS_PER_SYNC`, `REPO_ALLOWLIST`, `RATE_LIMIT_PER_MINUTE`, `NARRATIVE_RATE_LIMIT_PER_MINUTE`, `CORS_ORIGINS`. Invalid values fail fast at startup with a readable message.

## Assumptions

- **Public repositories only**, read through one server-side token. Private repos would need per-user OAuth.
- **"Review" means a submitted GitHub review** (approve, request changes, comment, dismissed). Plain PR conversation comments are not reviews; reviews on bot-authored PRs count for the reviewer.
- **Time to first review** starts when a PR becomes ready for review and is measured for PRs that became ready in the period. A review submitted while the PR was still a draft counts as zero wait.
- **Merged without review** looks only at reviews submitted before the merge. Teams that review in other tools (pairing, Gerrit, Slack) will show high values; the UI and the analyst both say this is a signal, not a verdict.
- **Commits** are non-merge commits reachable from the default branch, attributed to the linked GitHub account, or to the git author name when the email isn't linked.
- **Times are UTC.** Weeks start on Monday.
- Up to 60 reviews per PR are fetched; PRs with more are counted in `dataQuality.prsWithTruncatedReviews`.

See [NOTES.md](NOTES.md) for the architecture tour, trade-offs, what I'd do next and how AI was used.

## License

[MIT](LICENSE)
