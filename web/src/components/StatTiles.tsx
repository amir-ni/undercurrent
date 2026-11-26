import type { ReactNode } from "react";
import type { InsightReport } from "../lib/api.ts";
import { factAttr } from "../lib/evidence.ts";
import { duration, durationText, int, pct } from "../lib/format.ts";
import { Tag } from "./common.tsx";

function Tile({ label, value, unit, sub, flag, facts }: { label: string; value: string; unit?: string; sub?: ReactNode; flag?: ReactNode; facts: string[] }) {
  return (
    <div className="tile" {...factAttr(...facts)}>
      <span className="tile-label">{label}</span>
      <span className="tile-value num">
        {value}
        {unit && <span className="tile-unit">{unit}</span>}
      </span>
      {sub && <span className="tile-sub">{sub}</span>}
      {flag && <span className="tile-flag">{flag}</span>}
    </div>
  );
}

export function StatTiles({ report }: { report: InsightReport }) {
  const { totals, flow, reviewLoad } = report;
  const ttfr = duration(flow.timeToFirstReview.p50Hours);
  const cycle = duration(flow.cycleTime.p50Hours);
  const rate = flow.unreviewedMerges.rate;

  return (
    <section aria-label="Key numbers" className="grid-tiles">
      <Tile
        label="PRs merged"
        value={int(totals.prsMerged)}
        sub={`${int(totals.prsOpened)} opened · ${int(totals.prsClosedUnmerged)} closed unmerged`}
        facts={["totals.prs_merged", "totals.prs_opened", "totals.prs_closed_unmerged"]}
      />
      <Tile
        label="First review, median"
        value={ttfr.value}
        unit={ttfr.unit}
        sub={flow.timeToFirstReview.sample ? `p90 ${durationText(flow.timeToFirstReview.p90Hours)} · ${flow.timeToFirstReview.sample} PRs` : "No reviewed PRs yet"}
        flag={flow.timeToFirstReview.awaiting > 0 ? <Tag tone="warn">{flow.timeToFirstReview.awaiting} still waiting</Tag> : undefined}
        facts={["flow.ttfr"]}
      />
      <Tile
        label="Ready → merge, median"
        value={cycle.value}
        unit={cycle.unit}
        sub={flow.cycleTime.sample ? `p90 ${durationText(flow.cycleTime.p90Hours)}` : "Nothing merged"}
        facts={["flow.cycle"]}
      />
      <Tile
        label="Merged without review"
        value={pct(rate)}
        sub={`${int(flow.unreviewedMerges.unreviewed)} of ${int(flow.unreviewedMerges.merged)} merges`}
        flag={rate === null ? undefined : rate >= 0.3 ? <Tag tone="bad">High</Tag> : rate >= 0.1 ? <Tag tone="warn">Watch</Tag> : <Tag tone="good">Healthy</Tag>}
        facts={["flow.unreviewed_merges"]}
      />
      <Tile
        label="Review bus factor"
        value={reviewLoad.busFactor50 === null ? "—" : String(reviewLoad.busFactor50)}
        unit={reviewLoad.busFactor50 === 1 ? "person" : reviewLoad.busFactor50 ? "people" : undefined}
        sub={reviewLoad.top1Share === null ? "No reviews" : `Top reviewer does ${pct(reviewLoad.top1Share)}`}
        flag={reviewLoad.busFactor50 === 1 ? <Tag tone="bad">Single point of failure</Tag> : undefined}
        facts={["load.bus_factor_50", "load.top1_share"]}
      />
      <Tile
        label="Issues closed"
        value={int(totals.issuesClosed)}
        sub={`${int(totals.issuesOpened)} opened`}
        facts={["totals.issues_closed", "totals.issues_opened"]}
      />
    </section>
  );
}
