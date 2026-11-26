import type { Fact } from "./facts.ts";
import type { NarrativeOutput } from "./prompt.ts";
import type { LlmResult, NarrativeLlm } from "./types.ts";

/**
 * Demo analyst: a deterministic rule engine behind the same `NarrativeLlm` seam as Claude.
 *
 * It exists so the service can be run and demoed end to end without an API key. It is not an
 * LLM and never claims to be one: the provider is "demo" in the API, the UI labels it, and its
 * caveats say so. Its output goes through exactly the same schema validation and grounding
 * (citation, figure and confidence checks) as a real model's, which also makes it a handy
 * fixture for the grounding layer.
 */
export function createDemoLlm(): NarrativeLlm {
  return {
    provider: "demo",
    model: "demo-rules-v1",
    effort: "n/a",
    async complete({ facts }): Promise<LlmResult> {
      return { output: analyze(facts), model: "demo-rules-v1", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    },
  };
}

type Finding = NarrativeOutput["findings"][number] & { score: number; headline: string };

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const hours = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} hours`);

export function analyze(facts: Fact[]): NarrativeOutput {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const n = (id: string): number | null => {
    const v = byId.get(id)?.value;
    return typeof v === "number" ? v : null;
  };
  const people = facts
    .map((f) => /^person\.([^.]+)\.reviews_given$/.exec(f.id)?.[1])
    .filter((login): login is string => login !== undefined)
    .map((login) => ({
      login,
      given: n(`person.${login}.reviews_given`) ?? 0,
      received: n(`person.${login}.reviews_received`) ?? 0,
      merged: n(`person.${login}.prs_merged`) ?? 0,
    }));

  const reviews = n("totals.reviews") ?? 0;
  const merged = n("totals.prs_merged") ?? 0;
  const days = n("window.days") ?? 0;
  const share = n("load.top1_share");
  const busFactor = n("load.bus_factor_50");
  const rate = n("flow.unreviewed_merges.rate");
  const p50 = n("flow.ttfr.p50_hours");
  const p90 = n("flow.ttfr.p90_hours");
  const sample = n("flow.ttfr.sample") ?? 0;
  const awaiting = n("flow.ttfr.awaiting") ?? 0;
  const oldest = n("flow.ttfr.awaiting_oldest_hours");

  if (merged < 5 && reviews < 5) {
    return {
      headline: "Too little activity in this period to draw conclusions",
      narrative: `There were ${merged} merged PRs and ${reviews} peer reviews in ${days} days, which is not enough to separate patterns from noise.`,
      findings: [
        {
          title: "Not enough activity to judge",
          kind: "trend",
          observation: `${merged} merged PRs and ${reviews} peer reviews in ${days} days.`,
          hypothesis: null,
          reasoning: "With this little activity any concentration or latency figure would mostly reflect chance.",
          confidence: 0.9,
          evidence: ["totals.prs_merged", "totals.reviews", "window.days"],
        },
      ],
      caveats: [DEMO_CAVEAT],
      insufficient_data: true,
    };
  }

  const findings: Finding[] = [];
  const top = [...people].sort((a, b) => b.given - a.given)[0];

  if (share !== null && share >= 0.5 && reviews >= 5 && top) {
    findings.push({
      score: 3 + share,
      headline: `${top.login} does ${pct(share)} of all code review`,
      title: "Review load sits on one person",
      kind: "risk",
      observation: `${top.login} gave ${top.given} of ${reviews} peer reviews (${pct(share)}), and the review bus factor is ${busFactor}.`,
      hypothesis: `${top.login} acts as the review gate, so their availability sets the pace for everyone else.`,
      reasoning: "The top-reviewer share and the bus factor point the same way. This would be wrong if other maintainers review in tools GitHub cannot see.",
      confidence: Math.min(0.9, 0.5 + 0.8 * (share - 0.5)),
      evidence: ["load.top1_share", "load.bus_factor_50", `person.${top.login}.reviews_given`, "totals.reviews"],
    });
  }

  const unreviewed = n("flow.unreviewed_merges.count");
  if (rate !== null && unreviewed !== null && rate >= 0.25 && merged >= 5) {
    const selfMerger = [...people].filter((p) => p.merged >= 3 && p.received < p.merged / 2).sort((a, b) => b.merged - a.merged)[0];
    findings.push({
      score: 2 + rate,
      headline: `${pct(rate)} of merged PRs had no peer review`,
      title: "Many merges skip peer review",
      kind: "anomaly",
      observation: `${unreviewed} of ${merged} merged PRs (${pct(rate)}) had no peer review before the merge.`,
      hypothesis: selfMerger
        ? `Changes by ${selfMerger.login} (${selfMerger.merged} merged, ${selfMerger.received} reviews received) are usually merged without a second reviewer.`
        : null,
      reasoning: selfMerger
        ? "A prolific author who receives few reviews accounts for much of the unreviewed share; trusted-maintainer fast paths would explain it."
        : "No single author explains the gap, so the cause is unclear from aggregates alone.",
      confidence: selfMerger ? 0.65 : 0.45,
      evidence: selfMerger
        ? ["flow.unreviewed_merges.rate", "flow.unreviewed_merges.count", `person.${selfMerger.login}.prs_merged`, `person.${selfMerger.login}.reviews_received`]
        : ["flow.unreviewed_merges.rate", "flow.unreviewed_merges.count"],
    });
  }

  if (oldest !== null && (awaiting >= 3 || oldest >= 168)) {
    const bottleneck = share !== null && share >= 0.5;
    findings.push({
      score: 1.5 + Math.min(1, oldest / 720),
      headline: `${awaiting} pull requests are still waiting for a first review`,
      title: "Pull requests are waiting on reviewers",
      kind: "risk",
      observation: `${awaiting} PRs that became ready are still waiting for a first review; the oldest has waited ${hours(oldest)}.`,
      hypothesis: bottleneck ? "With one person doing most reviews, the queue grows whenever that person is busy." : null,
      reasoning: bottleneck
        ? "A growing queue alongside concentrated review load is the classic single-reviewer bottleneck."
        : "Waiting PRs without concentrated review load may simply be low-priority contributions.",
      confidence: bottleneck ? 0.55 : 0.4,
      evidence: bottleneck ? ["flow.ttfr.awaiting", "flow.ttfr.awaiting_oldest_hours", "load.top1_share"] : ["flow.ttfr.awaiting", "flow.ttfr.awaiting_oldest_hours"],
    });
  }

  if (p50 !== null && p90 !== null && sample >= 5 && p90 >= 24 && p90 >= 4 * Math.max(p50, 1)) {
    findings.push({
      score: 1.2,
      headline: "Most PRs get reviewed quickly, but some wait far longer",
      title: "A long tail of slow first reviews",
      kind: "trend",
      observation: `Half of PRs get a first review within ${hours(p50)}, but the slowest 10% wait ${hours(p90)} or more.`,
      hypothesis: null,
      reasoning: "A large gap between the median and the 90th percentile suggests some PRs fall through the cracks rather than a uniformly slow team.",
      confidence: 0.5,
      evidence: ["flow.ttfr.p50_hours", "flow.ttfr.p90_hours", "flow.ttfr.sample"],
    });
  }

  const weeks = facts
    .map((f) => /^week\.(\d{4}-\d{2}-\d{2})\.active_reviewers$/.exec(f.id))
    .filter((m): m is RegExpExecArray => m !== null && !byId.get(m[0])!.label.includes("partial"))
    .map((m) => ({ week: m[1]!, reviewers: n(m[0]) ?? 0, ttfr: n(`week.${m[1]}.median_ttfr_hours`) }));
  if (weeks.length >= 3 && p50 !== null) {
    const busiest = [...weeks].sort((a, b) => b.reviewers - a.reviewers)[0]!;
    const quietest = [...weeks].sort((a, b) => a.reviewers - b.reviewers)[0]!;
    if (quietest.ttfr !== null && quietest.reviewers <= busiest.reviewers / 2 && quietest.ttfr >= 1.5 * p50) {
      findings.push({
        score: 1.4,
        headline: "Reviews slowed down in the week fewer people reviewed",
        title: "Fewer reviewers, slower reviews",
        kind: "trend",
        observation: `PRs that became ready in the week of ${quietest.week}, when ${quietest.reviewers} people were reviewing (against ${busiest.reviewers} in the week of ${busiest.week}), waited a median ${hours(quietest.ttfr)} for a first review.`,
        hypothesis: "Reviewer availability, more than PR volume, drives review latency here.",
        reasoning: "Latency rose in the week with the fewest active reviewers. One week is a small sample, so treat this as a lead to check.",
        confidence: 0.45,
        evidence: [`week.${quietest.week}.active_reviewers`, `week.${busiest.week}.active_reviewers`, `week.${quietest.week}.median_ttfr_hours`, "flow.ttfr.p50_hours"],
      });
    }
  }

  if (busFactor !== null && busFactor >= 3 && rate !== null && rate < 0.15 && merged >= 5 && reviews >= 10) {
    findings.push({
      score: 1,
      headline: "Review work is spread across the team",
      title: "Review work is well shared",
      kind: "strength",
      observation: `Half of all reviews come from ${busFactor} people, and only ${pct(rate)} of merges skipped review.`,
      hypothesis: null,
      reasoning: "A bus factor of three or more with few unreviewed merges means no single absence stalls the queue.",
      confidence: 0.6,
      evidence: ["load.bus_factor_50", "flow.unreviewed_merges.rate"],
    });
  }

  const ranked = findings.sort((a, b) => b.score - a.score).slice(0, 4);
  if (ranked.length === 0) {
    return {
      headline: "No unusual patterns in this period",
      narrative: `${merged} PRs were merged with ${reviews} peer reviews in ${days} days, and none of the review-load or latency signals crossed their thresholds.`,
      findings: [
        {
          title: "Nothing stands out",
          kind: "strength",
          observation: `${merged} merged PRs and ${reviews} peer reviews, with no concentration or latency signal above threshold.`,
          hypothesis: null,
          reasoning: "The rules look for concentrated review load, unreviewed merges, waiting PRs and slow tails; none fired.",
          confidence: 0.6,
          evidence: ["totals.prs_merged", "totals.reviews"],
        },
      ],
      caveats: [DEMO_CAVEAT],
      insufficient_data: false,
    };
  }

  return {
    headline: ranked[0]!.headline,
    narrative: ranked
      .slice(0, 3)
      .map((f) => f.observation)
      .join(" "),
    findings: ranked.map(({ score: _score, headline: _headline, ...finding }) => finding),
    caveats: [DEMO_CAVEAT, "Review that happens outside GitHub (pairing, other tools) is invisible here and would make merges look unreviewed."],
    insufficient_data: false,
  };
}

const DEMO_CAVEAT = "Demo analyst: these findings come from fixed rules over the fact sheet, not from a language model. Set ANTHROPIC_API_KEY to use Claude.";
