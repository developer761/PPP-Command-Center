import type { SalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * The admin "Snapshot diagnostic" counts, computed on the server.
 *
 * These six numbers were the LAST reason the Materials hub shipped
 * snapshot.workOrders and snapshot.woLineItems to the browser. Everything
 * else the page renders comes from `openJobsSerialized`, which the server
 * already derives and passes as its own prop; the client's remaining reads
 * were `accounts` (lookups + supplier names) and `paintColors`.
 *
 * So a panel only admins can see, showing counts the server could compute in
 * a microsecond, was costing every user on every load the two largest arrays
 * in the payload. /dashboard/materials measured 4.5MB on 2026-10-16 — the
 * last page on the pattern fixed across the rest of the dashboard that day.
 * See lib/dashboard/overview-data.ts for the measurements.
 *
 * `skippedWorkTypes` is an ARRAY of pairs, already sorted desc: Maps do not
 * survive RSC serialization, and the panel sorts and slices it anyway.
 */
export type SnapshotDiagnostic = {
  woCount: number;
  openWoCount: number;
  materialsRelevantWoCount: number;
  woliCount: number;
  woliMatchedToWo: number;
  paintColorCount: number;
  /** [work type, count], descending. Capped — the panel shows six. */
  skippedWorkTypes: Array<[string, number]>;
};

export function deriveSnapshotDiagnostic(
  snapshot: SalesforceSnapshot
): SnapshotDiagnostic {
  const woIds = new Set(snapshot.workOrders.map((w) => w.id));
  let openWoCount = 0;
  let materialsRelevantWoCount = 0;
  const skipped = new Map<string, number>();

  for (const w of snapshot.workOrders) {
    const s = (w.status ?? "").toLowerCase();
    const isOpen =
      !s.includes("paid in full") &&
      !s.includes("complete") &&
      !s.includes("cancel") &&
      !s.includes("closed");
    if (!isOpen) continue;
    openWoCount++;
    const wt = (w.workTypeName ?? "").toLowerCase();
    const isPreQuote =
      wt.includes("estimate") ||
      wt.includes("appointment") ||
      wt.includes("inspection") ||
      wt.includes("consultation");
    if (isPreQuote) {
      const key = w.workTypeName ?? "(no work type)";
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
    } else {
      materialsRelevantWoCount++;
    }
  }

  return {
    woCount: snapshot.workOrders.length,
    openWoCount,
    materialsRelevantWoCount,
    woliCount: snapshot.woLineItems.length,
    woliMatchedToWo: snapshot.woLineItems.filter((l) => woIds.has(l.workOrderId)).length,
    paintColorCount: snapshot.paintColors.length,
    skippedWorkTypes: Array.from(skipped.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  };
}
