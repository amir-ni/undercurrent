/** Small, dependency-free statistics. Inputs are never mutated. */

/** Percentile with linear interpolation between closest ranks (Hyndman & Fan type 7, same as Excel/NumPy default). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export const median = (values: readonly number[]) => percentile(values, 0.5);

/**
 * Gini coefficient of a distribution of non-negative counts: 0 = perfectly even, → 1 = one person does everything.
 * Uses the sorted-rank formula, O(n log n).
 */
export function gini(values: readonly number[]): number | null {
  const n = values.length;
  const total = values.reduce((sum, v) => sum + v, 0);
  if (n === 0 || total === 0) return null;
  if (n === 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let weighted = 0;
  sorted.forEach((v, i) => (weighted += (i + 1) * v));
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/** Smallest number of people whose combined counts reach `share` of the total ("review bus factor"). */
export function busFactor(values: readonly number[], share = 0.5): number | null {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total === 0) return null;
  const sorted = [...values].sort((a, b) => b - a);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i]!;
    if (running >= total * share) return i + 1;
  }
  return sorted.length;
}

/** Share of the total contributed by the top `k` values. */
export function topShare(values: readonly number[], k: number): number | null {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total === 0) return null;
  const top = [...values].sort((a, b) => b - a).slice(0, k);
  return top.reduce((sum, v) => sum + v, 0) / total;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Round to a fixed number of decimals, keeping null. Used at the edge so internal math stays exact. */
export function round(value: number | null, decimals = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
