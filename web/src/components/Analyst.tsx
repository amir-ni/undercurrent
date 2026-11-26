import { AlertTriangle, CheckCircle2, Circle, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiError, Narrative } from "../lib/api.ts";
import { focusFact } from "../lib/evidence.ts";
import { factValue, pct } from "../lib/format.ts";
import { ErrorPanel, Tag } from "./common.tsx";

export type NarrativeState =
  | { status: "loading" }
  | { status: "error"; error: ApiError }
  | { status: "ready"; narrative: Narrative };

const KIND_TONE = { risk: "bad", anomaly: "warn", trend: "info", strength: "good" } as const;
const KIND_LABEL = { risk: "Risk", anomaly: "Anomaly", trend: "Trend", strength: "Strength" } as const;

export function Analyst({ state, onRetry }: { state: NarrativeState; onRetry: () => void }) {
  return (
    <section className="analyst" aria-labelledby="analyst-title" aria-busy={state.status === "loading"}>
      {state.status === "loading" && <Thinking />}
      {state.status === "error" && <AnalystError error={state.error} onRetry={onRetry} />}
      {state.status === "ready" && <AnalystReady narrative={state.narrative} />}
    </section>
  );
}

function Kicker({ demo = false }: { demo?: boolean }) {
  return (
    <span className="kicker" id="analyst-title">
      <Sparkles size={15} aria-hidden="true" /> {demo ? "Demo analyst · rule-based, not an LLM" : "AI analyst"}
    </span>
  );
}

const STEPS = ["Condensing the metrics into a fact sheet", "Reasoning over the evidence for root causes", "Verifying every citation and figure"];

function Thinking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);
  const active = elapsed < 2 ? 0 : elapsed < 25 ? 1 : 2;
  return (
    <div className="analyst-hero thinking">
      <Kicker />
      <p className="analyst-headline">Reading the numbers…</p>
      <ol className="thinking-steps">
        {STEPS.map((step, i) => (
          <li key={step} data-state={i < active ? "done" : i === active ? "active" : "todo"}>
            {i < active ? <CheckCircle2 size={16} aria-hidden="true" /> : i === active ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
            {step}
          </li>
        ))}
      </ol>
      <span className="glass-chip num" aria-live="off">
        {elapsed}s · deep analysis usually takes 20–60 s
      </span>
    </div>
  );
}

function AnalystError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  if (error.code === "LLM_NOT_CONFIGURED") {
    return (
      <div className="analyst-hero">
        <Kicker />
        <p className="analyst-headline">The AI analyst is switched off on this server.</p>
        <p className="analyst-narrative">
          Set <code style={{ background: "rgba(255,255,255,.15)", color: "#fff" }}>ANTHROPIC_API_KEY</code> and restart to get a written analysis with root-cause hypotheses,
          confidence scores and an evidence chain back to the numbers below. Everything else works without it.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="analyst-hero">
        <Kicker />
        <p className="analyst-headline">The analysis couldn't be generated this time.</p>
      </div>
      <div style={{ padding: 20 }}>
        <ErrorPanel error={error} onRetry={onRetry} compact />
      </div>
    </>
  );
}

function AnalystReady({ narrative }: { narrative: Narrative }) {
  const g = narrative.grounding;
  const demo = narrative.meta.provider === "demo";
  return (
    <>
      <div className="analyst-hero">
        <Kicker demo={demo} />
        <h2 className="analyst-headline">{narrative.headline}</h2>
        <p className="analyst-narrative">{narrative.narrative}</p>
        <div className="analyst-meta">
          <span className="glass-chip">
            <ShieldCheck size={14} aria-hidden="true" /> {g.citations} citations verified
            {g.invalidCitations.length > 0 && ` · ${g.invalidCitations.length} rejected`}
          </span>
          <span className="glass-chip">{demo ? "Demo mode: set ANTHROPIC_API_KEY for Claude" : narrative.meta.model}</span>
          {!demo && <span className="glass-chip num">{narrative.meta.cached ? "Cached" : `${(narrative.meta.latencyMs / 1000).toFixed(1)} s`}</span>}
          {narrative.insufficientData && <span className="glass-chip">Thin data: read with care</span>}
        </div>
      </div>

      {narrative.findings.length > 0 && (
        <ol className="findings" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Findings">
          {narrative.findings.map((f, i) => (
            <li className="finding" key={`${i}-${f.title}`}>
              <div className="finding-top">
                <Tag tone={KIND_TONE[f.kind]}>{KIND_LABEL[f.kind]}</Tag>
                <h3 className="finding-title">{f.title}</h3>
                <Confidence value={f.confidence} note={f.confidenceNote} model={f.modelConfidence} />
              </div>
              <div className="finding-body">
                <p className="finding-text">{f.observation}</p>
                {f.hypothesis && (
                  <p className="finding-text hypothesis">
                    <span className="finding-label">Likely cause</span>
                    {f.hypothesis}
                  </p>
                )}
                <p className="finding-text" style={{ fontSize: 13.5 }}>
                  <span className="finding-label">Reasoning</span>
                  {f.reasoning}
                </p>
              </div>
              <div className="evidence" aria-label="Evidence">
                <span className="finding-label" style={{ margin: 0 }}>
                  Evidence
                </span>
                {f.evidence.map((e) => (
                  <button key={e.id} type="button" className="evidence-chip" onClick={() => focusFact(e.id)} title={`${e.id} · jump to this number`}>
                    {e.label} <b>{factValue(e.value, e.unit)}</b>
                  </button>
                ))}
              </div>
              {f.unverifiedFigures.length > 0 && (
                <p className="unverified">
                  <AlertTriangle size={14} aria-hidden="true" /> Figures not found in the data: {f.unverifiedFigures.join(", ")}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="analyst-footer">
        {narrative.caveats.length > 0 && (
          <div>
            <strong style={{ color: "var(--ink)" }}>Caveats</strong>
            <ul>
              {narrative.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        <p style={{ marginLeft: "auto", alignSelf: "end" }}>
          {demo
            ? "Demo findings come from fixed rules over the same fact sheet the LLM receives, and pass through the same citation and figure checks."
            : "Hypotheses are generated by an LLM from aggregate numbers only; every claim links to the number it rests on."}
          {g.unverifiedFigures > 0 && ` ${g.unverifiedFigures} figure(s) could not be matched to the data and are flagged.`}
        </p>
      </div>
    </>
  );
}

function Confidence({ value, model, note }: { value: number; model: number; note: string | null }) {
  const tone = value >= 0.7 ? "var(--good)" : value >= 0.45 ? "var(--blue-lt)" : "var(--warn)";
  const label = value >= 0.7 ? "High" : value >= 0.45 ? "Moderate" : "Low";
  return (
    <span className="confidence" title={note ?? `Model confidence ${pct(model)}`}>
      <span className="confidence-track" aria-hidden="true">
        <svg width="72" height="6">
          <rect width={72 * value} height="6" rx="3" fill={tone} />
        </svg>
      </span>
      <span className="num">
        {label} confidence · {pct(value)}
      </span>
    </span>
  );
}
