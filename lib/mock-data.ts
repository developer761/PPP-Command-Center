// Mock Salesforce-shaped data. Replaced with live SF queries when access lands.
// All values are deterministic (no Math.random at module scope) so SSR + client render match.

export type Rep = {
  id: string;
  name: string;
  region: "Suffolk" | "Nassau" | "Queens" | "Brooklyn";
  serviceLine: "Residential" | "Commercial";
  revenueSold: number; // $K — last 30 days
  closeRate: number; // %
  avgTicket: number; // $K
  openPipeline: number; // $K
  daysAvgClose: number;
  appointmentsHeld: number;
  quotesSent: number;
  startedAt: string; // ISO date — for tenure display
};

export const reps: Rep[] = [
  {
    id: "rep_001",
    name: "Mike Chen",
    region: "Suffolk",
    serviceLine: "Residential",
    revenueSold: 142,
    closeRate: 42.3,
    avgTicket: 12.4,
    openPipeline: 84,
    daysAvgClose: 11,
    appointmentsHeld: 38,
    quotesSent: 27,
    startedAt: "2022-03-14",
  },
  {
    id: "rep_002",
    name: "Sarah Rodriguez",
    region: "Nassau",
    serviceLine: "Residential",
    revenueSold: 128,
    closeRate: 38.1,
    avgTicket: 11.2,
    openPipeline: 72,
    daysAvgClose: 13,
    appointmentsHeld: 34,
    quotesSent: 29,
    startedAt: "2021-08-02",
  },
  {
    id: "rep_003",
    name: "David Park",
    region: "Suffolk",
    serviceLine: "Commercial",
    revenueSold: 211,
    closeRate: 29.4,
    avgTicket: 28.1,
    openPipeline: 156,
    daysAvgClose: 22,
    appointmentsHeld: 22,
    quotesSent: 18,
    startedAt: "2020-01-20",
  },
  {
    id: "rep_004",
    name: "Jennifer Walsh",
    region: "Nassau",
    serviceLine: "Residential",
    revenueSold: 96,
    closeRate: 31.8,
    avgTicket: 9.8,
    openPipeline: 58,
    daysAvgClose: 14,
    appointmentsHeld: 31,
    quotesSent: 26,
    startedAt: "2023-05-10",
  },
  {
    id: "rep_005",
    name: "Carlos Vega",
    region: "Queens",
    serviceLine: "Residential",
    revenueSold: 87,
    closeRate: 26.9,
    avgTicket: 10.2,
    openPipeline: 64,
    daysAvgClose: 17,
    appointmentsHeld: 33,
    quotesSent: 28,
    startedAt: "2023-11-01",
  },
  {
    id: "rep_006",
    name: "Tom Bradley",
    region: "Brooklyn",
    serviceLine: "Commercial",
    revenueSold: 183,
    closeRate: 24.1,
    avgTicket: 25.4,
    openPipeline: 142,
    daysAvgClose: 28,
    appointmentsHeld: 19,
    quotesSent: 16,
    startedAt: "2021-02-18",
  },
];

export const teamTotals = {
  revenueSold: reps.reduce((s, r) => s + r.revenueSold, 0),
  closeRate:
    reps.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) /
    reps.reduce((s, r) => s + r.quotesSent, 0),
  avgTicket:
    reps.reduce((s, r) => s + r.avgTicket * r.appointmentsHeld, 0) /
    reps.reduce((s, r) => s + r.appointmentsHeld, 0),
  openQuotes: reps.reduce((s, r) => s + r.quotesSent, 0),
  openPipeline: reps.reduce((s, r) => s + r.openPipeline, 0),
};

export const companyKPIs = {
  revenueSold: { value: 847, change: 12, trend: "up" as const, unit: "$K" },
  closeRate: { value: 34.2, change: 2.1, trend: "up" as const, unit: "%" },
  avgTicket: { value: 11.4, change: -4, trend: "down" as const, unit: "$K" },
  openQuotes: { value: 128, change: 18, trend: "up" as const, unit: "" },
};

export const topPerformer = {
  id: "rep_003",
  name: "David Park",
  region: "Suffolk · Commercial",
  revenue: 211,
  closeRate: 29.4,
};

export const pipelineAtRisk = { value: 287, count: 18, reps: 6 };

/* ─────────────────────────────────────────────────────────────────
 * 12-month company history (oldest → newest). Numbers in $K.
 * ─────────────────────────────────────────────────────────────── */

const MONTH_LABELS = [
  "Jun '25", "Jul '25", "Aug '25", "Sep '25", "Oct '25", "Nov '25",
  "Dec '25", "Jan '26", "Feb '26", "Mar '26", "Apr '26", "May '26",
];

// Deterministic monthly company revenue with seasonality (slow winter, busy spring)
const COMPANY_MONTHLY_REVENUE = [
  720, 765, 810, 795, 740, 690, 605, 640, 695, 780, 820, 847,
];

const COMPANY_MONTHLY_CLOSE_RATE = [
  31.2, 31.8, 32.5, 32.1, 31.5, 30.9, 30.4, 30.8, 31.6, 32.9, 33.7, 34.2,
];

const COMPANY_MONTHLY_AVG_TICKET = [
  12.1, 12.0, 11.9, 11.8, 11.7, 11.6, 11.5, 11.4, 11.6, 11.8, 11.6, 11.4,
];

export const monthlyCompany: {
  month: string;
  revenue: number;
  closeRate: number;
  avgTicket: number;
}[] = MONTH_LABELS.map((m, i) => ({
  month: m,
  revenue: COMPANY_MONTHLY_REVENUE[i],
  closeRate: COMPANY_MONTHLY_CLOSE_RATE[i],
  avgTicket: COMPANY_MONTHLY_AVG_TICKET[i],
}));

/* ─────────────────────────────────────────────────────────────────
 * Per-rep 12-month history. Each rep's monthly revenue trends to
 * their current 30-day number; close rate + avg ticket wobble around
 * their current value.
 * ─────────────────────────────────────────────────────────────── */

// Per-rep month-over-month multipliers — deterministic, hand-tuned so each rep
// has a distinct trajectory (climbers, slumps, steady, late-bloomer, etc.).
const REP_MONTHLY_PROFILE: Record<string, number[]> = {
  rep_001: [0.78, 0.82, 0.88, 0.91, 0.85, 0.80, 0.74, 0.79, 0.86, 0.94, 0.98, 1.00], // steady climber
  rep_002: [0.92, 0.96, 1.02, 0.98, 0.90, 0.84, 0.78, 0.82, 0.88, 0.96, 1.00, 1.00], // dip + recovery
  rep_003: [1.05, 1.08, 1.12, 1.04, 0.95, 0.86, 0.78, 0.84, 0.92, 1.02, 1.01, 1.00], // commercial — high variance
  rep_004: [0.65, 0.70, 0.76, 0.80, 0.75, 0.72, 0.68, 0.73, 0.82, 0.91, 0.96, 1.00], // late-bloomer (started 2023)
  rep_005: [0.55, 0.62, 0.71, 0.78, 0.74, 0.70, 0.66, 0.72, 0.81, 0.89, 0.95, 1.00], // newest rep — ramping
  rep_006: [1.15, 1.18, 1.20, 1.10, 0.96, 0.82, 0.72, 0.78, 0.86, 0.95, 0.98, 1.00], // commercial seasonality
};

const REP_CLOSE_RATE_WOBBLE: Record<string, number[]> = {
  rep_001: [-3, -2, -1, 0, -1, -2, -3, -2, 0, 1, 2, 0],
  rep_002: [1, 0, -1, -2, -3, -4, -3, -2, -1, 0, 0, 0],
  rep_003: [-2, -1, 0, 1, 0, -1, -2, -1, 0, 1, 0, 0],
  rep_004: [-5, -4, -3, -2, -2, -3, -4, -3, -1, 0, 1, 0],
  rep_005: [-8, -6, -4, -2, -3, -4, -5, -3, -1, 0, 0, 0],
  rep_006: [2, 3, 2, 0, -1, -2, -3, -2, -1, 0, 0, 0],
};

export type RepMonthlyPoint = {
  month: string;
  revenue: number; // $K
  closeRate: number; // %
  avgTicket: number; // $K
};

export function getRepMonthly(repId: string): RepMonthlyPoint[] {
  const rep = reps.find((r) => r.id === repId);
  if (!rep) return [];
  const profile = REP_MONTHLY_PROFILE[repId] ?? Array(12).fill(1);
  const wobble = REP_CLOSE_RATE_WOBBLE[repId] ?? Array(12).fill(0);
  return MONTH_LABELS.map((m, i) => ({
    month: m,
    revenue: Math.round(rep.revenueSold * profile[i]),
    closeRate: Math.max(15, +(rep.closeRate + wobble[i]).toFixed(1)),
    avgTicket: +(rep.avgTicket * (0.95 + (i % 4) * 0.025)).toFixed(1),
  }));
}

/* ─────────────────────────────────────────────────────────────────
 * Service-line mix & regional rollups (current 30-day window)
 * ─────────────────────────────────────────────────────────────── */

export const serviceLineMix = (() => {
  const res = reps.filter((r) => r.serviceLine === "Residential");
  const com = reps.filter((r) => r.serviceLine === "Commercial");
  const resRev = res.reduce((s, r) => s + r.revenueSold, 0);
  const comRev = com.reduce((s, r) => s + r.revenueSold, 0);
  const total = resRev + comRev;
  return {
    residential: {
      revenue: resRev,
      pct: Math.round((resRev / total) * 100),
      reps: res.length,
      avgTicket: +(res.reduce((s, r) => s + r.avgTicket, 0) / res.length).toFixed(1),
    },
    commercial: {
      revenue: comRev,
      pct: Math.round((comRev / total) * 100),
      reps: com.length,
      avgTicket: +(com.reduce((s, r) => s + r.avgTicket, 0) / com.length).toFixed(1),
    },
  };
})();

export type RegionRollup = {
  region: Rep["region"];
  revenue: number;
  reps: number;
  closeRate: number;
  pipeline: number;
};

export const regionalRollup: RegionRollup[] = (["Suffolk", "Nassau", "Queens", "Brooklyn"] as const).map(
  (region) => {
    const inRegion = reps.filter((r) => r.region === region);
    const revenue = inRegion.reduce((s, r) => s + r.revenueSold, 0);
    const pipeline = inRegion.reduce((s, r) => s + r.openPipeline, 0);
    const closeRate =
      inRegion.length === 0
        ? 0
        : +(
            inRegion.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) /
            Math.max(
              1,
              inRegion.reduce((s, r) => s + r.quotesSent, 0)
            )
          ).toFixed(1);
    return { region, revenue, reps: inRegion.length, closeRate, pipeline };
  }
);

/* ─────────────────────────────────────────────────────────────────
 * Pipeline funnel (current 30-day window — company total)
 * ─────────────────────────────────────────────────────────────── */

export const pipelineFunnel = (() => {
  const totalQuotes = reps.reduce((s, r) => s + r.quotesSent, 0);
  const totalAppts = reps.reduce((s, r) => s + r.appointmentsHeld, 0);
  const totalClosed = Math.round(
    reps.reduce((s, r) => s + (r.quotesSent * r.closeRate) / 100, 0)
  );
  return [
    { stage: "Leads worked", count: Math.round(totalAppts * 1.6), value: 0 },
    { stage: "Appointments held", count: totalAppts, value: 0 },
    { stage: "Quotes sent", count: totalQuotes, value: reps.reduce((s, r) => s + r.openPipeline, 0) },
    {
      stage: "Closed won",
      count: totalClosed,
      value: reps.reduce((s, r) => s + r.revenueSold, 0),
    },
  ];
})();

/* ─────────────────────────────────────────────────────────────────
 * Recent deals (per rep) — for drill-in detail table
 * ─────────────────────────────────────────────────────────────── */

export type Deal = {
  id: string;
  customer: string;
  amount: number; // $K
  stage: "Quoted" | "Appointment" | "Closed Won" | "Closed Lost";
  closedAt: string | null;
  daysInStage: number;
};

const DEAL_CUSTOMERS = [
  "Patel residence",
  "Lefferts Ave duplex",
  "Greenpoint loft",
  "Sunnyside HOA",
  "Marsden warehouse",
  "Bayside cafe",
  "Greenway townhouse",
  "Fort Hamilton complex",
  "Ronkonkoma estate",
  "Massapequa storefront",
  "Glen Cove townhomes",
  "Astoria diner",
  "Mineola office park",
  "Floral Park residence",
];

export function getRepRecentDeals(repId: string): Deal[] {
  const rep = reps.find((r) => r.id === repId);
  if (!rep) return [];
  const baseSeed = parseInt(repId.replace(/\D/g, "")) || 1;
  return Array.from({ length: 8 }, (_, i) => {
    const customerIdx = (baseSeed * 3 + i * 7) % DEAL_CUSTOMERS.length;
    const stages: Deal["stage"][] = ["Closed Won", "Closed Won", "Quoted", "Appointment", "Closed Won", "Closed Lost", "Quoted", "Closed Won"];
    const stage = stages[i];
    const amount = +(rep.avgTicket * (0.7 + ((i * 13) % 60) / 100)).toFixed(1);
    const daysInStage = stage.startsWith("Closed") ? 0 : (baseSeed * 2 + i * 3) % 18;
    const closedAt =
      stage === "Closed Won" || stage === "Closed Lost"
        ? `2026-05-${String(((baseSeed + i * 2) % 18) + 1).padStart(2, "0")}`
        : null;
    return {
      id: `${repId}_deal_${i + 1}`,
      customer: DEAL_CUSTOMERS[customerIdx],
      amount,
      stage,
      closedAt,
      daysInStage,
    };
  });
}

/* ─────────────────────────────────────────────────────────────────
 * Interactive filter layer (period + region) — derives everything
 * on the Company Overview from the user's current selections.
 * Salesforce-bound queries will replace this engine when access lands.
 * ─────────────────────────────────────────────────────────────── */

export type Period = "7d" | "30d" | "90d" | "6m" | "12m" | "ytd";
export type RegionFilter = "all" | Rep["region"];

export const PERIOD_LABELS: Record<Period, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
  ytd: "Year to date",
};

export const REGION_LABELS: Record<RegionFilter, string> = {
  all: "All Regions",
  Suffolk: "Suffolk",
  Nassau: "Nassau",
  Queens: "Queens",
  Brooklyn: "Brooklyn",
};

const PERIOD_SHAPE: Record<
  Period,
  { granularity: "daily" | "monthly"; count: number }
> = {
  "7d": { granularity: "daily", count: 7 },
  "30d": { granularity: "daily", count: 30 },
  "90d": { granularity: "monthly", count: 3 },
  "6m": { granularity: "monthly", count: 6 },
  "12m": { granularity: "monthly", count: 12 },
  ytd: { granularity: "monthly", count: 5 },
};

function filteredReps(region: RegionFilter): Rep[] {
  return region === "all" ? reps : reps.filter((r) => r.region === region);
}

/* ─── Daily series (last 30 days, deterministic) ─── */

// Day labels for the last 30 days. "Today" is anchored at 2026-05-19 to keep
// mock data deterministic — when SF connects we'll use Date.now() instead.
const TODAY = new Date("2026-05-19");
const DAY_LABELS: string[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - (29 - i)); // oldest → newest
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
});

// Weekday weights — M–F higher than weekends (paint sales are weekday-skewed).
function weekdayWeight(dayIndex: number): number {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - (29 - dayIndex));
  const dow = d.getDay(); // 0=Sun, 6=Sat
  if (dow === 0) return 0.45;
  if (dow === 6) return 0.55;
  if (dow === 1) return 0.95;
  return 1.1; // Tue–Fri
}

// Per-rep daily revenue contribution = (rep.revenueSold / 30) × weekdayWeight × jitter
const DAILY_JITTER: number[] = Array.from({ length: 30 }, (_, i) =>
  0.78 + ((Math.sin(i * 1.7) + Math.cos(i * 0.5)) * 0.18 + 0.18)
);

function repDailyRevenue(rep: Rep, dayIndex: number): number {
  const baseDaily = rep.revenueSold / 30;
  return baseDaily * weekdayWeight(dayIndex) * DAILY_JITTER[dayIndex];
}

function dailyTopRegion(dayIndex: number, repList: Rep[]):
  | { region: Rep["region"]; revenue: number }
  | null {
  const byRegion = new Map<Rep["region"], number>();
  for (const r of repList) {
    const rev = repDailyRevenue(r, dayIndex);
    byRegion.set(r.region, (byRegion.get(r.region) ?? 0) + rev);
  }
  if (byRegion.size === 0) return null;
  let top: { region: Rep["region"]; revenue: number } | null = null;
  for (const [region, revenue] of byRegion) {
    if (!top || revenue > top.revenue) top = { region, revenue };
  }
  return top ? { region: top.region, revenue: +top.revenue.toFixed(1) } : null;
}

function dailyTopRep(dayIndex: number, repList: Rep[]):
  | { name: string; revenue: number }
  | null {
  let top: { name: string; revenue: number } | null = null;
  for (const r of repList) {
    const rev = repDailyRevenue(r, dayIndex);
    if (!top || rev > top.revenue) top = { name: r.name, revenue: rev };
  }
  return top ? { name: top.name, revenue: +top.revenue.toFixed(1) } : null;
}

/* ─── Monthly meta helpers ─── */

function monthlyTopRegion(monthIdx: number, repList: Rep[]):
  | { region: Rep["region"]; revenue: number }
  | null {
  const byRegion = new Map<Rep["region"], number>();
  for (const r of repList) {
    const profile = REP_MONTHLY_PROFILE[r.id] ?? Array(12).fill(1);
    const rev = r.revenueSold * profile[monthIdx];
    byRegion.set(r.region, (byRegion.get(r.region) ?? 0) + rev);
  }
  if (byRegion.size === 0) return null;
  let top: { region: Rep["region"]; revenue: number } | null = null;
  for (const [region, revenue] of byRegion) {
    if (!top || revenue > top.revenue) top = { region, revenue };
  }
  return top ? { region: top.region, revenue: +top.revenue.toFixed(0) } : null;
}

function monthlyTopRep(monthIdx: number, repList: Rep[]):
  | { name: string; revenue: number }
  | null {
  let top: { name: string; revenue: number } | null = null;
  for (const r of repList) {
    const profile = REP_MONTHLY_PROFILE[r.id] ?? Array(12).fill(1);
    const rev = r.revenueSold * profile[monthIdx];
    if (!top || rev > top.revenue) top = { name: r.name, revenue: rev };
  }
  return top ? { name: top.name, revenue: +top.revenue.toFixed(0) } : null;
}

/* ─── Series point shape (chart-ready, with rich tooltip meta) ─── */

export type SeriesPoint = {
  label: string;
  value: number;
  meta?: {
    topRegion?: { region: string; revenue: number };
    topRep?: { name: string; revenue: number };
    deals?: number;
  };
};

export type FilteredView = {
  period: Period;
  region: RegionFilter;
  granularity: "daily" | "monthly";
  series: SeriesPoint[];
  kpis: {
    revenueSold: { value: number; change: number; trend: "up" | "down" | "flat" };
    closeRate: { value: number; change: number; trend: "up" | "down" | "flat" };
    avgTicket: { value: number; change: number; trend: "up" | "down" | "flat" };
    openQuotes: { value: number; change: number; trend: "up" | "down" | "flat" };
  };
  serviceLineMix: {
    residential: { revenue: number; pct: number; reps: number; avgTicket: number };
    commercial: { revenue: number; pct: number; reps: number; avgTicket: number };
  };
  regionalRollup: RegionRollup[];
  pipelineFunnel: { stage: string; count: number; value: number }[];
  leaderboard: Rep[];
  totalRevenue: number;
};

function trendOf(change: number): "up" | "down" | "flat" {
  if (change > 0.5) return "up";
  if (change < -0.5) return "down";
  return "flat";
}

/** Optional override that recomputes ONLY the funnel based on a different period — used by
 *  the Pipeline Funnel card's independent time selector. */
export function getFunnelForPeriod(period: Period, region: RegionFilter) {
  const repList = filteredReps(region);
  const shape = PERIOD_SHAPE[period];
  const scale = shape.granularity === "daily" ? shape.count / 30 : shape.count;

  const baseQuotes = repList.reduce((s, r) => s + r.quotesSent, 0);
  const baseAppts = repList.reduce((s, r) => s + r.appointmentsHeld, 0);
  const baseClosed = repList.reduce((s, r) => s + (r.quotesSent * r.closeRate) / 100, 0);
  const basePipelineValue = repList.reduce((s, r) => s + r.openPipeline, 0);
  const baseClosedValue = repList.reduce((s, r) => s + r.revenueSold, 0);

  return [
    { stage: "Leads worked", count: Math.round(baseAppts * 1.6 * scale), value: 0 },
    { stage: "Appointments held", count: Math.round(baseAppts * scale), value: 0 },
    {
      stage: "Quotes sent",
      count: Math.round(baseQuotes * scale),
      value: Math.round(basePipelineValue * scale),
    },
    {
      stage: "Closed won",
      count: Math.round(baseClosed * scale),
      value: Math.round(baseClosedValue * scale),
    },
  ];
}

export function getFilteredView(period: Period, region: RegionFilter): FilteredView {
  const repList = filteredReps(region);
  const shape = PERIOD_SHAPE[period];

  /* ─── Trendline series ─── */
  let series: SeriesPoint[] = [];
  if (shape.granularity === "daily") {
    const startIdx = 30 - shape.count;
    for (let i = startIdx; i < 30; i++) {
      const dayRev = repList.reduce((s, r) => s + repDailyRevenue(r, i), 0);
      const topReg = dailyTopRegion(i, repList);
      const topRep = dailyTopRep(i, repList);
      series.push({
        label: DAY_LABELS[i],
        value: +dayRev.toFixed(1),
        meta: {
          topRegion: topReg ? { region: topReg.region, revenue: topReg.revenue } : undefined,
          topRep: topRep ? { name: topRep.name, revenue: topRep.revenue } : undefined,
        },
      });
    }
  } else {
    const startIdx = 12 - shape.count;
    for (let i = startIdx; i < 12; i++) {
      const monthRev = repList.reduce((sum, r) => {
        const profile = REP_MONTHLY_PROFILE[r.id] ?? Array(12).fill(1);
        return sum + r.revenueSold * profile[i];
      }, 0);
      const topReg = monthlyTopRegion(i, repList);
      const topRep = monthlyTopRep(i, repList);
      series.push({
        label: MONTH_LABELS[i],
        value: Math.round(monthRev),
        meta: {
          topRegion: topReg ? { region: topReg.region, revenue: topReg.revenue } : undefined,
          topRep: topRep ? { name: topRep.name, revenue: topRep.revenue } : undefined,
        },
      });
    }
  }

  // Guard: empty-region filter — return a single zero-point series so the chart still renders
  if (series.length === 0) {
    series = [{ label: "—", value: 0 }];
  }

  /* ─── KPI: revenue total over the period ─── */
  const revTotal = Math.round(series.reduce((s, p) => s + p.value, 0));

  // Period-over-period delta — comparable prior window
  let priorRev = revTotal;
  if (shape.granularity === "daily" && repList.length > 0) {
    // Sum the prior `count` days (days outside the visible window, using same daily series)
    const priorStart = Math.max(0, 30 - shape.count * 2);
    const priorEnd = 30 - shape.count;
    let sum = 0;
    for (let i = priorStart; i < priorEnd; i++) {
      for (const r of repList) sum += repDailyRevenue(r, i);
    }
    priorRev = sum || revTotal;
  } else if (shape.granularity === "monthly" && repList.length > 0) {
    const priorStart = Math.max(0, 12 - shape.count * 2);
    const priorEnd = 12 - shape.count;
    let sum = 0;
    for (let i = priorStart; i < priorEnd; i++) {
      for (const r of repList) {
        const profile = REP_MONTHLY_PROFILE[r.id] ?? Array(12).fill(1);
        sum += r.revenueSold * profile[i];
      }
    }
    priorRev = sum || revTotal;
  }
  const revChangePct = priorRev === 0 ? 0 : Math.round(((revTotal - priorRev) / priorRev) * 100);

  /* ─── KPI: close rate + avg ticket ─── */
  const closeRate =
    repList.length === 0
      ? 0
      : +(
          repList.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) /
          Math.max(1, repList.reduce((s, r) => s + r.quotesSent, 0))
        ).toFixed(1);
  const avgTicket =
    repList.length === 0
      ? 0
      : +(
          repList.reduce((s, r) => s + r.avgTicket * r.appointmentsHeld, 0) /
          Math.max(1, repList.reduce((s, r) => s + r.appointmentsHeld, 0))
        ).toFixed(1);
  const openQuotes = repList.reduce((s, r) => s + r.quotesSent, 0);

  // Close-rate prior-window calc (mock — uses monthly series even for daily periods)
  const monthsToCompare = Math.max(1, Math.min(12, Math.round(shape.granularity === "daily" ? 1 : shape.count)));
  const recentClose = monthlyCompany.slice(-1)[0].closeRate;
  const priorCloseSlice = monthlyCompany.slice(Math.max(0, 12 - monthsToCompare * 2), 12 - monthsToCompare);
  const priorClose =
    priorCloseSlice.length === 0
      ? recentClose
      : priorCloseSlice.reduce((s, m) => s + m.closeRate, 0) / priorCloseSlice.length;
  const closeChange = +(recentClose - priorClose).toFixed(1);

  /* ─── Service line mix ─── */
  const res = repList.filter((r) => r.serviceLine === "Residential");
  const com = repList.filter((r) => r.serviceLine === "Commercial");
  const resRev = res.reduce((s, r) => s + r.revenueSold, 0);
  const comRev = com.reduce((s, r) => s + r.revenueSold, 0);
  const totalRev = resRev + comRev || 1;
  const serviceLineMixFiltered = {
    residential: {
      revenue: resRev,
      pct: Math.round((resRev / totalRev) * 100),
      reps: res.length,
      avgTicket: res.length === 0 ? 0 : +(res.reduce((s, r) => s + r.avgTicket, 0) / res.length).toFixed(1),
    },
    commercial: {
      revenue: comRev,
      pct: Math.round((comRev / totalRev) * 100),
      reps: com.length,
      avgTicket: com.length === 0 ? 0 : +(com.reduce((s, r) => s + r.avgTicket, 0) / com.length).toFixed(1),
    },
  };

  /* ─── Regional rollup ─── */
  const regionalFiltered: RegionRollup[] = (
    ["Suffolk", "Nassau", "Queens", "Brooklyn"] as const
  )
    .filter((reg) => region === "all" || reg === region)
    .map((reg) => {
      const inRegion = repList.filter((r) => r.region === reg);
      const regRev = inRegion.reduce((s, r) => s + r.revenueSold, 0);
      const pipeline = inRegion.reduce((s, r) => s + r.openPipeline, 0);
      const cRate =
        inRegion.length === 0
          ? 0
          : +(
              inRegion.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) /
              Math.max(1, inRegion.reduce((s, r) => s + r.quotesSent, 0))
            ).toFixed(1);
      return { region: reg, revenue: regRev, reps: inRegion.length, closeRate: cRate, pipeline };
    });

  /* ─── Default pipeline funnel (uses page-level period) ─── */
  const funnel = getFunnelForPeriod(period, region);

  return {
    period,
    region,
    granularity: shape.granularity,
    series,
    kpis: {
      revenueSold: { value: revTotal, change: revChangePct, trend: trendOf(revChangePct) },
      closeRate: { value: closeRate, change: closeChange, trend: trendOf(closeChange) },
      avgTicket: { value: avgTicket, change: -2.1, trend: "down" },
      openQuotes: { value: openQuotes, change: 18, trend: "up" },
    },
    serviceLineMix: serviceLineMixFiltered,
    regionalRollup: regionalFiltered,
    pipelineFunnel: funnel,
    leaderboard: repList,
    totalRevenue: revTotal,
  };
}
