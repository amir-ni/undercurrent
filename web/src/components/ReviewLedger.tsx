import { Table2, BarChart3 } from "lucide-react";
import { useEffect, useState } from "react";
import type { InsightReport } from "../lib/api.ts";
import { factAttr, factSegment, registerRevealer } from "../lib/evidence.ts";
import { int, num, pct } from "../lib/format.ts";
import { Avatar, RoleTag } from "./common.tsx";

const COLLAPSED_ROWS = 8;
const MAX_ROWS = 40;

/**
 * The flagship view: a diverging bar per person. Right = reviews given to others,
 * left = reviews received on their own PRs. Long right bars with short left bars are the
 * people quietly carrying the team's review load.
 */
export function ReviewLedger({ report }: { report: InsightReport }) {
  const [asTable, setAsTable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load = report.reviewLoad;
  const everyone = load.people.filter((p) => p.reviewsGiven + p.reviewsReceived > 0).slice(0, MAX_ROWS);
  const people = expanded ? everyone : everyone.slice(0, COLLAPSED_ROWS);

  // An evidence chip for someone below the fold of the collapsed list expands it first.
  useEffect(
    () =>
      registerRevealer((factId) => {
        const [kind, login] = factId.split(".");
        if (kind !== "person" || expanded) return false;
        const hidden = everyone.slice(COLLAPSED_ROWS).some((p) => factSegment(p.login) === login);
        if (hidden) setExpanded(true);
        return hidden;
      }),
    [everyone, expanded],
  );
  const max = Math.max(1, ...people.map((p) => Math.max(p.reviewsGiven, p.reviewsReceived)));

  return (
    <section className="card" aria-labelledby="ledger-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="ledger-title">
            Who carries the review load
          </h2>
          <p className="card-sub">Reviews each person gave to others, against reviews they received on their own pull requests.</p>
        </div>
        <button type="button" className="btn-neutral" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? <BarChart3 size={15} aria-hidden="true" /> : <Table2 size={15} aria-hidden="true" />}
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>

      <div className="meta-row" style={{ marginBottom: 16 }}>
        <span {...factAttr("totals.reviews", "load.reviewers")}>
          <b className="num">{int(load.totalReviews)}</b> reviews by <b className="num">{int(load.reviewers)}</b> reviewers
        </span>
        <span {...factAttr("load.top3_share")}>
          Top 3 do <b className="num">{pct(load.top3Share)}</b>
        </span>
        <span {...factAttr("load.gini")} title="0 = perfectly even, 1 = one person does everything">
          Concentration (Gini) <b className="num">{num(load.gini)}</b>
        </span>
      </div>

      {people.length === 0 ? (
        <p className="card-sub">No peer reviews in this period.</p>
      ) : asTable ? (
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Review load per person</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col" className="n">Given</th>
                <th scope="col" className="n">Received</th>
                <th scope="col" className="n">Ratio</th>
                <th scope="col" className="n">Approvals</th>
                <th scope="col" className="n">Changes req.</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.login} {...factAttr(`person.${factSegment(p.login)}`)}>
                  <th scope="row" style={{ background: "none", textTransform: "none", letterSpacing: 0, fontSize: 14, color: "var(--ink)", fontWeight: 500 }}>
                    {p.login}
                  </th>
                  <td className="n">{p.reviewsGiven}</td>
                  <td className="n">{p.reviewsReceived}</td>
                  <td className="n">{p.reciprocity === null ? "—" : `${num(p.reciprocity)}×`}</td>
                  <td className="n">{p.approvals}</td>
                  <td className="n">{p.changesRequested}</td>
                  <td>
                    <RoleTag role={p.role} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="legend" style={{ marginBottom: 12 }}>
            <span className="legend-item">
              <span className="swatch" style={{ background: "var(--series-received)" }} /> Received on own PRs
            </span>
            <span className="legend-item">
              <span className="swatch" style={{ background: "var(--series-given)" }} /> Given to others
            </span>
          </div>
          <div className="ledger-axis" aria-hidden="true">
            <span />
            <span className="ledger-axis-split">
              <span>← Received</span>
              <span>Given →</span>
            </span>
          </div>
          <ul className="ledger" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {people.map((p) => (
              <li
                key={p.login}
                className="ledger-row"
                {...factAttr(`person.${factSegment(p.login)}`)}
                aria-label={`${p.login}: gave ${p.reviewsGiven} reviews, received ${p.reviewsReceived}`}
              >
                <div className="person">
                  <Avatar login={p.login} />
                  <div style={{ minWidth: 0 }}>
                    <div className="person-name">{p.login}</div>
                    <div className="person-role">
                      <RoleTag role={p.role} />
                    </div>
                  </div>
                </div>
                <Diverging given={p.reviewsGiven} received={p.reviewsReceived} max={max} />
              </li>
            ))}
          </ul>
        </>
      )}
      {everyone.length > COLLAPSED_ROWS && (
        <button type="button" className="btn-neutral" style={{ marginTop: 12 }} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Show fewer" : `Show all ${everyone.length} people`}
        </button>
      )}
    </section>
  );
}

function Diverging({ given, received, max }: { given: number; received: number; max: number }) {
  // Leave room inside each half for the value label.
  const scale = (n: number) => `${(n / max) * 82}%`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr", alignItems: "center", height: 28 }} aria-hidden="true">
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
        {received > 0 && <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{received}</span>}
        <span style={{ height: 14, width: scale(received), background: "var(--series-received)", borderRadius: "4px 0 0 4px", marginRight: 2 }} />
      </div>
      <div style={{ background: "var(--line)", height: 28 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ height: 14, width: scale(given), background: "var(--series-given)", borderRadius: "0 4px 4px 0", marginLeft: 2 }} />
        {given > 0 && <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{given}</span>}
      </div>
    </div>
  );
}
