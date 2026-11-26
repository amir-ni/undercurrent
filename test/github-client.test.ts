import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitHubClient } from "../src/github/client.ts";
import { silentLogger } from "../src/logger.ts";

/** Builds a fake fetch that replays the given responses in order and counts calls. */
function replay(...responses: Array<() => Response>) {
  let calls = 0;
  const fetchImpl = (async () => responses[Math.min(calls++, responses.length - 1)]!()) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitHub client", () => {
  it("keeps partial data when a nested node fails to resolve", async () => {
    const { fetchImpl } = replay(json({ data: { repository: { ok: true } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a User" }] }));
    const data = await createGitHubClient("t", silentLogger, fetchImpl).query<{ repository: { ok: boolean } }>("q", {});
    assert.equal(data.repository.ok, true);
  });

  it("maps errors without data to stable codes", async () => {
    const cases: Array<[() => Response, string]> = [
      [json({ data: null, errors: [{ type: "NOT_FOUND", message: "x" }] }), "REPO_NOT_FOUND"],
      [json({ errors: [{ type: "RATE_LIMITED", message: "x" }] }), "UPSTREAM_RATE_LIMITED"],
      [json({ message: "Bad credentials" }, 401), "UPSTREAM_AUTH"],
      [json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) }), "UPSTREAM_RATE_LIMITED"],
      [() => new Response("<html>oops</html>", { status: 200 }), "UPSTREAM_UNAVAILABLE"],
    ];
    for (const [response, code] of cases) {
      const { fetchImpl } = replay(response);
      await assert.rejects(createGitHubClient("t", silentLogger, fetchImpl).query("q", {}), { code });
    }
  });

  it("retries transient upstream failures and then succeeds", async () => {
    const { fetchImpl, calls } = replay(json({}, 502), json({ data: { ok: 1 } }));
    const data = await createGitHubClient("t", silentLogger, fetchImpl).query<{ ok: number }>("q", {});
    assert.equal(data.ok, 1);
    assert.equal(calls(), 2);
  });
});
