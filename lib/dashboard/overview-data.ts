import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import {
  deriveCompanyTrend,
  derivePeriodDelta,
  derivePipelineAtRisk,
  deriveRepsForPeriod,
  deriveTopPerformer,
  deriveTodaySnapshot,
  deriveMonthForecast,
  deriveTopCustomers,
  deriveQuoteToCashVelocity,
  deriveRepMomentum,
  deriveRealFunnel,
} from "@/lib/salesforce/derive";
import type { Period, Rep } from "@/lib/mock-data";
import { ALL_PERIODS } from "@/lib/dashboard/periods";

/**
 * THE OVERVIEW'S NUMBERS, DERIVED ON THE SERVER.
 *
 * Measured against production on 2026-10-16, from a phone:
 *
 *     /dashboard             63.8 MB   12.5 s
 *     /dashboard/financials  63.6 MB   12.0 s
 *     /dashboard/rep         63.7 MB    6.4 s
 *     /dashboard/operations  35.1 MB    4.7 s
 *     /dashboard/map         35.1 MB    3.2 s
 *     /dashboard/materials    4.5 MB    1.6 s
 *
 * Time to first byte was 200ms on every one of them. The server was never
 * slow. `page.tsx` handed the whole Salesforce snapshot to `<DashboardView>`,
 * which is a "use client" component — so React serialized every row of it
 * into the HTML for hydration. The string `quotedSubtotal` appeared 36,885
 * times in the document and `workOrderNumber` 20,192 times. Alex opens this
 * on his phone every morning.
 *
 * Materials was already 4.5MB because it reads a pre-derived bundle. That is
 * the shape of the fix, applied here: the client receives the ANSWERS, not
 * the data they were computed from.
 *
 * What deliberately still ships to the browser, and why:
 *
 *   reps              ~26 rows. The compact intermediate that keeps REGION
 *                     filtering INSTANT — getFilteredView, the region
 *                     options and the weighted company KPIs are all pure
 *                     functions of this, so narrowing to Nassau still costs
 *                     no round trip.
 *   funnelByPeriod    the funnel for all 11 periods, ~4 stages each. The
 *                     funnel's own period selector is local state and is the
 *                     one control not mirrored in the URL, so precomputing
 *                     the whole set keeps it instant rather than forcing a
 *                     navigation or a URL change users would see.
 *   customerPulse     keyed per region, five rows each, for the same
 *     ByRegion        reason: every other card on the page re-scopes the
 *                     instant the dropdown moves, so this one must too.
 *
 * Everything else is keyed to `period`, which is already URL-synced — so the
 * server already knows it, and a period change was ALREADY re-rendering this
 * page. It was just re-sending 64MB to do it.
 */
export type OverviewData = {
  /** True when these numbers came from Salesforce rather than mock data. */
  isLive: true;
  isSandbox: boolean;
  workOrderCount: number;
  /** Live, but the viewer's scope has nothing in it — drives the honest
   *  empty state instead of a page of zeros. */
  isEmpty: boolean;

  reps: Rep[];
  trendSeries: ReturnType<typeof deriveCompanyTrend>["series"];
  revenueKpi: ReturnType<typeof derivePeriodDelta>;
  conversionRate: number | null;
  topPerformer: ReturnType<typeof deriveTopPerformer>;
  pipelineAtRisk: ReturnType<typeof derivePipelineAtRisk>;
  todaySnap: ReturnType<typeof deriveTodaySnapshot>;
  forecast: ReturnType<typeof deriveMonthForecast>;
  topCustomers: ReturnType<typeof deriveTopCustomers>;
  velocity: ReturnType<typeof deriveQuoteToCashVelocity>;
  customerPulseByRegion: Record<string, PulseRow[]>;
  hotReps: HotRep[];
  funnelByPeriod: Record<string, FunnelStage[]>;
};

export type PulseRow = {
  id: string;
  name: string;
  lifetimeRevenue: number;
  monthsSince: number;
  lastWorkOrderCompleted: string;
};

export type HotRep = {
  id: string;
  name: string;
  thisWeekK: number;
  deltaPct: number;
};

export type FunnelStage = { stage: string; count: number; value: number };

// The canonical list lives in ./periods — every dashboard view that keeps a
// period dropdown instant off a server-precomputed map reads the same one.
export {
  ALL_PERIODS as OVERVIEW_PERIODS,
  DEFAULT_PERIOD as OVERVIEW_DEFAULT_PERIOD,
  readPeriod,
} from "@/lib/dashboard/periods";

const TWELVE_MONTHS_MS = 365 * 86_400_000;

/**
 * Dormant high-value accounts — the top five for EVERY region, plus "all".
 *
 * Keyed by region rather than derived for the current one so changing the
 * region dropdown stays instant. The region filter already re-renders this
 * page server-side (it is URL-synced), so deriving only the selected region
 * would have left this one card trailing the dropdown by a round trip while
 * every other card on the page updated immediately. There are a handful of
 * regions and five rows each, so the whole map is smaller than the single
 * unfiltered list it replaces.
 *
 * The scan itself is lifted verbatim from the client component it replaced,
 * so the numbers cannot drift between the two.
 */
function deriveCustomerPulseByRegion(
  snapshot: SalesforceSnapshot
): Record<string, PulseRow[]> {
  const now = Date.now();
  const all: PulseRow[] = [];
  const byRegion = new Map<string, PulseRow[]>();

  for (const a of snapshot.accounts) {
    if (a.totalLifetimeRevenue <= 0) continue;
    if (!a.lastWorkOrderCompleted) continue;
    const last = new Date(a.lastWorkOrderCompleted).getTime();
    if (isNaN(last)) continue;
    const ageMs = now - last;
    if (ageMs < TWELVE_MONTHS_MS) continue;
    const row: PulseRow = {
      id: a.id,
      name: a.name,
      lifetimeRevenue: a.totalLifetimeRevenue,
      monthsSince: Math.round(ageMs / (30 * 86_400_000)),
      lastWorkOrderCompleted: a.lastWorkOrderCompleted,
    };
    all.push(row);
    // Accounts without a region tag count toward "all" but are excluded
    // from any filtered view — we can't confidently place them.
    if (a.region) {
      const bucket = byRegion.get(a.region);
      if (bucket) bucket.push(row);
      else byRegion.set(a.region, [row]);
    }
  }

  const topFive = (rows: PulseRow[]) =>
    rows.sort((x, y) => y.lifetimeRevenue - x.lifetimeRevenue).slice(0, 5);

  const out: Record<string, PulseRow[]> = { all: topFive(all) };
  for (const [region, rows] of byRegion) out[region] = topFive(rows);
  return out;
}

function deriveHotReps(snapshot: SalesforceSnapshot): HotRep[] {
  const momentum = deriveRepMomentum(snapshot);
  const ownerNameLookup = new Map<string, string>();
  for (const r of snapshot.reps) ownerNameLookup.set(r.id, r.name);
  for (const w of snapshot.workOrders) {
    if (w.ownerId && w.ownerName) ownerNameLookup.set(w.ownerId, w.ownerName);
  }
  return Array.from(momentum.entries())
    // Require meaningful revenue (≥ $1K this week) so we don't surface a
    // "$0.001K trending +infinity%" mirage when a tiny deal closes.
    .filter(([, m]) => m.thisWeek >= 1000)
    .map(([ownerId, m]) => ({
      id: ownerId,
      name: ownerNameLookup.get(ownerId) ?? "(unknown)",
      thisWeekK: Math.round(m.thisWeek / 1000),
      deltaPct: m.deltaPct,
    }))
    .sort((a, b) => b.thisWeekK - a.thisWeekK)
    .slice(0, 5);
}

export function deriveOverviewData(
  snapshot: SalesforceSnapshot,
  period: Period
): OverviewData {
  const funnelByPeriod: Record<string, FunnelStage[]> = {};
  for (const p of ALL_PERIODS) {
    funnelByPeriod[p] = deriveRealFunnel(snapshot, p).map((s) => ({
      stage: s.stage,
      count: s.count,
      value: s.value,
    }));
  }

  return {
    isLive: true,
    isSandbox: !!snapshot.isSandbox,
    workOrderCount: snapshot.workOrders.length,
    isEmpty:
      (snapshot.reps?.length ?? 0) === 0 &&
      (snapshot.workOrders?.length ?? 0) === 0 &&
      (snapshot.opportunities?.length ?? 0) === 0,

    reps: deriveRepsForPeriod(snapshot, period),
    trendSeries: deriveCompanyTrend(snapshot, period).series,
    revenueKpi: derivePeriodDelta(snapshot, period),
    conversionRate:
      snapshot.leadStats && snapshot.leadStats.total > 0
        ? (snapshot.leadStats.converted / snapshot.leadStats.total) * 100
        : null,
    topPerformer: deriveTopPerformer(snapshot, period),
    pipelineAtRisk: derivePipelineAtRisk(snapshot),
    todaySnap: deriveTodaySnapshot(snapshot),
    forecast: deriveMonthForecast(snapshot),
    topCustomers: deriveTopCustomers(snapshot, 8),
    velocity: deriveQuoteToCashVelocity(snapshot),
    customerPulseByRegion: deriveCustomerPulseByRegion(snapshot),
    hotReps: deriveHotReps(snapshot),
    funnelByPeriod,
  };
}
