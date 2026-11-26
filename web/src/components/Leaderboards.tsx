import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { InsightReport } from "../lib/api.ts";
import { contributorKey, factAttr, factSegment, registerRevealer } from "../lib/evidence.ts";
import { int } from "../lib/format.ts";
import { Avatar, Tag } from "./common.tsx";

type Kind = "contributors" | "reviewers" | "closers";
const TABS: Array<{ id: Kind; label: string; help: string }> = [
  { id: "contributors", label: "Contributors", help: "Ranked by PRs merged, then non-merge commits on the default branch, then lines changed." },
  { id: "reviewers", label: "Reviewers", help: "Ranked by peer reviews submitted on other people's PRs." },
  { id: "closers", label: "Issue closers", help: "Ranked by issues closed by a human. Bot closures are excluded." },
];
const FACT_PREFIX: Record<string, Kind> = { contributor: "contributors", closer: "closers" };

export function Leaderboards({ report }: { report: InsightReport }) {
  const [tab, setTab] = useState<Kind>("contributors");

  // Evidence chips that point at a contributor or closer switch to the right tab first.
  useEffect(
    () =>
      registerRevealer((factId) => {
        const target = FACT_PREFIX[factId.split(".")[0]!];
        if (!target || target === tab) return false;
        setTab(target);
        return true;
      }),
    [tab],
  );

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : -1;
    if (next >= 0) {
      setTab(TABS[next]!.id);
      document.getElementById(`tab-${TABS[next]!.id}`)?.focus();
    }
  };

  const active = TABS.find((t) => t.id === tab)!;
  const lb = report.leaderboards;

  return (
    <section className="card" aria-labelledby="lb-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="lb-title">
            Leaderboards
          </h2>
          <p className="card-sub">{active.help}</p>
        </div>
        <div className="tabs" role="tablist" aria-label="Leaderboard">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              aria-controls="lb-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onKey}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div id="lb-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="table-wrap">
        {tab === "contributors" && (
          <Table
            empty="No merged PRs or commits in this period."
            head={["PRs merged", "Commits", "Lines changed", "PRs opened"]}
            rows={lb.contributors.map((c) => ({
              key: `${c.linked}:${c.login}`,
              fact: `contributor.${contributorKey(c.login, c.linked)}`,
              login: c.login,
              linked: c.linked,
              badge: c.linked ? undefined : <Tag tone="neutral" title="Commit email isn't linked to a GitHub account">git author</Tag>,
              cells: [c.prsMerged, c.commits, c.linesChanged, c.prsOpened],
            }))}
          />
        )}
        {tab === "reviewers" && (
          <Table
            empty="No peer reviews in this period."
            head={["Reviews", "PRs reviewed", "Approvals", "Changes req.", "Comments"]}
            rows={lb.reviewers.map((r) => ({ key: r.login, fact: `reviewer.${factSegment(r.login)}`, login: r.login, linked: true, cells: [r.reviews, r.prsReviewed, r.approvals, r.changesRequested, r.comments] }))}
          />
        )}
        {tab === "closers" && (
          <Table
            empty="No issues closed by people in this period."
            head={["Closed", "Completed", "Not planned"]}
            rows={lb.closers.map((c) => ({ key: c.login, fact: `closer.${factSegment(c.login)}`, login: c.login, linked: true, cells: [c.closed, c.completed, c.notPlanned] }))}
          />
        )}
      </div>
    </section>
  );
}

type Row = { key: string; fact: string; login: string; linked: boolean; badge?: ReactNode; cells: number[] };

function Table({ head, rows, empty }: { head: string[]; rows: Row[]; empty: string }) {
  if (rows.length === 0) return <p className="card-sub" style={{ padding: 16 }}>{empty}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col" className="rank">#</th>
          <th scope="col">Person</th>
          {head.map((h) => (
            <th scope="col" className="n" key={h}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.key} {...factAttr(r.fact)}>
            <td className="rank">{i + 1}</td>
            <td>
              <span className="person">
                <Avatar login={r.login} linked={r.linked} />
                <span className="person-name">{r.login}</span>
                {r.badge}
              </span>
            </td>
            {r.cells.map((v, j) => (
              <td className="n" key={j}>
                {int(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
