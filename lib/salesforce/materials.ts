import type {
  SalesforceSnapshot,
  SnapshotPaintColor,
  SnapshotWoli,
  SnapshotWorkOrder,
} from "@/lib/salesforce/queries";

/**
 * Phase 2 derivations — pure functions that turn the raw snapshot into the
 * shapes the Materials Ordering page renders. All driven off scoped snapshot,
 * so reps see only their own WOs / line items, admins see everything (unless
 * impersonating).
 */

/** A line item with its paint colors resolved to full objects (or null). */
export type ResolvedWoli = {
  raw: SnapshotWoli;
  wall: SnapshotPaintColor | null;
  ceiling: SnapshotPaintColor | null;
  trim: SnapshotPaintColor | null;
  other: SnapshotPaintColor | null;
  floor: SnapshotPaintColor | null;
};

/** A Work Order open for material ordering, grouped with its line items. */
export type OpenWorkOrderForMaterials = {
  wo: SnapshotWorkOrder;
  lineItems: ResolvedWoli[];
  /** Total sq footage across line items (walls). */
  totalSqFt: number;
  /** Distinct paint colors needed across all line items + surfaces. */
  distinctColorCount: number;
  /** Supplier (manufacturer Account Id → count of distinct colors needed). */
  bySupplier: Map<string | "unknown", number>;
};

/**
 * PPP statuses that indicate a WO is "done" — no materials needed. Anything
 * NOT in this set is treated as open / in-flight. Substring matching is
 * deliberate so subtle variants ("Paid in Full (Disputed)", "Complete - Hold")
 * still close. The previous implementation used the same approach but it's
 * worth being explicit about why: PPP keeps adding status variants and we'd
 * rather err on "show too much" than miss an active job.
 *
 * If PPP ever adds an open-status that includes the word "closed" (e.g.,
 * "Re-Opened from Closed"), bump that into a positive allowlist check above.
 */
const CLOSED_STATUS_TOKENS = [
  "paid in full",
  "complete",
  "cancel",     // matches "Cancelled" / "Canceled"
  "closed",
  "void",       // future: PPP may add "Voided"
  "abandoned",  // future
] as const;

export function isOpenForMaterials(status: string | null): boolean {
  if (!status) return true; // null status — be conservative, include
  const s = status.toLowerCase();
  for (const token of CLOSED_STATUS_TOKENS) {
    if (s.includes(token)) return false;
  }
  return true;
}

/**
 * PPP WorkTypes that don't need materials ordering — these are pre-quote
 * stages (estimator visiting the site, customer hasn't accepted yet). Only
 * the WorkTypes that represent an actual paint job get surfaced.
 *
 * Substring + case-insensitive match so "Initial Appointment" / "Free Estimate"
 * variants are caught. If PPP adds more pre-quote stages, add the token here.
 */
const SKIPPED_WORK_TYPE_TOKENS = [
  "estimate",
  "appointment",
  "inspection",  // future-proof: an inspection visit shouldn't need materials
  "consultation",
] as const;

export function workTypeRequiresMaterials(workTypeName: string | null): boolean {
  // Treat null/missing WorkType as "needs materials" — better to surface and
  // let the user check than silently hide a job. PPP can correct in SF.
  if (!workTypeName) return true;
  const t = workTypeName.toLowerCase();
  for (const token of SKIPPED_WORK_TYPE_TOKENS) {
    if (t.includes(token)) return false;
  }
  return true;
}

/**
 * Build a paint-color lookup so the page can resolve color Ids → full objects
 * cheaply (5k records but called many times per render).
 */
export function indexPaintColors(
  colors: readonly SnapshotPaintColor[]
): Map<string, SnapshotPaintColor> {
  const m = new Map<string, SnapshotPaintColor>();
  for (const c of colors) m.set(c.id, c);
  return m;
}

/** Resolve all color slots on a line item into full PaintColor objects. */
function resolveWoli(
  raw: SnapshotWoli,
  byId: Map<string, SnapshotPaintColor>
): ResolvedWoli {
  return {
    raw,
    wall: raw.colorWallId ? byId.get(raw.colorWallId) ?? null : null,
    ceiling: raw.colorCeilingId ? byId.get(raw.colorCeilingId) ?? null : null,
    trim: raw.colorTrimId ? byId.get(raw.colorTrimId) ?? null : null,
    other: raw.colorOtherId ? byId.get(raw.colorOtherId) ?? null : null,
    floor: raw.colorFloorId ? byId.get(raw.colorFloorId) ?? null : null,
  };
}

/**
 * Memoize the derive result on snapshot identity. The snapshot is treated
 * as immutable once built, so a WeakMap keyed by the snapshot reference
 * caches the result for the lifetime of that snapshot in memory. After a
 * cron refresh the snapshot identity changes and the next call recomputes.
 *
 * SPEED ROUND 10 (2026-06-13): saves ~50-150ms per materials-page render
 * on PPP's data (521 open WOs × ~700 visible WOLIs). Combined with the
 * cron change that warms BOTH snapshot variants, cold materials loads
 * drop from ~3-5s to ~300-800ms.
 */
const materialsDeriveCache = new WeakMap<
  SalesforceSnapshot,
  OpenWorkOrderForMaterials[]
>();

/**
 * Get the work orders that need materials, with their line items + resolved
 * paint colors. Sorted by closeDate ascending (soonest jobs first).
 */
export function deriveOpenMaterialsWorkOrders(
  snapshot: SalesforceSnapshot
): OpenWorkOrderForMaterials[] {
  const cached = materialsDeriveCache.get(snapshot);
  if (cached) return cached;
  const fresh = computeOpenMaterialsWorkOrders(snapshot);
  materialsDeriveCache.set(snapshot, fresh);
  return fresh;
}

function computeOpenMaterialsWorkOrders(
  snapshot: SalesforceSnapshot
): OpenWorkOrderForMaterials[] {
  const colorIndex = indexPaintColors(snapshot.paintColors);

  // Group line items by parent WO id
  const itemsByWo = new Map<string, SnapshotWoli[]>();
  for (const l of snapshot.woLineItems) {
    const arr = itemsByWo.get(l.workOrderId);
    if (arr) arr.push(l);
    else itemsByWo.set(l.workOrderId, [l]);
  }

  const out: OpenWorkOrderForMaterials[] = [];
  for (const wo of snapshot.workOrders) {
    if (!isOpenForMaterials(wo.status)) continue;
    // Filter out pre-quote WorkTypes (Estimate, Appointment, etc.) — these
    // don't need materials ordered yet. Real paint jobs surface; the rest
    // are upstream stages tracked elsewhere on the dashboard.
    if (!workTypeRequiresMaterials(wo.workTypeName)) continue;
    const raws = itemsByWo.get(wo.id) ?? [];
    // INCLUDE WOs with 0 line items — the rep needs to know the WO exists
    // and someone still has to enter the rooms. Hiding them was confusing
    // ("I see 18 open WOs in SF but Materials Ordering only shows 15").
    const lineItems = raws
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => resolveWoli(r, colorIndex));

    // sqFootage is often 0 in PPP's data — fall back to wallSurfaceArea so the
    // top stat strip doesn't lie when the line items have wall area populated
    // but no Sq_Footage__c entry. Skip negative values (credit/refund WOLIs).
    const totalSqFt = raws.reduce((s, r) => {
      if (r.sqFootage > 0) return s + r.sqFootage;
      if (r.wallSurfaceArea > 0) return s + r.wallSurfaceArea;
      return s;
    }, 0);

    const colorIds = new Set<string>();
    const bySupplier = new Map<string | "unknown", number>();
    for (const li of lineItems) {
      for (const slot of [li.wall, li.ceiling, li.trim, li.other, li.floor]) {
        if (!slot) continue;
        if (colorIds.has(slot.id)) continue;
        colorIds.add(slot.id);
        const key = slot.manufacturerId ?? "unknown";
        bySupplier.set(key, (bySupplier.get(key) ?? 0) + 1);
      }
    }

    out.push({
      wo,
      lineItems,
      totalSqFt,
      distinctColorCount: colorIds.size,
      bySupplier,
    });
  }

  // Sort: soonest close date first. Null close dates last.
  out.sort((a, b) => {
    if (!a.wo.closeDate && !b.wo.closeDate) return 0;
    if (!a.wo.closeDate) return 1;
    if (!b.wo.closeDate) return -1;
    return a.wo.closeDate.localeCompare(b.wo.closeDate);
  });
  return out;
}

/**
 * Resolve a Manufacturer Account Id to a supplier display name. PPP models
 * paint manufacturers as Account records, so we look them up by Id in the
 * accounts array.
 */
export function getSupplierName(
  snapshot: SalesforceSnapshot,
  manufacturerId: string | null | "unknown"
): string {
  if (!manufacturerId || manufacturerId === "unknown") return "Unknown supplier";
  const acct = snapshot.accounts.find((a) => a.id === manufacturerId);
  return acct?.name ?? "Unknown supplier";
}
