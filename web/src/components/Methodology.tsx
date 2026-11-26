import { Info } from "lucide-react";
import type { Coverage, InsightReport } from "../lib/api.ts";
import { factAttr } from "../lib/evidence.ts";
import { ago, date, int } from "../lib/format.ts";

export function CoverageNotice({ coverage }: { coverage: Coverage }) {
  const partial = Object.entries(coverage).filter(([, c]) => !c.complete);
  if (partial.length === 0) return null;
  return (
    <div className="alert alert-warn" role="status">
      <Info size={18} aria-hidden="true" style={{ flex: "none", marginTop: 2 }} />
      <div>
        <p style={{ fontWeight: 600 }}>Partial data for a very busy repository</p>
        <p>
          The first sync stopped at the server's safety cap, so {partial.map(([r, c]) => `${r.replace("_", " ")} only go back to ${date(c.coveredSince)}`).join("; ")}. Numbers
          before that date are missing. Try a shorter period or raise <code>MAX_PULL_REQUESTS_PER_SYNC</code>.
        </p>
      </div>
    </div>
  );
}

export function Methodology({ report, coverage }: { report: InsightReport; coverage: Coverage }) {
  const q = report.dataQuality;
  return (
    <section className="card" aria-labelledby="method-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="method-title">
            What these numbers mean
          </h2>
          <p className="card-sub">Every metric is computed from GitHub data synced to a local database. Events count when their own timestamp falls inside the period.</p>
        </div>
      </div>
      <div className="grid-2">
        <dl className="defs">
          <div>
            <dt>Review load and reciprocity</dt>
            <dd>
              Reviews a person submitted on other people's PRs (approve, request changes or comment), against reviews others submitted on theirs. “Carrying” means giving at least twice what
              they receive. This is the work that rarely shows up on a commit graph.
            </dd>
          </div>
          <div>
            <dt>Review bus factor</dt>
            <dd>The fewest reviewers who together did half of all reviews. A value of 1 means one absence stalls the queue.</dd>
          </div>
          <div>
            <dt>Time to first review</dt>
            <dd>
              From the moment a PR became ready for review (not when a draft was opened) to the first review by someone else. PRs still waiting are counted separately, not dropped.
            </dd>
          </div>
          <div>
            <dt>Merged without review</dt>
            <dd>Merged PRs with no peer review submitted before the merge. Some teams merge trusted changes directly; a high share is a risk signal, not a verdict.</dd>
          </div>
        </dl>
        <div {...factAttr("quality")}>
          <dl className="defs">
            <div>
              <dt>Excluded as noise</dt>
              <dd>
                {int(q.botPrsExcluded)} bot-authored PRs, {int(q.botReviewsExcluded)} bot reviews, {int(q.selfReviewsExcluded)} self-reviews and {int(q.issuesClosedByBots)} bot issue
                closures. Reviews people did on bot PRs still count as their review work.
              </dd>
            </div>
            {(q.prsWithTruncatedReviews > 0 || q.unlinkedCommitAuthors > 0) && (
              <div>
                <dt>Known gaps</dt>
                <dd>
                  {q.prsWithTruncatedReviews > 0 && `${q.prsWithTruncatedReviews} PRs had more reviews than were fetched. `}
                  {q.unlinkedCommitAuthors > 0 && `${q.unlinkedCommitAuthors} commit authors aren't linked to a GitHub account and appear by git name.`}
                </dd>
              </div>
            )}
            <div>
              <dt>Freshness</dt>
              <dd>
                Pull requests synced {ago(coverage.pull_requests.syncedAt)}, issues {ago(coverage.issues.syncedAt)}, commits {ago(coverage.commits.syncedAt)}. Repeat queries are
                answered from the database until the data is older than the sync TTL.
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
