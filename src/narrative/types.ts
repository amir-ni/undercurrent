import type { InsightReport } from "../insights/report.ts";
import type { Fact } from "./facts.ts";
import type { GroundedNarrative } from "./grounding.ts";

/** Narrative contracts, kept free of runtime imports so the web client can share them. */

export type LlmResult = {
  output: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
};

/**
 * "anthropic" is the real analyst. "demo" is a deterministic rule engine for running without an
 * API key: same contract and same grounding, always labeled as not-an-LLM in the API and UI.
 */
export type NarrativeProvider = "anthropic" | "demo";

/** The seam between the narrator and a model provider. Tests plug in a fake. */
export type NarrativeLlm = {
  provider: NarrativeProvider;
  model: string;
  effort: string;
  /** `facts` is the structured form of what `user` contains, for providers that don't read prose. */
  complete(request: { system: string; user: string; facts: Fact[] }): Promise<LlmResult>;
};

export type Narrative = GroundedNarrative & {
  repo: string;
  window: InsightReport["window"];
  meta: {
    provider: NarrativeProvider;
    model: string;
    promptVersion: string;
    cached: boolean;
    generatedAt: string;
    latencyMs: number;
    usage: LlmResult["usage"];
    factSheetHash: string;
  };
};
