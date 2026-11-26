import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { busFactor, gini, percentile, round, topShare } from "../src/insights/stats.ts";

describe("stats", () => {
  it("percentile interpolates between ranks and handles edge cases", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([7], 0.9), 7);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([10, 1, 5], 0.5), 5); // order-independent
    assert.equal(round(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)), 9.1);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    percentile(input, 0.5);
    gini(input);
    busFactor(input);
    assert.deepEqual(input, [3, 1, 2]);
  });

  it("gini is 0 for an even split and approaches 1 when one person does everything", () => {
    assert.equal(gini([5, 5, 5, 5]), 0);
    assert.equal(gini([]), null);
    assert.equal(gini([0, 0]), null);
    assert.ok(gini([100, 0, 0, 0])! >= 0.74);
  });

  it("bus factor counts the fewest people covering half the work", () => {
    assert.equal(busFactor([42, 4, 1, 1]), 1);
    assert.equal(busFactor([10, 10, 10, 10]), 2);
    assert.equal(busFactor([]), null);
  });

  it("topShare", () => {
    assert.equal(topShare([6, 3, 1], 1), 0.6);
    assert.equal(topShare([6, 3, 1], 5), 1);
    assert.equal(topShare([0], 1), null);
  });
});
