import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InsightReport } from "../lib/api.ts";
import { factAttr } from "../lib/evidence.ts";
import { dayLabel, durationText, int } from "../lib/format.ts";

type Week = InsightReport["weekly"][number];

/** Two single-measure charts side by side: never one chart with two y-axes. */
export function WeeklyCharts({ report }: { report: InsightReport }) {
  const weeks = report.weekly;
  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="throughput-title">
        <div className="card-head">
          <div>
            <h2 className="card-title" id="throughput-title">
              Merged pull requests per week
            </h2>
            <p className="card-sub">Hatched columns are partial weeks cut by the period.</p>
          </div>
        </div>
        <ColumnChart weeks={weeks} />
      </section>
      <section className="card" aria-labelledby="ttfr-title">
        <div className="card-head">
          <div>
            <h2 className="card-title" id="ttfr-title">
              Median time to first review
            </h2>
            <p className="card-sub">By the week a PR became ready for review. Gaps mean no reviewed PRs that week.</p>
          </div>
        </div>
        <LineChart weeks={weeks} />
      </section>
    </div>
  );
}

const H = 220;
const PAD = { top: 18, right: 12, bottom: 28, left: 36 };

/** niceMax returns 4 or 2, 5, 10 × 10^k: pick a tick count that gives whole-number steps. */
const tickCount = (niceValue: number) => (niceValue % 4 === 0 ? 4 : 5);

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/**
 * Tracks the container width so the SVG is drawn at real pixel size: labels stay legible on
 * phones instead of shrinking with a scaled viewBox. Also owns the hover/focus tooltip.
 */
function useChart() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const show = (x: number, y: number, content: ReactNode) => setTip({ x, y, content });
  const node = tip && (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  );
  return { ref, W: width, show, hide: () => setTip(null), node };
}

/** Label every week when there is room, otherwise roughly one label per 70px. */
const labelEvery = (count: number, W: number) => Math.max(1, Math.ceil(count / Math.max(2, Math.floor((W - PAD.left) / 70))));

function Axis({ W, max, ticks, format }: { W: number; max: number; ticks: number; format: (v: number) => string }) {
  const innerH = H - PAD.top - PAD.bottom;
  return (
    <g>
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const v = (max / ticks) * i;
        const y = PAD.top + innerH - (v / max) * innerH;
        return (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="axis-label">
              {format(v)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ColumnChart({ weeks }: { weeks: Week[] }) {
  const tt = useChart();
  const W = tt.W;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...weeks.map((w) => w.prsMerged), 1));
  const band = innerW / weeks.length;
  const barW = Math.min(24, band * 0.6);
  const peak = weeks.reduce((best, w) => (w.prsMerged > best.prsMerged ? w : best), weeks[0]!);

  return (
    <div className="chart-wrap" ref={tt.ref}>
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Merged PRs per week. Peak ${peak.prsMerged} in the week of ${dayLabel(peak.weekStart)}.`}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--series-given)" opacity="0.35" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-given)" strokeWidth="3" />
          </pattern>
        </defs>
        <Axis W={W} max={max} ticks={tickCount(max)} format={(v) => int(v)} />
        {weeks.map((w, i) => {
          const h = (w.prsMerged / max) * innerH;
          const x = PAD.left + band * i + (band - barW) / 2;
          const y = PAD.top + innerH - h;
          const r = Math.min(4, h);
          const label = `${w.partial ? "Partial week" : "Week"} of ${dayLabel(w.weekStart)}: ${w.prsMerged} merged, ${w.reviews} reviews by ${w.activeReviewers} reviewers`;
          return (
            <g
              key={w.weekStart}
              className="chart-hit"
              tabIndex={0}
              aria-label={label}
              {...factAttr(`week.${w.weekStart}`)}
              onMouseEnter={() => tt.show(x + barW / 2, y, tooltipBody(w))}
              onFocus={() => tt.show(x + barW / 2, y, tooltipBody(w))}
              onMouseLeave={tt.hide}
              onBlur={tt.hide}
            >
              <rect className="hit-bg" x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" />
              {h > 0 && (
                <path d={roundedTop(x, y, barW, h, r)} fill={w.partial ? "url(#hatch)" : "var(--series-given)"} />
              )}
              {(w === peak || i === weeks.length - 1) && w.prsMerged > 0 && (
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" className="value-label">
                  {w.prsMerged}
                </text>
              )}
              {i % labelEvery(weeks.length, W) === 0 && (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="axis-label">
                  {dayLabel(w.weekStart)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tt.node}
    </div>
  );
}

/** Column with a 4px rounded data end and a square baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function LineChart({ weeks }: { weeks: Week[] }) {
  const tt = useChart();
  const W = tt.W;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const values = weeks.map((w) => w.medianTtfrHours);
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) {
    return <p className="card-sub">No PR received a first review in this period.</p>;
  }
  // Choose the axis unit first (hours up to three days, else days), then a nice maximum in that unit.
  const peak = Math.max(...present);
  const inDays = peak > 72;
  const niceInUnit = niceMax(inDays ? peak / 24 : peak);
  const max = inDays ? niceInUnit * 24 : niceInUnit;
  const band = innerW / weeks.length;
  const xAt = (i: number) => PAD.left + band * i + band / 2;
  const yAt = (v: number) => PAD.top + innerH - (v / max) * innerH;

  // Break the line at weeks without data instead of interpolating through them.
  const segments: string[] = [];
  let current = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${xAt(i)},${yAt(v)} `;
  });
  if (current) segments.push(current);
  const lastIndex = values.reduce<number>((last, v, i) => (v !== null ? i : last), -1);

  return (
    <div className="chart-wrap" ref={tt.ref}>
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Median hours to first review, per week">
        <Axis W={W} max={max} ticks={tickCount(niceInUnit)} format={hourTick(inDays)} />
        {segments.map((d) => (
          <path key={d} d={d} fill="none" stroke="var(--series-given)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {weeks.map((w, i) => {
          const v = w.medianTtfrHours;
          return (
            <g
              key={w.weekStart}
              className="chart-hit"
              tabIndex={0}
              aria-label={`Week of ${dayLabel(w.weekStart)}: ${v === null ? "no reviewed PRs" : `median ${durationText(v)} across ${w.ttfrSample} PRs`}`}
              onMouseEnter={() => tt.show(xAt(i), v === null ? PAD.top + innerH : yAt(v), tooltipBody(w))}
              onFocus={() => tt.show(xAt(i), v === null ? PAD.top + innerH : yAt(v), tooltipBody(w))}
              onMouseLeave={tt.hide}
              onBlur={tt.hide}
            >
              <rect className="hit-bg" x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" />
              {v !== null && <circle cx={xAt(i)} cy={yAt(v)} r={4.5} fill="var(--series-given)" stroke="var(--surface)" strokeWidth={2} />}
              {i === lastIndex && v !== null && (
                <text x={xAt(i)} y={yAt(v) - 10} textAnchor="middle" className="value-label">
                  {durationText(v)}
                </text>
              )}
              {i % labelEvery(weeks.length, W) === 0 && (
                <text x={xAt(i)} y={H - 8} textAnchor="middle" className="axis-label">
                  {dayLabel(w.weekStart)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tt.node}
    </div>
  );
}

/** One unit per axis: hours up to three days, days beyond. */
function hourTick(inDays: boolean) {
  return (v: number) => (v === 0 ? "0" : inDays ? `${Number((v / 24).toFixed(1))}d` : `${Number(v.toFixed(1))}h`);
}

function tooltipBody(w: Week) {
  return (
    <>
      <div style={{ opacity: 0.75 }}>
        {w.partial ? "Partial week" : "Week"} of {dayLabel(w.weekStart)}
      </div>
      <div>
        <b>{w.prsMerged}</b> merged · <b>{w.prsOpened}</b> opened
      </div>
      <div>
        <b>{w.reviews}</b> reviews by <b>{w.activeReviewers}</b> reviewers
      </div>
      <div>First review median: <b>{w.medianTtfrHours === null ? "—" : durationText(w.medianTtfrHours)}</b></div>
    </>
  );
}
