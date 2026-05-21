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
    const accountByName = new Map(snapshot.accounts.map((a) => [a.name, a]));
    const regionCounts = new Map<string, number>();
    for (const w of snapshot.workOrders) {
      if (w.ownerId !== rep.id) continue;
      const acct = w.accountName ? accountByName.get(w.accountName) : null;
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
    if (!row.ownerId || row.amount <= 0) continue;
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

  // Close Rate is derived from Opp data, NOT WO data. An Opp is
  //   - "closed" when isClosed=true (SF Stage marked Closed Won or Closed Lost)
  //   - "won" when isWon=true
  // closeRate = won / closed (or 0 if no closed in period).
  // Using WO data here would give 100% always — every WO that exists is "won"
  // (no WO is created for a deal that was never won).
  for (const o of snapshot.opportunities) {
    if (!o.ownerId || !o.isClosed) continue;
    if (!isInRange(o.closeDate, periodStart, periodEnd)) continue;
    const a = byOwner.get(o.ownerId) ?? initStats();
    a.closed += 1;
    a.total += 1;
    if (o.isWon) a.won += 1;
    byOwner.set(o.ownerId, a);
  }

  // Also count opps CREATED in period (for activity volume — drives
  // appointmentsHeld / quotesSent proxies, separate from closed counts).
  for (const o of snapshot.opportunities) {
    if (!o.ownerId) continue;
    if (!isInRange(o.createdDate, periodStart, periodEnd)) continue;
    if (o.isClosed && isInRange(o.closeDate, periodStart, periodEnd)) continue; // already counted above
    const a = byOwner.get(o.ownerId) ?? initStats();
    a.total += 1;
    byOwner.set(o.ownerId, a);
  }

  // Open pipeline = currently-open opps without an attached WO.
  const oppsWithWO = new Set(
    snapshot.workOrders.map((w) => w.opportunityId).filter(Boolean)
  );
  for (const o of snapshot.opportunities) {
    if (o.isClosed) continue;
    if (oppsWithWO.has(o.id)) continue;
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
    };
  });

  // Surface orphan owners — users who own revenue-bearing WOs but aren't in
  // our canonical rep filter (e.g., admin profiles that still own deals). We
  // resolve their name from the WO join data so they get a proper card.
  const canonicalIds = new Set(snapshot.reps.map((r) => r.id));
  const ownerNameLookup = new Map<string, string>();
  for (const w of snapshot.workOrders) {
    if (w.ownerId && w.ownerName) ownerNameLookup.set(w.ownerId, w.ownerName);
  }
  for (const [ownerId, a] of byOwner.entries()) {
    if (canonicalIds.has(ownerId)) continue;
    if (a.wonRevenue === 0 && a.openPipeline === 0) continue;
    const closeRate = a.closed > 0 ? (a.won / a.closed) * 100 : 0;
    const avgTicket = a.ticketCount > 0 ? a.ticketSum / a.ticketCount : 0;
    cards.push({
      id: ownerId,
      name: ownerNameLookup.get(ownerId) ?? ownerId,
      region: "Unassigned",
      serviceLine: "Residential",
      revenueSold: Math.round(a.wonRevenue / 1000),
      closeRate: +closeRate.toFixed(1),
      avgTicket: +(avgTicket / 1000).toFixed(1),
      openPipeline: Math.round(a.openPipeline / 1000),
      daysAvgClose: a.daysToCloseCount > 0
        ? Math.round(a.daysToCloseSum / a.daysToCloseCount)
        : 0,
      appointmentsHeld: a.total,
      quotesSent: a.total,
      startedAt: new Date().toISOString().split("T")[0],
    });
  }

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
      if (row.amount <= 0 || !row.closeDate) continue;
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
    if (row.amount <= 0 || !row.closeDate) continue;
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
    if (row.amount <= 0 || !row.closeDate) continue;
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
  const acctIndex = new Map(snapshot.accounts.map((a) => [a.name, a]));
  const seenAccountNames = new Set<string>();

  // Accumulate revenue per account (across this rep's WOs).
  const accountRevenue = new Map<string, number>();
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!w.accountName) continue;
    seenAccountNames.add(w.accountName);
    accountRevenue.set(
      w.accountName,
      (accountRevenue.get(w.accountName) ?? 0) + w.amount
    );
  }
  // Also walk opps in case some don't have WOs yet.
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.accountName) continue;
    seenAccountNames.add(o.accountName);
  }

  let repeat = 0;
  let bmRetailer = 0;
  let lifetimeRev = 0;
  for (const name of seenAccountNames) {
    const a = acctIndex.get(name);
    if (!a) continue;
    if ((a.type ?? "").toLowerCase().includes("repeat")) repeat += 1;
    if (a.isBMRetailer) bmRetailer += 1;
    lifetimeRev += a.totalLifetimeRevenue;
  }

  // Top account by this rep's revenue contribution.
  let topAccountName: string | null = null;
  let topAccountRevenue = 0;
  for (const [name, rev] of accountRevenue.entries()) {
    if (rev > topAccountRevenue) {
      topAccountRevenue = rev;
      topAccountName = name;
    }
  }

  return {
    totalCustomers: seenAccountNames.size,
    repeatCustomers: repeat,
    newCustomers: seenAccountNames.size - repeat,
    totalLifetimeRevenue: lifetimeRev,
    bmRetailerCount: bmRetailer,
    topAccountName,
    topAccountRevenue,
  };
}

/* ─── Per-rep recent deals (8 most recent) ─── */

export function deriveRepRecentDeals(
  snapshot: SalesforceSnapshot,
  repId: string
): Deal[] {
  // Prefer WO rows (PPP's report unit) so we get the WO number + status the
  // user expects. Fall back to opps when no WO data is present.
  if (snapshot.workOrders.length > 0) {
    const ownerWOs = snapshot.workOrders
      .filter((w) => w.ownerId === repId)
      .sort((a, b) => {
        const ad = a.closeDate ?? a.createdDate;
        const bd = b.closeDate ?? b.createdDate;
        return bd.localeCompare(ad);
      })
      .slice(0, 8);

    return ownerWOs.map((w) => ({
      id: w.id,
      customer: w.accountName ?? "(Account)",
      amount: +(w.amount / 1000).toFixed(1),
      stage: woStatusBucket(w.status),
      closedAt: w.closeDate,
      daysInStage: daysSince(w.closeDate ?? w.createdDate),
      // Extra metadata the UI can surface (cast widens Deal at usage sites).
      workOrderNumber: w.workOrderNumber,
      status: w.status,
      quotedSubtotal: +(w.quotedSubtotal / 1000).toFixed(1),
      netValue: +(w.netValue / 1000).toFixed(1),
    }) as Deal & {
      workOrderNumber: string | null;
      status: string | null;
      quotedSubtotal: number;
      netValue: number;
    });
  }

  const ownerOpps = snapshot.opportunities
    .filter((o) => o.ownerId === repId)
    .sort((a, b) => {
      const ad = (a.closeDate ?? a.createdDate);
      const bd = (b.closeDate ?? b.createdDate);
      return bd.localeCompare(ad);
    })
    .slice(0, 8);

  return ownerOpps.map((o) => ({
    id: o.id,
    customer: o.accountName ?? "(Account)",
    amount: +(o.amount / 1000).toFixed(1),
    stage: stageBucket(o),
    closedAt: o.isClosed ? o.closeDate : null,
    daysInStage: o.isClosed ? 0 : daysSince(o.lastActivityDate ?? o.createdDate),
  }));
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
