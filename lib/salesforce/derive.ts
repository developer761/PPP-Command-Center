/**
 * Pure derivation functions that turn a SalesforceSnapshot into the shapes
 * the Command Center UI expects (Rep[], SeriesPoint[], FilteredView, etc.).
 *
 * No SF calls here — everything is computed from the cached snapshot. Safe to
 * run client-side OR server-side; we run them client-side so filter changes
 * are instant.
 */

import type {
  SalesforceSnapshot,
  SnapshotOpp,
  SnapshotRep,
  SnapshotWorkOrder,
} from "@/lib/salesforce/queries";

/**
 * PPP's revenue truth lives on Work Orders, not Opportunities. PPP's
 * "Opportunities with Work Orders" report sums Net Value across WO rows
 * (a single Opp can have multiple WOs). Summing per-Opp under-counts. We
 * therefore prefer the WO array when available, falling back to Opp totals
 * only if the WO query returned zero records.
 */
function revenueRows(snapshot: SalesforceSnapshot) {
  return snapshot.workOrders.length > 0
    ? snapshot.workOrders.map((w) => ({
        ownerId: w.ownerId ?? "",
        amount: w.amount,
        closeDate: w.closeDate,
        createdDate: w.createdDate,
      }))
    : snapshot.opportunities.map((o) => ({
        ownerId: o.ownerId,
        amount: o.amount,
        closeDate: o.closeDate,
        createdDate: o.createdDate,
      }));
}

/**
 * "Real sale" WO predicate. PPP creates an Estimate WO on every Opportunity
 * regardless of whether the deal ever sells — that's why the previous
 * "opps with any WO" close-rate proxy ran near 100% for every rep. A WO
 * counts as a real sale only when:
 *   - WorkType is a job stage (NOT Estimate / Appointment / Inspection / Consultation)
 *   - Status is not a dead-end terminal (cancelled / void / abandoned / dead)
 *
 * Mirrors the WorkType/Status filter already used on the Materials Ordering
 * page (lib/salesforce/queries.ts:1431). Single source of truth for "did this
 * opp turn into actual work."
 *
 * Used by: deriveRepsForPeriod (leaderboard + rep cards), deriveTopPerformer.
 */
function isRealSaleWO(w: { workTypeName: string | null; status: string | null }): boolean {
  const wt = (w.workTypeName ?? "").toLowerCase();
  // PRE-quote / discovery stages aren't sales — they exist on every opp.
  if (
    wt.includes("estimate") ||
    wt.includes("appointment") ||
    wt.includes("inspection") ||
    wt.includes("consultation")
  ) {
    return false;
  }
  // Dead-end terminal statuses — WO created but no work happened.
  const s = (w.status ?? "").toLowerCase();
  if (
    s.includes("cancel") ||
    s.includes("void") ||
    s.includes("abandon") ||
    s.includes("dead") ||
    s.includes("lost")
  ) {
    return false;
  }
  return true;
}
import type {
  Deal,
  Period,
  Rep,
  RepMonthlyPoint,
  SeriesPoint,
} from "@/lib/mock-data";

/* ─── Period helpers ─── */

export const PERIOD_DAYS: Record<Period, number> = {
  lifetime: 0,        // no scope — include everything
  "this-month": 0,    // computed from calendar
  "last-month": 0,    // computed from calendar
  "this-year": 0,     // computed from calendar
  "last-year": 0,     // computed from calendar
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 180,
  "12m": 365,
  ytd: 0,             // computed dynamically
};

/** Earliest sensible "lifetime" anchor — Salesforce epoch-equivalent. */
const LIFETIME_START = new Date(Date.UTC(2000, 0, 1));

/**
 * Compute start AND end of a period. Most periods end at "now", but calendar
 * periods (last-month, last-year) end at a fixed past date.
 */
export function periodRange(period: Period, now: Date = new Date()): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === "lifetime") return { start: LIFETIME_START, end: now };
  if (period === "ytd" || period === "this-year") {
    return { start: new Date(Date.UTC(y, 0, 1)), end: now };
  }
  if (period === "last-year") {
    return {
      start: new Date(Date.UTC(y - 1, 0, 1)),
      end: new Date(Date.UTC(y, 0, 1)),
    };
  }
  if (period === "this-month") {
    return { start: new Date(Date.UTC(y, m, 1)), end: now };
  }
  if (period === "last-month") {
    return {
      start: new Date(Date.UTC(y, m - 1, 1)),
      end: new Date(Date.UTC(y, m, 1)),
    };
  }
  // Rolling windows ending now.
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - PERIOD_DAYS[period]);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: now };
}

function startOfPeriod(period: Period, now: Date = new Date()): Date {
  return periodRange(period, now).start;
}

function priorPeriodStart(period: Period, now: Date = new Date()): { from: Date; to: Date } {
  if (period === "lifetime") {
    // No prior for lifetime — return a 0-width window so no opp matches.
    return { from: new Date(0), to: new Date(0) };
  }
  const periodStart = startOfPeriod(period, now);
  const span = now.getTime() - periodStart.getTime();
  const priorEnd = periodStart;
  const priorStart = new Date(periodStart.getTime() - span);
  return { from: priorStart, to: priorEnd };
}

function isInRange(iso: string | null, from: Date, to: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from.getTime() && t < to.getTime();
}

/* ─── Region / service-line inference ─── */

/**
 * Derive a rep's primary region. PPP stores territory on Account
 * (Account.Region__c — values like "Long Island", "NYC", etc.). A rep's
 * "primary region" = the most common Account.Region__c across their
 * WorkOrder-attached accounts.
 *
 * Falls back to UserRole/Department string match if no WO data exists yet
 * (sandbox or freshly-loaded production).
 */
export function deriveRegion(
  rep: SnapshotRep,
  snapshot?: SalesforceSnapshot
): Rep["region"] {
  if (snapshot) {
    // ID-first lookup with name fallback for legacy WOs that pre-date the
    // accountId column. Two Accounts with the same name would have collided
    // on the older name-only path; ID-based matching is collision-proof.
    const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]));
    const accountByName = new Map(snapshot.accounts.map((a) => [a.name, a]));
    const regionCounts = new Map<string, number>();
    for (const w of snapshot.workOrders) {
      if (w.ownerId !== rep.id) continue;
      const acct =
        (w.accountId ? accountById.get(w.accountId) : null) ??
        (w.accountName ? accountByName.get(w.accountName) : null);
      const region = acct?.region;
      if (!region) continue;
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    }
    if (regionCounts.size > 0) {
      let bestRegion: string | null = null;
      let bestCount = 0;
      for (const [r, c] of regionCounts.entries()) {
        if (c > bestCount) {
          bestRegion = r;
          bestCount = c;
        }
      }
      if (bestRegion) return bestRegion;
    }
  }
  // Fallback: heuristic string match on user role/department.
  const probe = `${rep.roleName ?? ""} ${rep.department ?? ""}`.toLowerCase();
  if (probe.includes("suffolk")) return "Suffolk";
  if (probe.includes("nassau")) return "Nassau";
  if (probe.includes("queens")) return "Queens";
  if (probe.includes("brooklyn")) return "Brooklyn";
  return "Unassigned";
}

export function deriveServiceLine(rep: SnapshotRep): Rep["serviceLine"] {
  const probe = `${rep.roleName ?? ""} ${rep.profileName ?? ""}`.toLowerCase();
  if (probe.includes("commercial")) return "Commercial";
  return "Residential";
}

/* ─── Core derivation: reps with period-scoped metrics ─── */

/**
 * Returns Rep[] with metrics scoped to the chosen period.
 * Reps with zero activity in the period are still included with $0 values —
 * they sort to the bottom of the leaderboard but the user can still see them.
 */
export function deriveRepsForPeriod(
  snapshot: SalesforceSnapshot,
  period: Period
): Rep[] {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);

  const initStats = () => ({
    total: 0, closed: 0, won: 0, wonRevenue: 0, openPipeline: 0,
    daysToCloseSum: 0, daysToCloseCount: 0, ticketSum: 0, ticketCount: 0,
  });
  const byOwner = new Map<string, ReturnType<typeof initStats>>();

  // Revenue: SUM(WO Net Value) where CloseDate ∈ period. Matches PPP's
  // "Opportunities with Work Orders" report — multiple WOs per Opp = multiple
  // rows (correct double-counting per their report).
  for (const row of revenueRows(snapshot)) {
    if (!row.ownerId || row.amount === 0) continue;
    if (!isInRange(row.closeDate, periodStart, periodEnd)) continue;

    const a = byOwner.get(row.ownerId) ?? initStats();
    a.wonRevenue += row.amount;
    a.ticketSum += row.amount;
    a.ticketCount += 1;
    if (row.closeDate) {
      const created = new Date(row.createdDate).getTime();
      const closed = new Date(row.closeDate).getTime();
      if (!isNaN(created) && !isNaN(closed)) {
        a.daysToCloseSum += Math.max(0, Math.round((closed - created) / 86_400_000));
        a.daysToCloseCount += 1;
      }
    }
    byOwner.set(row.ownerId, a);
  }

  // Close Rate = "real sale" rate = (opps that became actual jobs) / (opps created in period).
  //
  // FIX (2026-05-23): the previous version counted *any* linked WO as "won".
  // PPP creates an Estimate WO on every Opp regardless of outcome, so every
  // rep's close rate trended ~100% (Stephen Sandoval showed 100.0%, Andres
  // Grajales 97.8% on the leaderboard). Now uses isRealSaleWO() to exclude:
  //   - Estimate / Appointment / Inspection / Consultation workTypes
  //   - Cancelled / void / abandoned / lost statuses
  // Result: an Opp counts as "won" only if at least one of its WOs is a
  // genuine paid job. Aligns with the WorkType filter Materials Ordering
  // already uses, so the dashboard tells one consistent story.
  //
  // The IsWon flag is intentionally NOT used because PPP's stage config
  // doesn't include a "Closed Lost" stage (per shared SF reference repo,
  // BUSINESS_RULES.md §lead-source). The WorkType + Status combo is the
  // actual signal for "did this convert."
  const oppsWithRealSaleSet = new Set<string>();
  for (const w of snapshot.workOrders) {
    if (!w.opportunityId) continue;
    if (isRealSaleWO(w)) oppsWithRealSaleSet.add(w.opportunityId);
  }
  for (const o of snapshot.opportunities) {
    if (!o.ownerId) continue;
    if (!isInRange(o.createdDate, periodStart, periodEnd)) continue;
    const a = byOwner.get(o.ownerId) ?? initStats();
    a.closed += 1; // denominator: "opps created in this period"
    if (oppsWithRealSaleSet.has(o.id)) a.won += 1; // numerator: "opps that became real jobs"
    byOwner.set(o.ownerId, a);
  }

  // total = opps the rep worked in period (= same as a.closed from above
  // since "Opp created in period" is the conversion denominator).
  // Activity counts are kept separate in case we want appts/quotes
  // proxies later; for now total = closed.
  for (const stats of byOwner.values()) {
    stats.total = stats.closed;
  }

  // Open pipeline = currently-open opps without a real (non-estimate) WO yet.
  // Uses the same isRealSaleWO filter as the close-rate calc — an Opp with
  // only an Estimate WO attached is STILL "in pipeline" (no real job yet).
  // Reuses oppsWithRealSaleSet from the close-rate computation above.
  for (const o of snapshot.opportunities) {
    if (o.isClosed) continue;
    if (oppsWithRealSaleSet.has(o.id)) continue;
    if (o.amount <= 0) continue;
    const a = byOwner.get(o.ownerId) ?? initStats();
    a.openPipeline += o.amount;
    byOwner.set(o.ownerId, a);
  }

  const cards: Rep[] = snapshot.reps.map((u) => {
    const a = byOwner.get(u.id) ?? {
      total: 0, closed: 0, won: 0, wonRevenue: 0, openPipeline: 0,
      daysToCloseSum: 0, daysToCloseCount: 0, ticketSum: 0, ticketCount: 0,
    };
    const closeRate = a.closed > 0 ? (a.won / a.closed) * 100 : 0;
    const avgTicket = a.ticketCount > 0 ? a.ticketSum / a.ticketCount : 0;
    const daysAvgClose = a.daysToCloseCount > 0
      ? Math.round(a.daysToCloseSum / a.daysToCloseCount)
      : 0;
    return {
      id: u.id,
      name: u.name,
      region: deriveRegion(u, snapshot),
      serviceLine: deriveServiceLine(u),
      revenueSold: Math.round(a.wonRevenue / 1000),
      closeRate: +closeRate.toFixed(1),
      avgTicket: +(avgTicket / 1000).toFixed(1),
      openPipeline: Math.round(a.openPipeline / 1000),
      daysAvgClose,
      appointmentsHeld: a.total, // approximation: opp-count proxy for activity
      quotesSent: a.total,
      startedAt: u.createdDate.split("T")[0],
      isFieldStandard: u.isFieldStandard,
    };
  });

  // Orphan owners (users who own WOs but aren't in the canonical rep set —
  // admins, office staff, suspended users) are NO LONGER surfaced on the
  // leaderboard. Per Katie's integration guide §4.4, PPP's actual rep
  // universe is Profile=*Standard.Field (~29 active). Including orphans
  // pollutes team-average denominators AND can let an admin appear as
  // "top performer" if they happen to own outsized WOs. The diagnostic
  // /api/admin/wo-debug surfaces orphan ownership if needed for triage.
  //
  // Previously this block appended every owner who had ANY WO activity,
  // including admin-profile users with a single legacy WO under their name.
  // Now: canonical reps only. If a real rep is missing from the leaderboard,
  // their Profile.Name doesn't match `*Standard.Field` — ask Katie to fix
  // the User record, not patch around it here.

  return cards;
}

/* ─── Top performer for the period ─── */

export function deriveTopPerformer(
  snapshot: SalesforceSnapshot,
  period: Period
): { id: string; name: string; region: string; revenue: number; closeRate: number } | null {
  const reps = deriveRepsForPeriod(snapshot, period);
  const winner = reps.reduce((best, r) =>
    r.revenueSold > (best?.revenueSold ?? -1) ? r : best,
    null as Rep | null
  );
  if (!winner || winner.revenueSold === 0) return null;
  return {
    id: winner.id,
    name: winner.name,
    region: `${winner.region} · ${winner.serviceLine}`,
    revenue: winner.revenueSold,
    closeRate: winner.closeRate,
  };
}

/* ─── Pipeline at risk: open opps stale 14+ days ─── */

export function derivePipelineAtRisk(
  snapshot: SalesforceSnapshot
): { value: number; count: number; reps: number } {
  const now = Date.now();
  const STALE_MS = 14 * 86_400_000;
  let value = 0;
  let count = 0;
  const repsSet = new Set<string>();
  for (const o of snapshot.opportunities) {
    if (o.isClosed) continue;
    const lastTouch = o.lastActivityDate ? new Date(o.lastActivityDate).getTime() : new Date(o.createdDate).getTime();
    if (now - lastTouch >= STALE_MS) {
      value += o.amount;
      count += 1;
      repsSet.add(o.ownerId);
    }
  }
  return {
    value: Math.round(value / 1000),
    count,
    reps: repsSet.size,
  };
}

/**
 * Deal-level stuck-pipeline rows — feeds the /dashboard/stuck page.
 * Returns each individual open Opportunity that hasn't moved in N days,
 * sorted by amount-at-risk desc so the biggest stalled deals surface first.
 *
 * Per Alex-UX audit (2026-05-26): the existing derivePipelineAtRisk
 * returns an aggregate ("$14K across 5 deals") — that's the dashboard
 * KPI card. But Alex wants to know "WHICH 5 deals and who owns them?"
 * in 5 seconds. This function returns the deal-level detail so the
 * /dashboard/stuck page can list them.
 *
 * Parameters:
 *   - staleDays — how many days without activity counts as stuck.
 *     Default 14 matches derivePipelineAtRisk for consistency.
 *
 * Scope: respects the snapshot the caller passes — so a scoped (rep-only)
 * snapshot returns only that rep's stuck deals. Admins viewing the full
 * snapshot see every stuck deal company-wide.
 */
export type StuckDeal = {
  id: string;
  accountName: string | null;
  amount: number;            // raw $ (not $K) for sort precision
  ownerId: string;
  ownerName: string;         // resolved via WO ownerName lookup OR rep lookup
  stageName: string;
  createdDate: string;
  lastActivityDate: string | null;
  daysSinceActivity: number;
};

export function deriveStuckDeals(
  snapshot: SalesforceSnapshot,
  staleDays: number = 14
): StuckDeal[] {
  const now = Date.now();
  const staleMs = staleDays * 86_400_000;
  // Build a User-id → name lookup. Snapshot.reps + WO ownerName both
  // contribute; first hit wins (snapshot.reps is canonical for active
  // field-standard users).
  const ownerNameLookup = new Map<string, string>();
  for (const r of snapshot.reps) {
    if (r.name) ownerNameLookup.set(r.id, r.name);
  }
  for (const w of snapshot.workOrders) {
    if (w.ownerId && w.ownerName && !ownerNameLookup.has(w.ownerId)) {
      ownerNameLookup.set(w.ownerId, w.ownerName);
    }
  }

  const stuck: StuckDeal[] = [];
  for (const o of snapshot.opportunities) {
    if (o.isClosed) continue;
    // Require a real LastActivityDate. The previous behavior fell back to
    // createdDate when LastActivityDate was null, which conflated "no
    // activity ever logged" (could be a brand-new opp or one that simply
    // never gets its activities synced) with "rep stopped following up
    // 6 months ago." That inflated the stuck-deals list with old discovery
    // opps that aren't actually stalled — they just live outside SF's
    // activity tracking. Stuck = "we KNOW the last touch was N+ days ago",
    // not "we don't know when the last touch was."
    if (!o.lastActivityDate) continue;
    const lastTouch = new Date(o.lastActivityDate).getTime();
    if (isNaN(lastTouch)) continue;
    const ageMs = now - lastTouch;
    if (ageMs < staleMs) continue;
    stuck.push({
      id: o.id,
      accountName: o.accountName,
      amount: o.amount,
      ownerId: o.ownerId,
      ownerName: ownerNameLookup.get(o.ownerId) ?? "(unassigned)",
      stageName: o.stageName,
      createdDate: o.createdDate,
      lastActivityDate: o.lastActivityDate,
      daysSinceActivity: Math.floor(ageMs / 86_400_000),
    });
  }
  // Sort by amount-at-risk desc — biggest stalled deals first matches what
  // Alex would scan top-down on a phone.
  stuck.sort((a, b) => b.amount - a.amount);
  return stuck;
}

/* ─── Company trendline ─── */

function bucketStartDaily(iso: string): string {
  // Returns YYYY-MM-DD
  return iso.split("T")[0];
}

function bucketStartMonthly(iso: string): string {
  // Returns YYYY-MM
  return iso.slice(0, 7);
}

function formatDayLabel(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export function deriveCompanyTrend(
  snapshot: SalesforceSnapshot,
  period: Period
): { granularity: "daily" | "monthly"; series: SeriesPoint[] } {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);
  const granularity: "daily" | "monthly" =
    period === "7d" || period === "30d" || period === "this-month" || period === "last-month"
      ? "daily"
      : "monthly";

  // For "lifetime", clamp the start to the earliest WO close date in the
  // snapshot so we don't render hundreds of empty monthly buckets back to 2000.
  let effectiveStart = periodStart;
  if (period === "lifetime") {
    let earliest: Date | null = null;
    for (const row of revenueRows(snapshot)) {
      if (row.amount === 0 || !row.closeDate) continue;
      const d = new Date(row.closeDate + "T00:00:00Z");
      if (!earliest || d < earliest) earliest = d;
    }
    if (earliest) effectiveStart = earliest;
  }

  const buckets = new Map<
    string,
    { revenue: number; deals: number; byRegion: Map<string, number>; byRep: Map<string, number> }
  >();

  // Quick rep id → region/name lookup
  const repInfo = new Map<string, { name: string; region: string }>();
  for (const r of snapshot.reps) {
    repInfo.set(r.id, { name: r.name, region: deriveRegion(r, snapshot) });
  }

  for (const row of revenueRows(snapshot)) {
    // PPP revenue model: count revenue from WO rows with closeDate in period.
    // A single Opp's multiple WOs each contribute their own row — matches the
    // "Opportunities with Work Orders" report exactly.
    if (row.amount === 0 || !row.closeDate) continue;
    const closed = new Date(row.closeDate + "T00:00:00Z");
    if (closed < effectiveStart || closed >= periodEnd) continue;
    const key = granularity === "daily"
      ? bucketStartDaily(row.closeDate)
      : bucketStartMonthly(row.closeDate);
    const b = buckets.get(key) ?? {
      revenue: 0,
      deals: 0,
      byRegion: new Map(),
      byRep: new Map(),
    };
    b.revenue += row.amount;
    b.deals += 1;
    const info = row.ownerId ? repInfo.get(row.ownerId) : null;
    if (info) {
      b.byRegion.set(info.region, (b.byRegion.get(info.region) ?? 0) + row.amount);
      b.byRep.set(info.name, (b.byRep.get(info.name) ?? 0) + row.amount);
    }
    buckets.set(key, b);
  }

  // Generate continuous bucket range so empty days/months render zero (not gap)
  const series: SeriesPoint[] = [];
  if (granularity === "daily") {
    const cursor = new Date(effectiveStart);
    while (cursor < periodEnd) {
      const key = bucketStartDaily(cursor.toISOString());
      const b = buckets.get(key);
      const topRegion = b ? topEntry(b.byRegion) : null;
      const topRep = b ? topEntry(b.byRep) : null;
      series.push({
        label: formatDayLabel(key),
        value: b ? Math.round(b.revenue / 1000) : 0,
        meta: {
          topRegion: topRegion ? { region: topRegion.key, revenue: Math.round(topRegion.value / 1000) } : undefined,
          topRep: topRep ? { name: topRep.key, revenue: Math.round(topRep.value / 1000) } : undefined,
          deals: b?.deals,
        },
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else {
    const cursor = new Date(Date.UTC(effectiveStart.getUTCFullYear(), effectiveStart.getUTCMonth(), 1));
    const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 1));
    while (cursor <= end) {
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
      const b = buckets.get(key);
      const topRegion = b ? topEntry(b.byRegion) : null;
      const topRep = b ? topEntry(b.byRep) : null;
      series.push({
        label: formatMonthLabel(key),
        value: b ? Math.round(b.revenue / 1000) : 0,
        meta: {
          topRegion: topRegion ? { region: topRegion.key, revenue: Math.round(topRegion.value / 1000) } : undefined,
          topRep: topRep ? { name: topRep.key, revenue: Math.round(topRep.value / 1000) } : undefined,
          deals: b?.deals,
        },
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return { granularity, series };
}

function topEntry(m: Map<string, number>): { key: string; value: number } | null {
  let best: { key: string; value: number } | null = null;
  for (const [k, v] of m) {
    if (!best || v > best.value) best = { key: k, value: v };
  }
  return best;
}

/* ─── Period-over-period delta ─── */

export function derivePeriodDelta(
  snapshot: SalesforceSnapshot,
  period: Period
): { value: number; change: number; trend: "up" | "down" | "flat" } {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);
  const prior = priorPeriodStart(period, now);

  let current = 0;
  let priorTotal = 0;
  for (const row of revenueRows(snapshot)) {
    if (row.amount === 0 || !row.closeDate) continue;
    const closed = new Date(row.closeDate + "T00:00:00Z");
    if (closed >= periodStart && closed < periodEnd) current += row.amount;
    else if (closed >= prior.from && closed < prior.to) priorTotal += row.amount;
  }
  const change = priorTotal === 0 ? 0 : Math.round(((current - priorTotal) / priorTotal) * 100);
  return {
    value: Math.round(current / 1000),
    change,
    trend: change > 0.5 ? "up" : change < -0.5 ? "down" : "flat",
  };
}

/* ─── Per-rep monthly history (12 months) ─── */

export function deriveRepMonthly(
  snapshot: SalesforceSnapshot,
  repId: string
): RepMonthlyPoint[] {
  const buckets = new Map<string, { revenue: number; closeCnt: number; wonCnt: number; ticketSum: number; ticketCount: number }>();
  const now = new Date();
  const earliest = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));

  for (const row of revenueRows(snapshot)) {
    if (row.ownerId !== repId) continue;
    if (!row.closeDate) continue;
    const closed = new Date(row.closeDate + "T00:00:00Z");
    if (closed < earliest) continue;
    const key = bucketStartMonthly(row.closeDate);
    const b = buckets.get(key) ?? { revenue: 0, closeCnt: 0, wonCnt: 0, ticketSum: 0, ticketCount: 0 };
    b.closeCnt += 1;
    if (row.amount > 0) {
      b.wonCnt += 1;
      b.revenue += row.amount;
      b.ticketSum += row.amount;
      b.ticketCount += 1;
    }
    buckets.set(key, b);
  }

  const series: RepMonthlyPoint[] = [];
  const cursor = new Date(earliest);
  while (cursor <= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
    const b = buckets.get(key);
    series.push({
      month: formatMonthLabel(key),
      revenue: b ? Math.round(b.revenue / 1000) : 0,
      closeRate: b && b.closeCnt > 0 ? +(b.wonCnt / b.closeCnt * 100).toFixed(1) : 0,
      avgTicket: b && b.ticketCount > 0 ? +(b.ticketSum / b.ticketCount / 1000).toFixed(1) : 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return series;
}

/* ─── Today snapshot + Month forecast ─── */

/**
 * "Today" snapshot — today's revenue + deal count + comparison to same day last
 * week. Drives the strip at the top of /dashboard so Alex can glance and know:
 * are we on pace?
 */
/**
 * "Today" anchored in America/New_York (PPP HQ).
 * Logic bug fix: using UTC, at 11pm EST = 4am UTC next day → today's
 * revenue shifted forward by a day for several hours each night.
 */
function startOfTodayInNY(now: Date = new Date()): Date {
  const nyDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return new Date(nyDate + "T00:00:00Z");
}

export function deriveTodaySnapshot(
  snapshot: SalesforceSnapshot
): {
  todayRevenue: number;       // $K
  todayDealCount: number;
  yesterdayRevenue: number;   // $K
  sameDayLastWeekRevenue: number; // $K
  weekRevenue: number;        // $K (last 7 days)
  weekPriorRevenue: number;   // $K (8-14 days ago, comparison)
  biggestDealToday: {
    account: string;
    amount: number;
    rep: string | null;
    workOrderNumber: string | null;
    status: string | null;
  } | null;
} {
  const startOfToday = startOfTodayInNY();
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfSameDayLastWeek = new Date(startOfToday.getTime() - 7 * 86_400_000);
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);
  const startOfDayAfterSDLW = new Date(startOfSameDayLastWeek.getTime() + 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000);
  const startOfPriorWeek = new Date(startOfWeek.getTime() - 7 * 86_400_000);

  let todayRev = 0;
  let todayCnt = 0;
  let yesterdayRev = 0;
  let sdLwRev = 0;
  let weekRev = 0;
  let priorWeekRev = 0;
  let biggestWO: SnapshotWorkOrder | null = null;

  // Iterate Work Orders directly so we can keep the actual WO reference for
  // "biggest deal today" — no fragile post-hoc .find() lookup that could
  // match the wrong WO when two share close date + amount + owner.
  for (const w of snapshot.workOrders) {
    if (w.amount === 0 || !w.closeDate) continue;
    const d = new Date(w.closeDate + "T00:00:00Z");
    if (d >= startOfToday && d < startOfTomorrow) {
      todayRev += w.amount;
      todayCnt += 1;
      if (!biggestWO || w.amount > biggestWO.amount) biggestWO = w;
    }
    if (d >= startOfYesterday && d < startOfToday) yesterdayRev += w.amount;
    if (d >= startOfSameDayLastWeek && d < startOfDayAfterSDLW) sdLwRev += w.amount;
    if (d >= startOfWeek && d < startOfTomorrow) weekRev += w.amount;
    if (d >= startOfPriorWeek && d < startOfWeek) priorWeekRev += w.amount;
  }

  return {
    todayRevenue: Math.round(todayRev / 1000),
    todayDealCount: todayCnt,
    yesterdayRevenue: Math.round(yesterdayRev / 1000),
    sameDayLastWeekRevenue: Math.round(sdLwRev / 1000),
    weekRevenue: Math.round(weekRev / 1000),
    weekPriorRevenue: Math.round(priorWeekRev / 1000),
    biggestDealToday: biggestWO
      ? {
          account: biggestWO.accountName ?? "(unknown account)",
          amount: Math.round(biggestWO.amount / 1000),
          rep: biggestWO.ownerName,
          workOrderNumber: biggestWO.workOrderNumber,
          status: biggestWO.status,
        }
      : null,
  };
}

/**
 * Month-end forecast based on linear extrapolation of the current month's pace.
 * Compares to last month's actual for an "on track vs behind/ahead" call.
 */
export function deriveMonthForecast(
  snapshot: SalesforceSnapshot
): {
  monthToDateRevenue: number;       // $K
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  projectedMonthEnd: number;        // $K
  lastMonthActual: number;          // $K
  vsLastMonthPct: number;           // forecast vs last month, %
  pacePct: number;                  // % of month elapsed (0-100)
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startOfMonth = new Date(Date.UTC(y, m, 1));
  const startOfNextMonth = new Date(Date.UTC(y, m + 1, 1));
  const daysInMonth = Math.round((startOfNextMonth.getTime() - startOfMonth.getTime()) / 86_400_000);
  // daysElapsed = the day-of-month we're on (1 on the 1st, 2 on the 2nd, etc).
  // Use floor + 1 instead of round + 1 so we don't roll to "day 2" late on
  // day 1 just because UTC time-of-day rounds up.
  const daysElapsed = Math.max(
    1,
    Math.floor((now.getTime() - startOfMonth.getTime()) / 86_400_000) + 1
  );
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);

  // Last month bounds
  const startOfLastMonth = new Date(Date.UTC(y, m - 1, 1));
  const endOfLastMonth = startOfMonth;

  let mtdRev = 0;
  let lastMonthRev = 0;
  for (const row of revenueRows(snapshot)) {
    if (row.amount === 0 || !row.closeDate) continue;
    const d = new Date(row.closeDate + "T00:00:00Z");
    if (d >= startOfMonth && d < startOfNextMonth) mtdRev += row.amount;
    if (d >= startOfLastMonth && d < endOfLastMonth) lastMonthRev += row.amount;
  }

  const dailyRunRate = mtdRev / daysElapsed;
  const projected = Math.round(dailyRunRate * daysInMonth / 1000);
  const vsLastMonthPct = lastMonthRev === 0
    ? 0
    : Math.round(((projected * 1000 - lastMonthRev) / lastMonthRev) * 100);

  return {
    monthToDateRevenue: Math.round(mtdRev / 1000),
    daysElapsed,
    daysInMonth,
    daysRemaining,
    projectedMonthEnd: projected,
    lastMonthActual: Math.round(lastMonthRev / 1000),
    vsLastMonthPct,
    pacePct: Math.round((daysElapsed / daysInMonth) * 100),
  };
}

/**
 * Top customers by lifetime revenue. Uses Account.Total_Lifetime_Revenue__c
 * (PPP-populated formula field). Returns top N with their type + flags.
 */
export function deriveTopCustomers(
  snapshot: SalesforceSnapshot,
  limit: number = 10
): Array<{
  id: string;
  name: string;
  lifetimeRevenue: number;
  type: string | null;
  isRepeat: boolean;
  isKey: boolean;
  region: string | null;
  lastWorkOrderCompleted: string | null;
}> {
  return [...snapshot.accounts]
    .filter((a) => a.totalLifetimeRevenue > 0)
    .sort((a, b) => b.totalLifetimeRevenue - a.totalLifetimeRevenue)
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      name: a.name,
      lifetimeRevenue: a.totalLifetimeRevenue,
      type: a.type,
      isRepeat: (a.type ?? "").toLowerCase().includes("repeat"),
      isKey: a.isKeyRelationship,
      region: a.region,
      lastWorkOrderCompleted: a.lastWorkOrderCompleted,
    }));
}

/**
 * Quote-to-Cash velocity — average days from Opp create → WO create across
 * the last 90 days of activity. Tells PPP how fast their lead-to-job pipeline
 * is moving. Lower = healthier conversion engine.
 */
export function deriveQuoteToCashVelocity(
  snapshot: SalesforceSnapshot
): { avgDays: number; sampleCount: number } {
  const oppCreated = new Map(snapshot.opportunities.map((o) => [o.id, o.createdDate]));
  let totalDays = 0;
  let count = 0;
  const cutoff = Date.now() - 90 * 86_400_000;
  for (const w of snapshot.workOrders) {
    if (!w.opportunityId) continue;
    const oppC = oppCreated.get(w.opportunityId);
    if (!oppC) continue;
    const oppMs = new Date(oppC).getTime();
    const woMs = new Date(w.createdDate).getTime();
    if (isNaN(oppMs) || isNaN(woMs)) continue;
    if (woMs < cutoff) continue;
    const days = (woMs - oppMs) / 86_400_000;
    if (days < 0 || days > 365) continue; // sanity
    totalDays += days;
    count += 1;
  }
  return {
    avgDays: count > 0 ? Math.round(totalDays / count) : 0,
    sampleCount: count,
  };
}

/**
 * Week-over-week momentum per rep.
 * Compares this week (last 7d) revenue vs prior week (8–14d ago).
 * Positive = trending up, negative = cooling off.
 */
export function deriveRepMomentum(
  snapshot: SalesforceSnapshot
): Map<string, { thisWeek: number; priorWeek: number; deltaPct: number }> {
  const now = Date.now();
  const oneWeekAgo = now - 7 * 86_400_000;
  const twoWeeksAgo = now - 14 * 86_400_000;
  const byRep = new Map<string, { thisWeek: number; priorWeek: number; deltaPct: number }>();

  for (const row of revenueRows(snapshot)) {
    if (!row.ownerId || !row.closeDate || row.amount === 0) continue;
    // Anchor the date-only closeDate to UTC midnight like every other revenue
    // function in this file — a bare new Date("YYYY-MM-DD") is already UTC
    // midnight, but the explicit suffix keeps the week-boundary bucketing
    // consistent with deriveTrend/deriveTodaySnapshot and avoids drift if the
    // value ever arrives as a full datetime.
    const closed = new Date(row.closeDate + "T00:00:00Z").getTime();
    if (isNaN(closed)) continue;

    const stats = byRep.get(row.ownerId) ?? { thisWeek: 0, priorWeek: 0, deltaPct: 0 };
    if (closed >= oneWeekAgo && closed <= now) {
      stats.thisWeek += row.amount;
    } else if (closed >= twoWeeksAgo && closed < oneWeekAgo) {
      stats.priorWeek += row.amount;
    }
    byRep.set(row.ownerId, stats);
  }

  for (const stats of byRep.values()) {
    stats.deltaPct = stats.priorWeek === 0
      ? (stats.thisWeek > 0 ? 100 : 0)
      : Math.round(((stats.thisWeek - stats.priorWeek) / stats.priorWeek) * 100);
  }

  return byRep;
}

/* ─── Cost + margin helpers ─── */

/**
 * Compute the "trustworthy" gross profit for a WO. PPP's Gross_Profit__c
 * field defaults to NetValue when costs aren't entered → produces a fake
 * 100% margin. We instead derive GP from explicit costs (materials + labor
 * payouts) when both are present; otherwise we don't trust the GP value
 * and exclude it from leaderboards.
 *
 * Returns null when we can't compute a real margin.
 */
function trueGrossProfit(
  amount: number,
  costMaterials: number,
  totalPayoutsForLabor: number,
  reportedGP: number
): { gp: number; marginPct: number } | null {
  if (amount <= 0) return null;
  const explicitCost = costMaterials + totalPayoutsForLabor;
  // If we have at least some explicit cost data, compute from that.
  if (explicitCost > 0) {
    const gp = amount - explicitCost;
    const marginPct = (gp / amount) * 100;
    // Sanity range: paint contractor margins typically 15-65%. Anything
    // outside this likely means cost data is still incomplete on this WO.
    if (marginPct < -20 || marginPct > 85) return null;
    return { gp, marginPct };
  }
  // No cost data at all → reportedGP is unreliable (likely = amount).
  if (reportedGP > 0 && reportedGP < amount * 0.95) {
    // GP looks like a real number, not just a copy of amount.
    const marginPct = (reportedGP / amount) * 100;
    if (marginPct >= 5 && marginPct <= 85) {
      return { gp: reportedGP, marginPct };
    }
  }
  return null;
}

/* ─── Financials rollups ─── */

/**
 * Company-wide financial picture for the Financials tab.
 * AR aging (from WO.balanceOwed + finalBalanceAging), GP, lead-fee ROI,
 * discount leaks, commissions. All scoped by an optional period.
 */
export function deriveFinancials(
  snapshot: SalesforceSnapshot,
  period: Period = "this-month"
): {
  arAging: { current: number; days30: number; days60: number; days90: number; days90Plus: number; total: number };
  grossProfit: number;
  netRevenue: number;
  gpMargin: number; // %
  /** Revenue from WOs where cost data is trustworthy (used as GP denominator). */
  revenueWithTrustedGP: number;
  /** % of period revenue that has trustworthy GP data populated. */
  gpCoveragePct: number;
  totalLeadFee: number;
  leadFeeRoi: number;
  totalDiscount: number;
  discountPctOfRevenue: number;
  totalCommission: number;
  commissionPctOfRevenue: number;
  topDiscounters: Array<{ ownerId: string; ownerName: string; discount: number }>;
  topGPContributors: Array<{ ownerId: string; ownerName: string; gp: number }>;
} {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);

  // AR aging is "right now" — not period-scoped. We sum balanceOwed across
  // open WOs and bucket by finalBalanceAging days.
  // Bug fix: WOs with null `finalBalanceAging` used to fall through to the
  // "current" bucket via `?? 0`. That overstates current AR. Now we use a
  // separate "unknown" bucket — the UI keeps the headline total honest but
  // the bucket breakdown only counts WOs where aging is actually populated.
  const arAging = { current: 0, days30: 0, days60: 0, days90: 0, days90Plus: 0, total: 0 };
  for (const w of snapshot.workOrders) {
    if (w.balanceOwed <= 0) continue;
    arAging.total += w.balanceOwed;
    const aging = w.finalBalanceAging;
    if (aging == null) continue; // bucket breakdown excludes unknown-aging
    if (aging < 30) arAging.current += w.balanceOwed;
    else if (aging < 60) arAging.days30 += w.balanceOwed;
    else if (aging < 90) arAging.days60 += w.balanceOwed;
    else if (aging < 120) arAging.days90 += w.balanceOwed;
    else arAging.days90Plus += w.balanceOwed;
  }

  // Period-scoped revenue + GP + lead-fee + discount + commission.
  let netRevenue = 0;
  let grossProfit = 0;
  let revenueWithTrustedGP = 0; // denominator for margin calc — only WOs where we trust the GP figure
  let totalLeadFee = 0;
  let totalDiscount = 0;
  let totalCommission = 0;
  const discountByRep = new Map<string, number>();
  const gpByRep = new Map<string, number>();
  const repNameLookup = new Map<string, string>();
  for (const r of snapshot.reps) repNameLookup.set(r.id, r.name);
  for (const w of snapshot.workOrders) {
    if (w.ownerId && w.ownerName) repNameLookup.set(w.ownerId, w.ownerName);
  }

  for (const w of snapshot.workOrders) {
    if (!isInRange(w.closeDate, periodStart, periodEnd)) continue;
    netRevenue += w.amount;
    totalCommission += w.commissionAmount;
    // Use trustworthy GP only — filters out WOs where cost wasn't entered
    // and Gross_Profit__c just defaults to the amount.
    const trueGp = trueGrossProfit(w.amount, w.costMaterials, w.totalPayoutsForLabor, w.grossProfit);
    if (trueGp) {
      grossProfit += trueGp.gp;
      revenueWithTrustedGP += w.amount;
      if (w.ownerId) {
        gpByRep.set(w.ownerId, (gpByRep.get(w.ownerId) ?? 0) + trueGp.gp);
      }
    }
  }
  for (const o of snapshot.opportunities) {
    if (!isInRange(o.closeDate, periodStart, periodEnd)) continue;
    totalLeadFee += o.leadFee;
    totalDiscount += o.discountGiven;
    if (o.ownerId) {
      discountByRep.set(o.ownerId, (discountByRep.get(o.ownerId) ?? 0) + o.discountGiven);
    }
  }

  const topDiscounters = Array.from(discountByRep.entries())
    .map(([ownerId, discount]) => ({ ownerId, ownerName: repNameLookup.get(ownerId) ?? "(unknown)", discount }))
    .filter((x) => x.discount > 0)
    .sort((a, b) => b.discount - a.discount)
    .slice(0, 5);

  const topGPContributors = Array.from(gpByRep.entries())
    .map(([ownerId, gp]) => ({ ownerId, ownerName: repNameLookup.get(ownerId) ?? "(unknown)", gp }))
    .filter((x) => x.gp > 0)
    .sort((a, b) => b.gp - a.gp)
    .slice(0, 5);

  return {
    arAging,
    grossProfit,
    netRevenue,
    // Margin computed only against revenue with trustworthy GP data — avoids
    // the "95% margin" illusion when many WOs have GP = amount (no cost data).
    gpMargin: revenueWithTrustedGP > 0 ? (grossProfit / revenueWithTrustedGP) * 100 : 0,
    revenueWithTrustedGP,
    gpCoveragePct: netRevenue > 0 ? (revenueWithTrustedGP / netRevenue) * 100 : 0,
    totalLeadFee,
    leadFeeRoi: totalLeadFee > 0 ? netRevenue / totalLeadFee : 0,
    totalDiscount,
    discountPctOfRevenue: netRevenue > 0 ? (totalDiscount / netRevenue) * 100 : 0,
    totalCommission,
    commissionPctOfRevenue: netRevenue > 0 ? (totalCommission / netRevenue) * 100 : 0,
    topDiscounters,
    topGPContributors,
  };
}

/* ─── Operations rollups ─── */

/**
 * Operations picture — labor utilization, materials, payout ratios.
 */
export function deriveOperations(
  snapshot: SalesforceSnapshot,
  period: Period = "this-month"
): {
  // Labor capacity (right now)
  totalLaborDaysRemaining: number;
  totalLaborDaysActual: number;
  totalLaborDaysProjected: number;
  utilizationPct: number; // actual / projected
  // Materials + payouts in period
  totalMaterialsCost: number;
  totalLaborPayout: number;
  laborPayoutRatio: number; // labor payout / revenue
  materialsRatio: number; // materials / revenue
  // Most over-running WOs
  overRuns: Array<{ id: string; workOrderNumber: string | null; account: string | null; projected: number; actual: number; overByDays: number }>;
  // Top GP-margin WOs (profitability outliers)
  topGPMargin: Array<{ id: string; workOrderNumber: string | null; account: string | null; revenue: number; gp: number; marginPct: number }>;
} {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);

  let totalLaborDaysRemaining = 0;
  let totalLaborDaysActual = 0;
  let totalLaborDaysProjected = 0;
  let totalMaterialsCost = 0;
  let totalLaborPayout = 0;
  let periodRevenue = 0;
  const overRuns: Array<{ id: string; workOrderNumber: string | null; account: string | null; projected: number; actual: number; overByDays: number }> = [];
  const gpMargin: Array<{ id: string; workOrderNumber: string | null; account: string | null; revenue: number; gp: number; marginPct: number }> = [];

  for (const w of snapshot.workOrders) {
    // Capacity (right now, not period-scoped — represents current state)
    totalLaborDaysRemaining += w.laborDaysRemaining ?? 0;

    const inPeriod = isInRange(w.closeDate, periodStart, periodEnd);
    if (inPeriod) {
      const proj = w.laborDaysProjected ?? 0;
      const act = w.laborDaysActual ?? 0;
      // Bug fix: only include WOs in utilization math when BOTH actual and
      // projected are populated. A WO with proj=0 actual=5 was inflating
      // total actual without contributing to projected → utilization > 100%
      // for the wrong reason.
      if (proj > 0 && act > 0) {
        totalLaborDaysActual += act;
        totalLaborDaysProjected += proj;
      }
      // Skip credits / refunds / WOs with $0 amount. A refund (amount=-5000,
      // materials=100) would otherwise contribute a junk positive ratio.
      if (w.amount > 0) {
        totalMaterialsCost += w.costMaterials;
        totalLaborPayout += w.totalPayoutsForLabor;
        periodRevenue += w.amount;
      }
      // Overrun candidate
      if (proj > 0 && act > proj) {
        overRuns.push({
          id: w.id,
          workOrderNumber: w.workOrderNumber,
          account: w.accountName,
          projected: proj,
          actual: act,
          overByDays: Math.round(act - proj),
        });
      }
      // Margin candidate — use the trustworthy GP calc so we don't surface
      // the "100% margin" WOs where cost data simply wasn't entered.
      const trueGp = trueGrossProfit(w.amount, w.costMaterials, w.totalPayoutsForLabor, w.grossProfit);
      if (trueGp) {
        gpMargin.push({
          id: w.id,
          workOrderNumber: w.workOrderNumber,
          account: w.accountName,
          revenue: w.amount,
          gp: trueGp.gp,
          marginPct: trueGp.marginPct,
        });
      }
    }
  }

  return {
    totalLaborDaysRemaining: Math.round(totalLaborDaysRemaining),
    totalLaborDaysActual: Math.round(totalLaborDaysActual),
    totalLaborDaysProjected: Math.round(totalLaborDaysProjected),
    utilizationPct: totalLaborDaysProjected > 0
      ? (totalLaborDaysActual / totalLaborDaysProjected) * 100
      : 0,
    totalMaterialsCost,
    totalLaborPayout,
    laborPayoutRatio: periodRevenue > 0 ? (totalLaborPayout / periodRevenue) * 100 : 0,
    materialsRatio: periodRevenue > 0 ? (totalMaterialsCost / periodRevenue) * 100 : 0,
    overRuns: overRuns.sort((a, b) => b.overByDays - a.overByDays).slice(0, 10),
    topGPMargin: gpMargin.sort((a, b) => b.marginPct - a.marginPct).slice(0, 10),
  };
}

/* ─── Real Pipeline Funnel from Quote data ─── */

/**
 * Real funnel: Leads (Opps Created) → Quotes Sent → Opps Won → WOs Created → Paid in Full.
 * Each step has count + total $ value where applicable.
 */
export function deriveRealFunnel(
  snapshot: SalesforceSnapshot,
  period: Period = "this-month"
): Array<{ stage: string; count: number; value: number; dropOffPct: number | null }> {
  const now = new Date();
  const { start: periodStart, end: periodEnd } = periodRange(period, now);

  let leads = 0;
  let leadsValue = 0;
  for (const o of snapshot.opportunities) {
    if (isInRange(o.createdDate, periodStart, periodEnd)) {
      leads += 1;
      leadsValue += o.amount;
    }
  }

  let quotesSent = 0;
  let quotesValue = 0;
  for (const q of snapshot.quotes) {
    if (isInRange(q.createdDate, periodStart, periodEnd)) {
      quotesSent += 1;
      quotesValue += q.grandTotal;
    }
  }

  let oppsWon = 0;
  let oppsWonValue = 0;
  for (const o of snapshot.opportunities) {
    if (isInRange(o.closeDate, periodStart, periodEnd) && o.isWon) {
      oppsWon += 1;
      oppsWonValue += o.amount;
    }
  }

  let wosCreated = 0;
  let wosValue = 0;
  let wosPaid = 0;
  let wosPaidValue = 0;
  for (const w of snapshot.workOrders) {
    // "WOs Created" — count WOs whose CreatedDate is in the period.
    // (Previously this used closeDate, which is the projected close on the
    // joined Opp — different semantic and wrong for this funnel stage.)
    if (isInRange(w.createdDate, periodStart, periodEnd)) {
      wosCreated += 1;
      wosValue += w.amount;
    }
    // "Paid in Full" — count WOs paid in the period (closeDate IS the right
    // anchor here since that's when the Opp finalized).
    if (isInRange(w.closeDate, periodStart, periodEnd) &&
        (w.status ?? "").toLowerCase().includes("paid in full")) {
      wosPaid += 1;
      wosPaidValue += w.amount;
    }
  }

  const stages = [
    { stage: "Leads", count: leads, value: Math.round(leadsValue / 1000) },
    { stage: "Quotes Sent", count: quotesSent, value: Math.round(quotesValue / 1000) },
    { stage: "Opps Won", count: oppsWon, value: Math.round(oppsWonValue / 1000) },
    { stage: "WOs Created", count: wosCreated, value: Math.round(wosValue / 1000) },
    { stage: "Paid in Full", count: wosPaid, value: Math.round(wosPaidValue / 1000) },
  ];

  return stages.map((s, i) => {
    const prev = stages[i - 1];
    const dropOffPct = prev && prev.count > 0
      ? Math.round(((prev.count - s.count) / prev.count) * 100)
      : null;
    return { ...s, dropOffPct };
  });
}

/* ─── Per-rep account stats ─── */

/**
 * For a rep, count their distinct customers + how many are repeat customers,
 * plus total lifetime revenue across the accounts they own deals with. Pulled
 * from Account snapshot (PPP-populated fields). Surfaces on the rep profile
 * page so the cards stop being just "$X revenue" and start telling a story.
 */
export function deriveRepAccountStats(
  snapshot: SalesforceSnapshot,
  repId: string
): {
  totalCustomers: number;
  repeatCustomers: number;
  newCustomers: number;
  totalLifetimeRevenue: number;
  bmRetailerCount: number;
  topAccountName: string | null;
  topAccountRevenue: number;
} {
  // ID-first index + name fallback. Two Accounts can share a Name (e.g.
  // two unrelated "John Smith" customers); aggregating by name would merge
  // their revenue and over-count repeats. Match by Account.Id when the WO
  // carries one; fall back to name for legacy data.
  const acctById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const acctByName = new Map(snapshot.accounts.map((a) => [a.name, a]));
  const seenAccountIds = new Set<string>();

  // Resolve a WO/Opp to its canonical Account.Id (preferred) or a synthetic
  // "name::<n>" key as a last-resort so name-only rows still aggregate per
  // distinct account name without colliding into the ID-based bucket.
  const resolveKey = (
    row: { accountId: string | null; accountName: string | null }
  ): string | null => {
    if (row.accountId) return row.accountId;
    if (row.accountName) {
      const byName = acctByName.get(row.accountName);
      return byName?.id ?? `name::${row.accountName}`;
    }
    return null;
  };

  // Accumulate revenue per account (across this rep's WOs).
  const accountRevenue = new Map<string, number>();
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    const key = resolveKey(w);
    if (!key) continue;
    seenAccountIds.add(key);
    accountRevenue.set(key, (accountRevenue.get(key) ?? 0) + w.amount);
  }
  // Also walk opps in case some don't have WOs yet.
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    const key = resolveKey(o);
    if (!key) continue;
    seenAccountIds.add(key);
  }

  let repeat = 0;
  let bmRetailer = 0;
  let lifetimeRev = 0;
  for (const key of seenAccountIds) {
    const a = acctById.get(key);
    if (!a) continue;
    if ((a.type ?? "").toLowerCase().includes("repeat")) repeat += 1;
    if (a.isBMRetailer) bmRetailer += 1;
    lifetimeRev += a.totalLifetimeRevenue;
  }

  // Top account by this rep's revenue contribution. Keys are Account.Ids
  // (or "name::<n>" synthetic keys for legacy rows). Resolve to a display
  // name for the UI.
  let topAccountName: string | null = null;
  let topAccountRevenue = 0;
  for (const [key, rev] of accountRevenue.entries()) {
    if (rev > topAccountRevenue) {
      topAccountRevenue = rev;
      const acct = acctById.get(key);
      topAccountName = acct?.name ?? (key.startsWith("name::") ? key.slice(6) : key);
    }
  }

  return {
    totalCustomers: seenAccountIds.size,
    repeatCustomers: repeat,
    newCustomers: seenAccountIds.size - repeat,
    totalLifetimeRevenue: lifetimeRev,
    bmRetailerCount: bmRetailer,
    topAccountName,
    topAccountRevenue,
  };
}

/* ─── Per-rep recent deals (8 most recent) ─── */

/**
 * Recent CLOSED deals for a rep — strictly past close date + a status that
 * indicates closure (Paid in Full / Complete / Cancelled). This is the "what
 * have you actually won" view. Future-dated unpriced appointments don't
 * belong here — those go in `deriveRepUpcomingWork`.
 */
export function deriveRepRecentDeals(
  snapshot: SalesforceSnapshot,
  repId: string
): Deal[] {
  // Prefer WO rows (PPP's report unit) so we get the WO number + status the
  // user expects. Fall back to opps when no WO data is present.
  if (snapshot.workOrders.length > 0) {
    // Build an Opp lookup so we can fall back to Opp.amount on WOs where
    // NetValue and QuotedSubtotal are both $0 (very old WOs with stale data).
    const oppById = new Map(snapshot.opportunities.map((o) => [o.id, o]));
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    const ownerWOs = snapshot.workOrders
      .filter((w) => w.ownerId === repId)
      // STRICT closed filter: close date is past AND status reads "closed".
      .filter((w) => {
        if (!w.closeDate || w.closeDate > today) return false;
        const s = (w.status ?? "").toLowerCase();
        return (
          s.includes("paid in full") ||
          s.includes("complete") ||
          s.includes("closed") ||
          s.includes("cancel") ||
          s.includes("balance owed")
        );
      })
      .sort((a, b) => (b.closeDate ?? "").localeCompare(a.closeDate ?? ""))
      .slice(0, 8);

    return ownerWOs.map((w) => {
      let resolved = w.amount;
      if (resolved === 0 && w.opportunityId) {
        const opp = oppById.get(w.opportunityId);
        if (opp && opp.amount > 0) resolved = opp.amount;
      }
      return {
        id: w.id,
        customer: w.accountName ?? "(Account)",
        amount: +(resolved / 1000).toFixed(1),
        stage: woStatusBucket(w.status),
        closedAt: w.closeDate,
        daysInStage: daysSince(w.closeDate ?? w.createdDate),
        workOrderNumber: w.workOrderNumber,
        status: w.status,
      } as Deal & {
        workOrderNumber: string | null;
        status: string | null;
      };
    });
  }

  const ownerOpps = snapshot.opportunities
    .filter((o) => o.ownerId === repId && o.isClosed)
    .sort((a, b) => (b.closeDate ?? "").localeCompare(a.closeDate ?? ""))
    .slice(0, 8);

  return ownerOpps.map((o) => ({
    id: o.id,
    customer: o.accountName ?? "(Account)",
    amount: +(o.amount / 1000).toFixed(1),
    stage: stageBucket(o),
    closedAt: o.closeDate,
    daysInStage: 0,
  }));
}

/**
 * Upcoming work for a rep — WOs with a future close date (or no close date yet)
 * that aren't yet closed. The "what's on your calendar / what's coming up" view.
 * Sorted soonest first. Falls back to parent Opp.amount when the WO is unpriced.
 */
export function deriveRepUpcomingWork(
  snapshot: SalesforceSnapshot,
  repId: string
): Deal[] {
  if (snapshot.workOrders.length === 0) return [];

  const oppById = new Map(snapshot.opportunities.map((o) => [o.id, o]));
  const today = new Date().toISOString().split("T")[0];

  const upcoming = snapshot.workOrders
    .filter((w) => w.ownerId === repId)
    .filter((w) => {
      // Future close date (or no close date), and not already closed.
      const inFuture = !w.closeDate || w.closeDate >= today;
      if (!inFuture) return false;
      const s = (w.status ?? "").toLowerCase();
      // Match the same closed-status set as deriveRepRecentDeals — without
      // "closed" / "balance owed" here, a "Closed Lost" WO with a future
      // close date would slip into Upcoming Work (PPP's Closed Lost stage
      // sometimes carries a future close date when the lead was logged ahead).
      if (
        s.includes("paid in full") ||
        s.includes("complete") ||
        s.includes("cancel") ||
        s.includes("closed") ||
        s.includes("balance owed")
      ) return false;
      // Katie 2026-05-29: Upcoming Work should show real upcoming JOBS, not
      // Estimate / Appointment work orders (those exist on every opp pre-quote
      // and aren't scheduled paint work).
      const wt = (w.workTypeName ?? "").toLowerCase();
      if (
        wt.includes("estimate") ||
        wt.includes("appointment") ||
        wt.includes("inspection") ||
        wt.includes("consultation")
      ) return false;
      return true;
    })
    .sort((a, b) => {
      // Soonest first; null close dates go to the end.
      if (!a.closeDate && !b.closeDate) return 0;
      if (!a.closeDate) return 1;
      if (!b.closeDate) return -1;
      return a.closeDate.localeCompare(b.closeDate);
    })
    .slice(0, 8);

  return upcoming.map((w) => {
    let resolved = w.amount;
    if (resolved === 0 && w.opportunityId) {
      const opp = oppById.get(w.opportunityId);
      if (opp && opp.amount > 0) resolved = opp.amount;
    }
    return {
      id: w.id,
      customer: w.accountName ?? "(Account)",
      amount: +(resolved / 1000).toFixed(1),
      stage: woStatusBucket(w.status),
      closedAt: w.closeDate, // future date here — UI labels it differently
      daysInStage: daysSince(w.createdDate),
      workOrderNumber: w.workOrderNumber,
      status: w.status,
    } as Deal & {
      workOrderNumber: string | null;
      status: string | null;
    };
  });
}

/**
 * Recently Sent Quotes (Katie 2026-05-29) — companion window to Upcoming Work.
 * The rep's OPEN opportunities that have an estimate sent, ordered by most
 * recent Estimate Sent date. This is the rep's "quotes out / awaiting a
 * decision" follow-up list. Won/lost opps drop off (the quote was decided).
 */
export function deriveRepRecentlySentQuotes(
  snapshot: SalesforceSnapshot,
  repId: string
): Array<Deal & { workOrderNumber: string | null; status: string | null }> {
  if (snapshot.opportunities.length === 0) return [];

  const sent = snapshot.opportunities
    .filter((o) => o.ownerId === repId)
    .filter((o) => !o.isClosed)              // still pending a decision
    .filter((o) => o.estimateSent && !!o.dateEstimateSent)
    .sort((a, b) => (b.dateEstimateSent ?? "").localeCompare(a.dateEstimateSent ?? ""))
    .slice(0, 8);

  return sent.map((o) => {
    const dollars = o.quotedSubtotal > 0 ? o.quotedSubtotal : o.amount;
    return {
      id: o.id,
      customer: o.accountName ?? "(Account)",
      amount: +(dollars / 1000).toFixed(1),
      stage: stageBucket(o),
      closedAt: o.dateEstimateSent, // estimate-sent date — UI labels it "Quote sent"
      daysInStage: daysSince(o.dateEstimateSent ?? o.createdDate),
      workOrderNumber: null,
      status: o.stageName,
    };
  });
}

/** Map PPP's custom WO statuses to our Deal["stage"] union. */
function woStatusBucket(status: string | null): Deal["stage"] {
  if (!status) return "Quoted";
  const s = status.toLowerCase();
  if (s.includes("paid in full") || s.includes("balance owed") || s.includes("closed")) return "Closed Won";
  if (s.includes("canceled") || s.includes("cancelled")) return "Closed Lost";
  if (s.includes("coordination") || s.includes("scheduled")) return "Appointment";
  return "Quoted";
}

function stageBucket(o: SnapshotOpp): Deal["stage"] {
  if (o.isClosed && o.isWon) return "Closed Won";
  if (o.isClosed && !o.isWon) return "Closed Lost";
  const stage = o.stageName.toLowerCase();
  if (stage.includes("appointment") || stage.includes("assigned")) return "Appointment";
  return "Quoted";
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
