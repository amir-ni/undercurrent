import { repoKey, type RepoRef, type Window } from "../domain.ts";
import { AppError } from "../http/errors.ts";
import type { ActivityStore } from "../store/activity-store.ts";
import type { SyncService, SyncSummary } from "../sync/sync-service.ts";
import { buildReport, type InsightReport } from "./report.ts";

export type ReportResult = { report: InsightReport; sync: SyncSummary; timings: { syncMs: number; computeMs: number } };

/** Application service: policy (allowlist) → freshness (sync) → read model (store) → pure compute. */
export class InsightService {
  private readonly sync: SyncService;
  private readonly store: ActivityStore;
  private readonly allowlist: Set<string>;

  constructor(sync: SyncService, store: ActivityStore, allowlist: string[]) {
    this.sync = sync;
    this.store = store;
    this.allowlist = new Set(allowlist);
  }

  async report(repo: RepoRef, window: Window, listLimit?: number): Promise<ReportResult> {
    if (this.allowlist.size > 0 && !this.allowlist.has(repoKey(repo))) {
      throw new AppError("REPO_NOT_ALLOWED", "This server is configured to analyze a fixed set of repositories, and this is not one of them.");
    }
    const t0 = performance.now();
    const sync = await this.sync.ensureFresh(repo, window.since);
    const t1 = performance.now();
    const activity = this.store.loadActivity(repo, window.since);
    const report = buildReport(activity, window, listLimit === undefined ? {} : { listLimit });
    return { report, sync, timings: { syncMs: t1 - t0, computeMs: performance.now() - t1 } };
  }
}
