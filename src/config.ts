import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  GITHUB_TOKEN: z
    .string({ error: "is required. Create a read-only token for public repositories and put it in .env (see .env.example)." })
    .min(1, "is empty. Create a read-only token for public repositories and put it in .env (see .env.example)."),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["anthropic", "demo"]).optional()), // compose passes unset as ""
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/undercurrent.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LLM_MODEL: z.string().default("claude-opus-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  SYNC_TTL_SECONDS: z.coerce.number().int().min(0).default(900),
  MAX_WINDOW_DAYS: z.coerce.number().int().min(1).max(730).default(180),
  MAX_PULL_REQUESTS_PER_SYNC: z.coerce.number().int().min(50).default(1000),
  REPO_ALLOWLIST: csv.transform((items) => items.map((item) => item.toLowerCase())),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  NARRATIVE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(6),
  CORS_ORIGINS: csv,
});

export type Config = {
  githubToken: string;
  anthropicApiKey: string | undefined;
  port: number;
  host: string;
  databasePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** "anthropic" when a key is set, "demo" only when asked for explicitly, otherwise null (narratives off). */
  llm: { provider: "anthropic" | "demo" | null; model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  syncTtlMs: number;
  maxWindowDays: number;
  maxPullRequestsPerSync: number;
  repoAllowlist: string[];
  rateLimitPerMinute: number;
  narrativeRateLimitPerMinute: number;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  const e = parsed.data;
  if (e.LLM_PROVIDER === "anthropic" && !e.ANTHROPIC_API_KEY) {
    throw new Error("Invalid configuration:\n  - LLM_PROVIDER: is \"anthropic\" but ANTHROPIC_API_KEY is not set.");
  }
  return {
    githubToken: e.GITHUB_TOKEN,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH,
    logLevel: e.LOG_LEVEL,
    llm: { provider: e.LLM_PROVIDER ?? (e.ANTHROPIC_API_KEY ? "anthropic" : null), model: e.LLM_MODEL, effort: e.LLM_EFFORT },
    syncTtlMs: e.SYNC_TTL_SECONDS * 1000,
    maxWindowDays: e.MAX_WINDOW_DAYS,
    maxPullRequestsPerSync: e.MAX_PULL_REQUESTS_PER_SYNC,
    repoAllowlist: e.REPO_ALLOWLIST,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    narrativeRateLimitPerMinute: e.NARRATIVE_RATE_LIMIT_PER_MINUTE,
    corsOrigins: e.CORS_ORIGINS,
  };
}
