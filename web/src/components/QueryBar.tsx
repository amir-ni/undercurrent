import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { parseRepoInput, type Query } from "../lib/api.ts";

const PERIODS = [7, 30, 90] as const;
const SUGGESTIONS = ["honojs/hono", "vitejs/vite", "pnpm/pnpm", "fastapi/fastapi"];

type Props = { initial: Query | null; busy: boolean; onSubmit: (q: Query) => void };

export function QueryBar({ initial, busy, onSubmit }: Props) {
  const [repo, setRepo] = useState(initial ? `${initial.owner}/${initial.name}` : "");
  const [days, setDays] = useState<number>(initial?.days ?? 30);
  const [error, setError] = useState<string | null>(null);

  const submit = (value: string, period = days) => {
    const parsed = parseRepoInput(value);
    if (!parsed) {
      setError("Enter a public repository as owner/name, for example honojs/hono.");
      document.getElementById("repo-input")?.focus();
      return;
    }
    setError(null);
    onSubmit({ ...parsed, days: period });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(repo);
  };

  return (
    <form className="query-card" onSubmit={handleSubmit} noValidate aria-label="Analyze a repository">
      <div className="query-row">
        <div className="field">
          <label className="field-label" htmlFor="repo-input">
            GitHub repository
          </label>
          <input
            id="repo-input"
            className="input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onBlur={() => repo && !parseRepoInput(repo) && setError("That doesn't look like owner/name.")}
            placeholder="owner/name or a github.com link"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "repo-error" : undefined}
          />
        </div>
        <div className="field">
          <span className="field-label" id="period-label">
            Period
          </span>
          <div className="segmented" role="group" aria-labelledby="period-label">
            {PERIODS.map((p) => (
              <button key={p} type="button" aria-pressed={days === p} onClick={() => setDays(p)}>
                {p}d
              </button>
            ))}
          </div>
        </div>
        <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 size={18} className="spin" aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}
          {busy ? "Analyzing…" : "Analyze"}
        </button>
      </div>
      {error && (
        <p className="field-error" id="repo-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" /> {error}
        </p>
      )}
      <div className="suggestions">
        <span>Try</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="chip"
            onClick={() => {
              setRepo(s);
              submit(s);
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </form>
  );
}
