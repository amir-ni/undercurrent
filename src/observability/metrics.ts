/**
 * A tiny Prometheus registry (text exposition format 0.0.4). Hand-rolled to stay dependency-free;
 * swapping in prom-client or OpenTelemetry later only touches this file.
 *
 * Label values are always low-cardinality (route templates, outcomes, resources) — never repository
 * names, logins or raw paths, which would explode series counts and leak usage data.
 */

type Labels = Record<string, string>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
const fmtLabels = (labels: Labels) => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",")}}`;
};

interface Metric {
  render(): string;
}

class Counter implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  private readonly name: string;
  private readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    const entry = this.values.get(k) ?? { labels, value: 0 };
    entry.value += by;
    this.values.set(k, entry);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${fmtLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Gauge implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  private readonly name: string;
  private readonly help: string;
  private readonly collect: (() => number) | undefined;
  constructor(name: string, help: string, collect?: () => number) {
    this.name = name;
    this.help = help;
    this.collect = collect;
  }
  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), { labels, value });
  }
  render(): string {
    if (this.collect) this.set(this.collect());
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${fmtLabels(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram implements Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  private readonly name: string;
  private readonly help: string;
  private readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]!++;
    });
    s.sum += value;
    s.count++;
    this.series.set(k, s);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${fmtLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${fmtLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

const LATENCY_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const started = Date.now();

export const metrics = {
  httpRequests: new Counter("http_requests_total", "HTTP requests by route template and status."),
  httpDuration: new Histogram("http_request_duration_seconds", "HTTP request latency by route template.", LATENCY_BUCKETS),
  githubRequests: new Counter("github_requests_total", "GitHub GraphQL calls by outcome (ok, retry, error)."),
  githubDuration: new Histogram("github_request_duration_seconds", "GitHub GraphQL call latency.", LATENCY_BUCKETS),
  githubRateLimitRemaining: new Gauge("github_rate_limit_remaining", "GraphQL rate-limit points left for the configured token."),
  syncRuns: new Counter("sync_runs_total", "Repository syncs by resource and mode (fresh, incremental, backfill)."),
  syncItems: new Counter("sync_items_fetched_total", "Items fetched from GitHub by resource."),
  syncDuration: new Histogram("sync_duration_seconds", "Time spent syncing one resource.", LATENCY_BUCKETS),
  narratives: new Counter("narratives_total", "Narrative requests by outcome (generated, cache_hit, error)."),
  llmDuration: new Histogram("llm_request_duration_seconds", "LLM call latency.", LATENCY_BUCKETS),
  llmTokens: new Counter("llm_tokens_total", "LLM tokens by direction (input, output, cache_read)."),
  groundingInvalidCitations: new Counter("narrative_invalid_citations_total", "Evidence ids cited by the model that did not exist in the fact sheet."),
  groundingUnverifiedFigures: new Counter("narrative_unverified_figures_total", "Figures in model prose that could not be matched to any fact."),
  uptime: new Gauge("process_uptime_seconds", "Seconds since the process started.", () => (Date.now() - started) / 1000),
  memory: new Gauge("process_resident_memory_bytes", "Resident set size.", () => process.memoryUsage().rss),
};

export function renderMetrics(): string {
  return Object.values(metrics as Record<string, Metric>)
    .map((m) => m.render())
    .join("\n\n")
    .concat("\n");
}

/** Collapses concrete paths into route templates so labels stay low-cardinality. */
const KNOWN_ROUTES = new Set(["/v1", "/v1/repos/:owner/:repo/insights", "/v1/repos/:owner/:repo/leaderboards/:kind", "/v1/repos/:owner/:repo/narrative"]);

export function routeTemplate(path: string): string {
  if (!path.startsWith("/v1")) return ["/healthz", "/readyz", "/metrics"].includes(path) ? path : "static";
  const template = path
    .replace(/\/+$/, "")
    .replace(/^\/v1\/repos\/[^/]+\/[^/]+/, "/v1/repos/:owner/:repo")
    .replace(/\/leaderboards\/[^/]+$/, "/leaderboards/:kind");
  return KNOWN_ROUTES.has(template) ? template : "/v1/unknown";
}
