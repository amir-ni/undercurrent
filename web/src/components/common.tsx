import { AlertTriangle, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ApiError } from "../lib/api.ts";

export function Avatar({ login, linked = true }: { login: string; linked?: boolean }) {
  const [failed, setFailed] = useState(false);
  const initials = login.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <span className="avatar" aria-hidden="true">
      {linked && !failed ? (
        <img src={`https://github.com/${encodeURIComponent(login)}.png?size=56`} alt="" loading="lazy" width={28} height={28} onError={() => setFailed(true)} />
      ) : (
        initials
      )}
    </span>
  );
}

type Tone = "good" | "warn" | "bad" | "neutral" | "info";
export function Tag({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {children}
    </span>
  );
}

const ROLE: Record<string, { tone: Tone; label: string; help: string }> = {
  carrying: { tone: "info", label: "Carrying", help: "Gives at least twice the reviews they receive" },
  receiving: { tone: "warn", label: "Mostly receiving", help: "Receives at least twice the reviews they give" },
  balanced: { tone: "good", label: "Balanced", help: "Gives and receives in similar measure" },
  light: { tone: "neutral", label: "Light", help: "Fewer than 3 reviews given or received" },
};
export function RoleTag({ role }: { role: string }) {
  const r = ROLE[role] ?? ROLE.light!;
  return (
    <Tag tone={r.tone} title={r.help}>
      {r.label}
    </Tag>
  );
}

export function Skeleton({ height, width = "100%" }: { height: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

const FRIENDLY: Record<string, string> = {
  REPO_NOT_FOUND: "We couldn't find that repository. Check the spelling, and note that only public repositories can be analyzed.",
  REPO_NOT_ALLOWED: "This server only analyzes an allowlisted set of repositories.",
  UPSTREAM_RATE_LIMITED: "The server's GitHub token has hit its hourly rate limit.",
  RATE_LIMITED: "You're sending requests quickly. Give it a moment.",
  NETWORK: "The server can't be reached. Is it running?",
};

/** Error panel: plain-language cause, the server's detail, a retry, and the request id for support. */
export function ErrorPanel({ error, onRetry, compact }: { error: ApiError; onRetry?: () => void; compact?: boolean }) {
  const friendly = FRIENDLY[error.code];
  return (
    <div className={`alert alert-bad`} role="alert">
      <AlertTriangle size={18} aria-hidden="true" style={{ flex: "none", marginTop: 2 }} />
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <p style={{ fontWeight: 600 }}>{friendly ?? error.message}</p>
        {friendly && !compact && <p>{error.message}</p>}
        {error.retryAfter && <p>Try again in about {error.retryAfter < 120 ? `${error.retryAfter} s` : `${Math.ceil(error.retryAfter / 60)} min`}.</p>}
        <p style={{ fontSize: 12.5, opacity: 0.85 }}>
          Code <code>{error.code}</code>
          {error.requestId && (
            <>
              {" "}· Request <code>{error.requestId}</code>
            </>
          )}
        </p>
        {onRetry && (
          <div>
            <button type="button" className="btn-neutral" onClick={onRetry}>
              <RotateCw size={15} aria-hidden="true" /> Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
