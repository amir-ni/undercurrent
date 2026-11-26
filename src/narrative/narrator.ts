import { createHash } from "node:crypto";
import type { RepoRef } from "../domain.ts";
import { AppError } from "../http/errors.ts";
import type { InsightReport } from "../insights/report.ts";
import type { Logger } from "../logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { ActivityStore } from "../store/activity-store.ts";
import { buildFactSheet } from "./facts.ts";
import { groundNarrative } from "./grounding.ts";
import { buildUserMessage, NarrativeOutputSchema, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.ts";
import type { Narrative, NarrativeLlm } from "./types.ts";

export type { Narrative, NarrativeLlm } from "./types.ts";

/**
 * Turns a report into a grounded narrative:
 *   report → fact sheet → cache lookup → LLM (structured) → schema check → grounding → cache.
 * The cache key covers prompt version, model, effort and the exact facts, so a hit is always
 * an answer to the same question; concurrent identical requests share one LLM call.
 */
export class Narrator {
  private readonly inflight = new Map<string, Promise<Narrative>>();
  private readonly llm: NarrativeLlm | null;
  private readonly store: ActivityStore;
  private readonly logger: Logger;

  constructor(llm: NarrativeLlm | null, store: ActivityStore, logger: Logger) {
    this.llm = llm;
    this.store = store;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.llm !== null;
  }

  get provider(): NarrativeLlm["provider"] | null {
    return this.llm?.provider ?? null;
  }

  async narrate(repo: RepoRef, report: InsightReport): Promise<Narrative> {
    const llm = this.llm;
    if (!llm) throw new AppError("LLM_NOT_CONFIGURED", "Narratives need ANTHROPIC_API_KEY to be set on the server.");

    const sheet = buildFactSheet(report);
    const user = buildUserMessage(report.repo, report.window, sheet);
    const factSheetHash = sha256(JSON.stringify(sheet));
    const cacheKey = sha256([PROMPT_VERSION, llm.provider, llm.model, llm.effort, factSheetHash].join("|"));

    const cached = this.store.getNarrative(cacheKey);
    if (cached) {
      metrics.narratives.inc({ outcome: "cache_hit" });
      const narrative = JSON.parse(cached) as Narrative;
      return { ...narrative, meta: { ...narrative.meta, cached: true } };
    }

    const running = this.inflight.get(cacheKey);
    if (running) return running;

    const run = (async (): Promise<Narrative> => {
      const started = Date.now();
      let result;
      try {
        result = await llm.complete({ system: SYSTEM_PROMPT, user, facts: sheet.facts });
      } catch (error) {
        metrics.narratives.inc({ outcome: "error" });
        throw error;
      } finally {
        metrics.llmDuration.observe((Date.now() - started) / 1000);
      }
      metrics.llmTokens.inc({ type: "input" }, result.usage.inputTokens);
      metrics.llmTokens.inc({ type: "output" }, result.usage.outputTokens);
      metrics.llmTokens.inc({ type: "cache_read" }, result.usage.cacheReadTokens);
      const parsed = NarrativeOutputSchema.safeParse(result.output);
      if (!parsed.success) {
        metrics.narratives.inc({ outcome: "error" });
        this.logger.warn("narrative failed schema validation", { issues: parsed.error.issues.slice(0, 5) });
        throw new AppError("LLM_UNAVAILABLE", "The model returned an analysis in an unexpected shape. Try again.");
      }
      const grounded = groundNarrative(parsed.data, sheet.facts);
      metrics.narratives.inc({ outcome: "generated" });
      metrics.groundingInvalidCitations.inc({}, grounded.grounding.invalidCitations.length);
      metrics.groundingUnverifiedFigures.inc({}, grounded.grounding.unverifiedFigures);
      const narrative: Narrative = {
        repo: report.repo,
        window: report.window,
        ...grounded,
        meta: {
          provider: llm.provider,
          model: result.model,
          promptVersion: PROMPT_VERSION,
          cached: false,
          generatedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
          usage: result.usage,
          factSheetHash,
        },
      };
      this.logger.info("narrative generated", {
        repo: report.repo,
        model: result.model,
        latencyMs: narrative.meta.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        findings: grounded.findings.length,
        invalidCitations: grounded.grounding.invalidCitations.length,
        unverifiedFigures: grounded.grounding.unverifiedFigures,
      });
      this.store.putNarrative(cacheKey, repo, JSON.stringify(narrative));
      return narrative;
    })().finally(() => this.inflight.delete(cacheKey));

    this.inflight.set(cacheKey, run);
    return run;
  }
}

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
