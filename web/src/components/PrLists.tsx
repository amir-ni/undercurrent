import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { InsightReport } from "../lib/api.ts";
import { safeGitHubUrl } from "../lib/api.ts";
import { factAttr } from "../lib/evidence.ts";
import { durationText, int } from "../lib/format.ts";

type PrRef = InsightReport["notable"]["awaitingReview"][number];

export function PrLists({ report }: { report: InsightReport }) {
  const { notable, flow } = report;
  return (
    <div className="grid-2">
      <PrCard
        id="waiting"
        title="Waiting longest for a first review"
        sub="Ready for review during the period, still open, no peer review yet."
        items={notable.awaitingReview}
        metric={(p) => durationText(p.hours)}
        metricLabel="waiting"
        empty="Nothing is waiting. Every PR that became ready got a first review."
      />
      <PrCard
        id="slowest"
        title="Slowest to a first review"
        sub="PRs from the period that did get reviewed, by how long the first review took."
        items={notable.slowestFirstReview}
        metric={(p) => durationText(p.hours)}
        metricLabel="to first review"
        empty="No reviewed PRs in this period."
        extra={
          <p className="meta-row" {...factAttr("flow.pr_size")} style={{ marginTop: 12 }}>
            <span>
              Merged PR size: median <b className="num">{int(flow.prSize.p50Lines)}</b> lines · p90 <b className="num">{int(flow.prSize.p90Lines)}</b> lines
            </span>
          </p>
        }
      />
    </div>
  );
}

function PrCard(props: {
  id: string;
  title: string;
  sub: string;
  items: PrRef[];
  metric: (p: PrRef) => string;
  metricLabel: string;
  empty: string;
  extra?: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={`${props.id}-title`}>
      <div className="card-head">
        <div>
          <h2 className="card-title" id={`${props.id}-title`}>
            {props.title}
          </h2>
          <p className="card-sub">{props.sub}</p>
        </div>
      </div>
      {props.items.length === 0 ? (
        <p className="card-sub">{props.empty}</p>
      ) : (
        <ul className="pr-list">
          {props.items.map((p) => {
            const href = safeGitHubUrl(p.url);
            return (
              <li className="pr-item" key={p.number} {...factAttr(`pr.${p.number}`)}>
                <div style={{ minWidth: 0 }}>
                  {href ? (
                    <a className="pr-title" href={href} target="_blank" rel="noopener noreferrer" title={p.title}>
                      {p.title} <ExternalLink size={12} aria-label="(opens GitHub)" />
                    </a>
                  ) : (
                    <span className="pr-title">{p.title}</span>
                  )}
                  <span className="pr-meta">
                    #{p.number} · {p.author ?? "deleted account"}
                  </span>
                </div>
                <div className="pr-hours">
                  {props.metric(p)}
                  <div className="pr-meta" style={{ fontWeight: 400 }}>
                    {props.metricLabel}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {props.extra}
    </section>
  );
}
