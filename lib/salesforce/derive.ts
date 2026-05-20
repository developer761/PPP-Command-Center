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
} from "@/lib/salesforce/queries";
import type {
  Deal,
  Period,
  Rep,
  RepMonthlyPoint,
  SeriesPoint,
} from "@/lib/mock-data";

/* ─── Period helpers ─── */

export const PERIOD_DAYS: Record<Period, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 180,
  "12m": 365,
  ytd: 0, // computed dynamically
};

function startOfPeriod(period: Period, now: Date = new Date()): Date {
  if (period === "ytd") {
    return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  }
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - PERIOD_DAYS[period]);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function priorPeriodStart(period: Period, now: Date = new Date()): { from: Date; to: Date } {
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

export function deriveRegion(rep: SnapshotRep): Rep["region"] {
  const probe = `${rep.roleName ?? ""} ${rep.department ?? ""}`.toLowerCase();
  if (probe.includes("suffolk")) return "Suffolk";
  if (probe.includes("nassau")) return "Nassau";
  if (probe.includes("queens")) return "Queens";
  if (probe.includes("brooklyn")) return "Brooklyn";
  return "Suffolk"; // default — refine when we know PPP's actual region field
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
  const periodStart = startOfPeriod(period, now);
  const periodEnd = now;

  // Group opps by owner, only counting those touching the period window.
  // "Touching" = closedDate in range (for won/closed) OR createdDate in range (for open).
  const byOwner = new Map<string, {
    total: number;
    closed: number;
    won: number;
    wonRevenue: number;
    openPipeline: number;
    daysToCloseSum: number;
    daysToCloseCount: number;
    ticketSum: number;
    ticketCount: number;
  }>();

  // PPP's revenue model — IMPORTANT:
  //
  // PPP uses custom Stage values ("Coordination", "Work In Progress", "On Hold",
  // "Complete Paid in Full", "Complete Balance Owed", "Closed"). Many of these
  // are flagged IsClosed=false even though they have Net Value populated and
  // appear in PPP's "Opportunities with Work Orders" report.
  //
  // The PPP report defines revenue as: SUM(Net_Value__c) across opps whose
  // CloseDate is in the period — regardless of IsWon/IsClosed. Any opp with a
  // populated Net Value has been committed (it's already attached to a Work
  // Order). We match that definition here so the dashboard total reconciles to
  // the report total ($1.26M lifetime).
  for (const o of snapshot.opportunities) {
    const hasCommittedRevenue = o.amount > 0; // populated Net_Value/Quoted_Subtotal = committed
    const closedInPeriod = isInRange(o.closeDate, periodStart, periodEnd);
    const createdInPeriod = isInRange(o.createdDate, periodStart, periodEnd);
    const stillOpen = !o.isClosed && !hasCommittedRevenue; // truly-open = no WO yet

    // Skip opps that have no period activity AND aren't currently open.
    if (!closedInPeriod && !createdInPeriod && !stillOpen) continue;

    const a = byOwner.get(o.ownerId) ?? {
      total: 0, closed: 0, won: 0, wonRevenue: 0, openPipeline: 0,
      daysToCloseSum: 0, daysToCloseCount: 0, ticketSum: 0, ticketCount: 0,
    };

    if (closedInPeriod || createdInPeriod) a.total += 1;

    if (closedInPeriod && hasCommittedRevenue) {
      // Counts as a "won" deal in PPP's model — Net Value committed within the
      // period. Drives Revenue Sold, Avg Ticket, Close Rate numerator.
      a.closed += 1;
      a.won += 1;
      a.wonRevenue += o.amount;
      a.ticketSum += o.amount;
      a.ticketCount += 1;
      if (o.closeDate) {
        const created = new Date(o.createdDate).getTime();
        const closed = new Date(o.closeDate).getTime();
        if (!isNaN(created) && !isNaN(closed)) {
          a.daysToCloseSum += Math.max(0, Math.round((closed - created) / 86_400_000));
          a.daysToCloseCount += 1;
        }
      }
    } else if (closedInPeriod && o.isClosed && !hasCommittedRevenue) {
      // Closed without Net Value = closed-lost. Drives Close Rate denominator.
      a.closed += 1;
    }

    // Open pipeline = opps not yet committed (no Net Value, not closed).
    // Once an opp gets a Work Order (Net Value populated) it's already booked
    // revenue per PPP's model — not pipeline.
    if (stillOpen) a.openPipeline += o.amount;
    byOwner.set(o.ownerId, a);
  }

  return snapshot.reps.map((u) => {
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
      region: deriveRegion(u),
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
  const periodStart = startOfPeriod(period, now);
  const granularity: "daily" | "monthly" =
    period === "7d" || period === "30d" ? "daily" : "monthly";

  const buckets = new Map<
    string,
    { revenue: number; deals: number; byRegion: Map<string, number>; byRep: Map<string, number> }
  >();

  // Quick rep id → region/name lookup
  const repInfo = new Map<string, { name: string; region: string }>();
  for (const r of snapshot.reps) {
    repInfo.set(r.id, { name: r.name, region: deriveRegion(r) });
  }

  for (const o of snapshot.opportunities) {
    // PPP revenue model: count any opp with Net Value > 0 whose CloseDate is
    // in the period, regardless of IsWon. Matches their "Opportunities with
    // Work Orders" report definition.
    if (o.amount <= 0 || !o.closeDate) continue;
    const closed = new Date(o.closeDate + "T00:00:00Z");
    if (closed < periodStart) continue;
    const key = granularity === "daily"
      ? bucketStartDaily(o.closeDate)
      : bucketStartMonthly(o.closeDate);
    const b = buckets.get(key) ?? {
      revenue: 0,
      deals: 0,
      byRegion: new Map(),
      byRep: new Map(),
    };
    b.revenue += o.amount;
    b.deals += 1;
    const info = repInfo.get(o.ownerId);
    if (info) {
      b.byRegion.set(info.region, (b.byRegion.get(info.region) ?? 0) + o.amount);
      b.byRep.set(info.name, (b.byRep.get(info.name) ?? 0) + o.amount);
    }
    buckets.set(key, b);
  }

  // Generate continuous bucket range so empty days/months render zero (not gap)
  const series: SeriesPoint[] = [];
  if (granularity === "daily") {
    const cursor = new Date(periodStart);
    while (cursor <= now) {
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
    const cursor = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
  const periodStart = startOfPeriod(period, now);
  const prior = priorPeriodStart(period, now);

  let current = 0;
  let priorTotal = 0;
  for (const o of snapshot.opportunities) {
    // PPP revenue model: any opp with Net Value > 0 + CloseDate in window.
    if (o.amount <= 0 || !o.closeDate) continue;
    const closed = new Date(o.closeDate + "T00:00:00Z");
    if (closed >= periodStart && closed <= now) current += o.amount;
    else if (closed >= prior.from && closed < prior.to) priorTotal += o.amount;
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

  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.closeDate) continue;
    const closed = new Date(o.closeDate + "T00:00:00Z");
    if (closed < earliest) continue;
    const key = bucketStartMonthly(o.closeDate);
    const b = buckets.get(key) ?? { revenue: 0, closeCnt: 0, wonCnt: 0, ticketSum: 0, ticketCount: 0 };
    b.closeCnt += 1;
    // PPP revenue model: any opp with Net Value > 0 counts as "won".
    if (o.amount > 0) {
      b.wonCnt += 1;
      b.revenue += o.amount;
      b.ticketSum += o.amount;
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

/* ─── Per-rep recent deals (8 most recent) ─── */

export function deriveRepRecentDeals(
  snapshot: SalesforceSnapshot,
  repId: string
): Deal[] {
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
