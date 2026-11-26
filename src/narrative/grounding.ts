import type { Fact } from "./facts.ts";
import type { NarrativeOutput } from "./prompt.ts";

/**
 * Server-side guardrails applied to every model answer. The model is asked to cite and calibrate;
 * this module checks that it did, instead of trusting it:
 *  1. Citation check  — evidence ids must exist in the fact sheet; findings left with none are dropped.
 *  2. Figure check    — numbers written in the prose must be derivable from the facts (as-is, as a
 *                       percentage, or hours→days); others are surfaced as unverified, never hidden.
 *  3. Confidence cap  — confidence is capped by the smallest sample size behind the cited statistics.
 */

export type GroundedEvidence = Pick<Fact, "id" | "label" | "value" | "unit">;

export type GroundedFinding = {
  title: string;
  kind: NarrativeOutput["findings"][number]["kind"];
  observation: string;
  hypothesis: string | null;
  reasoning: string;
  confidence: number;
  modelConfidence: number;
  confidenceNote: string | null;
  evidence: GroundedEvidence[];
  unverifiedFigures: string[];
};

export type Grounding = {
  factsProvided: number;
  citations: number;
  invalidCitations: string[];
  droppedFindings: number;
  unverifiedFigures: number;
};

export type GroundedNarrative = {
  headline: string;
  narrative: string;
  narrativeUnverifiedFigures: string[];
  findings: GroundedFinding[];
  caveats: string[];
  insufficientData: boolean;
  grounding: Grounding;
};

const MAX_CONFIDENCE = 0.9;

export function groundNarrative(output: NarrativeOutput, facts: Fact[]): GroundedNarrative {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const allNumbers = facts.flatMap(numericCandidates);
  const invalid: string[] = [];
  let dropped = 0;
  let citations = 0;
  let unverifiedTotal = 0;

  const findings: GroundedFinding[] = [];
  for (const finding of output.findings) {
    const cited: Fact[] = [];
    for (const id of new Set(finding.evidence)) {
      const fact = byId.get(id);
      if (fact) cited.push(fact);
      else invalid.push(id);
    }
    if (cited.length === 0) {
      dropped++;
      continue;
    }
    citations += cited.length;

    const prose = [finding.observation, finding.hypothesis ?? "", finding.reasoning].join(" ");
    const unverifiedFigures = unverified(prose, allNumbers);
    unverifiedTotal += unverifiedFigures.length;

    const modelConfidence = clamp01(finding.confidence);
    const { cap, note } = confidenceCap(cited);
    const confidence = Math.min(modelConfidence, cap);

    findings.push({
      title: finding.title,
      kind: finding.kind,
      observation: finding.observation,
      hypothesis: finding.hypothesis,
      reasoning: finding.reasoning,
      confidence: Math.round(confidence * 100) / 100,
      modelConfidence: Math.round(modelConfidence * 100) / 100,
      confidenceNote: confidence < modelConfidence ? note : null,
      evidence: cited.map(({ id, label, value, unit }) => ({ id, label, value, unit })),
      unverifiedFigures,
    });
  }

  const narrativeUnverifiedFigures = unverified(`${output.headline} ${output.narrative}`, allNumbers);
  unverifiedTotal += narrativeUnverifiedFigures.length;

  return {
    headline: output.headline,
    narrative: output.narrative,
    narrativeUnverifiedFigures,
    findings,
    caveats: output.caveats.slice(0, 3),
    insufficientData: output.insufficient_data,
    grounding: { factsProvided: facts.length, citations, invalidCitations: invalid, droppedFindings: dropped, unverifiedFigures: unverifiedTotal },
  };
}

/** Caps confidence by the weakest sample among cited statistics. */
export function confidenceCap(cited: Fact[]): { cap: number; note: string | null } {
  const samples = cited.map((f) => f.sample).filter((s): s is number => s !== undefined);
  const smallest = samples.length ? Math.min(...samples) : null;
  if (smallest !== null && smallest < 10) return { cap: 0.4, note: `Capped: based on a sample of ${smallest}.` };
  if (smallest !== null && smallest < 30) return { cap: 0.7, note: `Capped: based on a sample of ${smallest}.` };
  return { cap: MAX_CONFIDENCE, note: `Capped at ${MAX_CONFIDENCE}: aggregates alone cannot confirm a cause.` };
}

/** Every way a fact's value may legitimately appear in prose. */
function numericCandidates(fact: Fact): number[] {
  if (typeof fact.value !== "number") return [];
  const v = fact.value;
  const out = [v];
  if (fact.unit === "ratio") out.push(v * 100);
  if (fact.unit === "hours") out.push(v / 24, v * 60);
  return out;
}

/** Numbers like "42", "3.5", "61%", "1,204". PR references ("#123") and ISO dates are not figures. */
const NUMBER = /(?<![#\w.-])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\w-]|\.\d)/g;
const DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;

export function extractFigures(text: string): number[] {
  const withoutDates = text.replace(DATE, " ");
  return [...withoutDates.matchAll(NUMBER)].map((m) => Number(m[1]!.replace(/,/g, "")));
}

function unverified(text: string, candidates: number[]): string[] {
  const misses = new Set<string>();
  for (const figure of extractFigures(text)) {
    // Small integers are usually counts in words ("two of three reviewers") or list positions; skip noise.
    if (Number.isInteger(figure) && figure <= 3) continue;
    if (!candidates.some((c) => Math.abs(figure - c) <= Math.max(0.051, Math.abs(c) * 0.02) + roundingSlack(figure))) {
      misses.add(String(figure));
    }
  }
  return [...misses];
}

/** A figure written with fewer decimals than the fact (e.g. "36%" for 0.357) is still the same number. */
function roundingSlack(figure: number): number {
  const decimals = (String(figure).split(".")[1] ?? "").length;
  return 0.5 * 10 ** -decimals;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
