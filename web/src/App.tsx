import { BookOpen, FolderGit2, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Analyst, type NarrativeState } from "./components/Analyst.tsx";
import { ErrorPanel, Skeleton } from "./components/common.tsx";
import { Leaderboards } from "./components/Leaderboards.tsx";
import { CoverageNotice, Methodology } from "./components/Methodology.tsx";
import { PrLists } from "./components/PrLists.tsx";
import { QueryBar } from "./components/QueryBar.tsx";
import { ReviewLedger } from "./components/ReviewLedger.tsx";
import { StatTiles } from "./components/StatTiles.tsx";
import { WeeklyCharts } from "./components/WeeklyCharts.tsx";
import { ApiError, fetchInsights, fetchNarrative, parseRepoInput, safeGitHubUrl, type Envelope, type InsightReport, type Query } from "./lib/api.ts";
import { factAttr } from "./lib/evidence.ts";
import { date, int } from "./lib/format.ts";

type ReportState = { status: "idle" } | { status: "loading"; query: Query } | { status: "error"; query: Query; error: ApiError } | { status: "ready"; query: Query; envelope: Envelope<InsightReport> };

/** URL is the source of truth for the query, so results are shareable and Back works. */
function readQuery(): Query | null {
  const params = new URLSearchParams(window.location.search);
  const repo = parseRepoInput(params.get("repo") ?? "");
  const days = Number(params.get("days"));
  return repo ? { ...repo, days: [7, 30, 90].includes(days) ? days : 30 } : null;
}

function writeQuery(q: Query) {
  // owner/name are already validated to [A-Za-z0-9._-], so the slash can stay readable in the URL.
  const url = `?repo=${q.owner}/${q.name}&days=${q.days}`;
  if (url !== window.location.search) window.history.pushState(null, "", url);
}

const toApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError("Unexpected error.", "CLIENT_ERROR", 0, null, null));

export function App() {
  const [initial] = useState(readQuery);
  const [report, setReport] = useState<ReportState>({ status: "idle" });
  const [narrative, setNarrative] = useState<NarrativeState>({ status: "loading" });
  const controllers = useRef<{ report?: AbortController; narrative?: AbortController }>({});
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadNarrative = useCallback((query: Query) => {
    controllers.current.narrative?.abort();
    const ctrl = new AbortController();
    controllers.current.narrative = ctrl;
    setNarrative({ status: "loading" });
    fetchNarrative(query, ctrl.signal)
      .then((env) => setNarrative({ status: "ready", narrative: env.data }))
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setNarrative({ status: "error", error: toApiError(e) });
      });
  }, []);

  const load = useCallback(
    (query: Query, push = true) => {
      if (push) writeQuery(query);
      controllers.current.report?.abort();
      controllers.current.narrative?.abort();
      const ctrl = new AbortController();
      controllers.current.report = ctrl;
      setReport({ status: "loading", query });
      document.title = `${query.owner}/${query.name} · Undercurrent`;
      fetchInsights(query, ctrl.signal)
        .then((envelope) => {
          setReport({ status: "ready", query, envelope });
          // The narrative reuses the data the report just synced, so it starts only after the report lands.
          loadNarrative(query);
          requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
        })
        .catch((e: unknown) => {
          if ((e as Error).name !== "AbortError") setReport({ status: "error", query, error: toApiError(e) });
        });
    },
    [loadNarrative],
  );

  useEffect(() => {
    if (initial) load(initial, false);
    const onPop = () => {
      const q = readQuery();
      if (q) load(q, false);
      else {
        controllers.current.report?.abort();
        controllers.current.narrative?.abort();
        setReport({ status: "idle" });
        document.title = "Undercurrent · Collaboration insights";
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [initial, load]);

  const busy = report.status === "loading";
  const current = report.status === "idle" ? null : report.query;

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="nav">
        <div className="nav-inner">
          <a className="wordmark" href="/" aria-label="Undercurrent home">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            Undercurrent
          </a>
          <nav className="nav-links" aria-label="Resources">
            <a className="pill-link" href="/v1" target="_blank" rel="noopener noreferrer">
              <BookOpen size={16} aria-hidden="true" /> API
            </a>
            <a className="pill-link" href="/metrics" target="_blank" rel="noopener noreferrer">
              <Waves size={16} aria-hidden="true" /> Metrics
            </a>
          </nav>
        </div>
      </header>

      <main id="main">
        <div className="hero">
          <div>
            <p className="kicker">Collaboration insights for GitHub</p>
            <h1 className="page-title">
              See the work behind the work: <span className="gradient-text">who carries the reviews</span>
            </h1>
            <p className="lede">
              Commit counts miss the people who keep a codebase moving. Undercurrent measures review load, reciprocity and flow, then an AI analyst explains what is unusual and why,
              citing every number it uses.
            </p>
          </div>
          <QueryBar key={current ? `${current.owner}/${current.name}/${current.days}` : "empty"} initial={current} busy={busy} onSubmit={(q) => load(q)} />
        </div>

        <div aria-live="polite" className="visually-hidden">
          {report.status === "loading" && `Analyzing ${report.query.owner}/${report.query.name}`}
          {report.status === "ready" && `Report ready for ${report.query.owner}/${report.query.name}`}
        </div>

        {report.status === "idle" && <Intro />}
        {report.status === "loading" && <LoadingReport query={report.query} />}
        {report.status === "error" && (
          <div style={{ paddingTop: 8 }}>
            <ErrorPanel error={report.error} onRetry={() => load(report.query, false)} />
          </div>
        )}
        {report.status === "ready" && (
          <ReportView query={report.query} envelope={report.envelope} narrative={narrative} headingRef={headingRef} onRetryNarrative={() => loadNarrative(report.query)} />
        )}
      </main>

      <footer className="footer">
        Built on the GitHub GraphQL API. Data is read-only and limited to public repositories. Hypotheses come from an LLM and are labeled with confidence and evidence.
      </footer>
    </>
  );
}

function ReportView({
  query,
  envelope,
  narrative,
  headingRef,
  onRetryNarrative,
}: {
  query: Query;
  envelope: Envelope<InsightReport>;
  narrative: NarrativeState;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onRetryNarrative: () => void;
}) {
  const r = envelope.data;
  const repoUrl = safeGitHubUrl(`https://github.com/${query.owner}/${query.name}`);
  return (
    <div className="stack">
      <div className="report-head">
        <div>
          <h2 className="report-title" ref={headingRef} tabIndex={-1}>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer">
              <FolderGit2 size={22} aria-hidden="true" style={{ verticalAlign: -3, marginRight: 8 }} />
              {r.repo}
            </a>
          </h2>
          <p className="report-sub" {...factAttr("window.days")}>
            {date(r.window.since)} – {date(r.window.until)} · {r.window.days} days{r.defaultBranch && ` · default branch ${r.defaultBranch}`}
          </p>
        </div>
        <div className="totals-strip">
          <span {...factAttr("totals.commits")}>
            <b className="num">{int(r.totals.commits)}</b> commits
          </span>
          <span {...factAttr("totals.review_comments")}>
            <b className="num">{int(r.totals.reviewComments)}</b> review comments
          </span>
          <span {...factAttr("totals.active_people")}>
            <b className="num">{int(r.totals.activePeople)}</b> people active
          </span>
        </div>
      </div>
      <CoverageNotice coverage={envelope.meta.coverage} />
      <StatTiles report={r} />
      <Analyst state={narrative} onRetry={onRetryNarrative} />
      <ReviewLedger report={r} />
      <WeeklyCharts report={r} />
      <PrLists report={r} />
      <Leaderboards report={r} />
      <Methodology report={r} coverage={envelope.meta.coverage} />
    </div>
  );
}

function LoadingReport({ query }: { query: Query }) {
  return (
    <div className="stack" aria-busy="true">
      <div className="report-head">
        <div>
          <p className="report-title">
            {query.owner}/{query.name}
          </p>
          <p className="report-sub">Syncing pull requests, reviews, issues and commits from GitHub. A first sync of a busy repository can take up to a minute; repeat queries are instant.</p>
        </div>
      </div>
      <div className="grid-tiles">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={104} />
        ))}
      </div>
      <Skeleton height={260} />
      <Skeleton height={420} />
    </div>
  );
}

function Intro() {
  const items = [
    { title: "Review load ledger", body: "Who gives reviews and who receives them, so the quiet carriers become visible." },
    { title: "Flow and risk", body: "Time to first review from ready-for-review, PRs left waiting, and merges that skipped review." },
    { title: "AI analyst with receipts", body: "Root-cause hypotheses with calibrated confidence, every claim linked to the number it rests on." },
  ];
  return (
    <section className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", paddingTop: 8 }} aria-label="What you get">
      {items.map((i) => (
        <div className="empty" key={i.title}>
          <span className="icon-square">
            <Waves size={22} aria-hidden="true" />
          </span>
          <h2 className="card-title">{i.title}</h2>
          <p className="card-sub">{i.body}</p>
        </div>
      ))}
    </section>
  );
}
