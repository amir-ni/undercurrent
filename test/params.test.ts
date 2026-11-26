import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLimit, parseRepo, parseWindow } from "../src/http/params.ts";

const NOW = Date.UTC(2026, 10, 26, 17, 42, 10);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("parseWindow", () => {
  it("defaults to 30 days ending at the current hour", () => {
    const w = parseWindow({}, 180, NOW);
    assert.equal(w.until, Date.UTC(2026, 10, 26, 17));
    assert.equal(w.until - w.since, 30 * DAY);
  });

  it("accepts dates, timestamps with offsets, and days", () => {
    assert.equal(parseWindow({ since: "2026-11-01" }, 180, NOW).since, Date.UTC(2026, 10, 1));
    assert.equal(parseWindow({ since: "2026-11-01T02:00:00+02:00" }, 180, NOW).since, Date.UTC(2026, 10, 1));
    const w = parseWindow({ days: "7" }, 180, NOW);
    assert.equal(w.until - w.since, 7 * DAY);
  });

  it("clamps a future `until` to now", () => {
    assert.equal(parseWindow({ since: "2026-11-01", until: "2027-01-01" }, 180, NOW).until, NOW);
  });

  it("rejects malformed, inverted, ambiguous and oversized windows", () => {
    for (const query of [
      { since: "yesterday" },
      { since: "2026-11-01T00:00:00" }, // no timezone
      { since: "2026-11-20", until: "2026-11-10" },
      { since: "2026-11-01", days: "5" },
      { days: "0" },
      { days: "181" },
    ]) {
      assert.throws(() => parseWindow(query, 180, NOW), { code: "BAD_REQUEST" }, JSON.stringify(query));
    }
  });
});

describe("parseRepo", () => {
  it("accepts GitHub names and rejects anything else", () => {
    assert.deepEqual(parseRepo("vercel", "next.js"), { owner: "vercel", name: "next.js" });
    for (const [owner, name] of [["-bad", "x"], ["a".repeat(40), "x"], ["ok", ".."], ["ok", "a/b"], ["ok", "x y"], ["o%2e", "x"]]) {
      assert.throws(() => parseRepo(owner!, name!), { code: "BAD_REQUEST" });
    }
  });
});

describe("parseLimit", () => {
  it("bounds the limit", () => {
    assert.equal(parseLimit(undefined, 10, 100), 10);
    assert.equal(parseLimit("25", 10, 100), 25);
    assert.throws(() => parseLimit("101", 10, 100));
    assert.throws(() => parseLimit("2.5", 10, 100));
  });
});

describe("loadConfig", () => {
  it("treats empty optional values as unset and rejects contradictory LLM settings", async () => {
    const { loadConfig } = await import("../src/config.ts");
    assert.equal(loadConfig({ GITHUB_TOKEN: "t", LLM_PROVIDER: "", ANTHROPIC_API_KEY: "" }).llm.provider, null);
    assert.equal(loadConfig({ GITHUB_TOKEN: "t", LLM_PROVIDER: "demo" }).llm.provider, "demo");
    assert.equal(loadConfig({ GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k" }).llm.provider, "anthropic");
    assert.throws(() => loadConfig({ GITHUB_TOKEN: "t", LLM_PROVIDER: "anthropic" }), /ANTHROPIC_API_KEY/);
    assert.throws(() => loadConfig({}), /GITHUB_TOKEN/);
  });
});
