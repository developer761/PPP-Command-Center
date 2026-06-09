"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import PageHeader from "@/components/page-header";
import {
  PERIOD_LABELS,
  reps as mockReps,
  type Period,
  type Rep,
} from "@/lib/mock-data";
import {
  deriveRepsForPeriod,
  deriveRepAccountStats,
  derivePeriodDelta,
  deriveRepMomentum,
} from "@/lib/salesforce/derive";
import { fmtMoneyK } from "@/lib/format";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  [
    "this-month",
    "last-month",
    "30d",
    "90d",
    "this-year",
    "last-year",
    "12m",
    "lifetime",
  ] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

type SortKey = "revenue" | "closeRate" | "avgTicket" | "openPipeline" | "name" | "customers";
type SortDir = "desc" | "asc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "revenue", label: "Revenue (high → low)" },
  { value: "closeRate", label: "Close Rate" },
  { value: "avgTicket", label: "Avg Ticket" },
  { value: "openPipeline", label: "Open Pipeline" },
  { value: "customers", label: "Customer count" },
  { value: "name", label: "Name (A → Z)" },
];

type Props = {
  bundle: LiveDashboardBundle;
};

export default function RepIndexView({ bundle }: Props) {
  // Default matches PPP's day-to-day mental model.
  const [period, setPeriod] = useState<Period>("this-month");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [regionFilter, setRegionFilter] = useState<string>("all");

  const { source, reason, snapshot } = bundle;

  const reps = useMemo(() => {
    if (snapshot) {
      // Rep Profiles page shows only PPP's field team (Katie 2026-05-29) —
      // profiles *Standard.Field / *Experience / *Wallpapers / *Tomco + Michael
      // Zilberman, flagged via isFieldStandard on the snapshot. Non-field users
      // (admins / other managers / office) are filtered out here. Mock reps
      // have isFieldStandard=undefined → kept.
      return deriveRepsForPeriod(snapshot, period).filter((r) => r.isFieldStandard !== false);
    }
    return mockReps;
  }, [snapshot, period]);

  // Per-rep account stats — only computed when on live data.
  const accountStatsByRep = useMemo(() => {
    if (!snapshot) return new Map();
    const map = new Map<string, ReturnType<typeof deriveRepAccountStats>>();
    for (const r of reps) {
      map.set(r.id, deriveRepAccountStats(snapshot, r.id));
    }
    return map;
  }, [snapshot, reps]);

  // Week-over-week momentum — drives "hot streak" indicator per card.
  const momentumByRep = useMemo(
    () => (snapshot ? deriveRepMomentum(snapshot) : new Map()),
    [snapshot]
  );

  // Region options derived from live rep data.
  const regionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of reps) if (r.region) set.add(r.region);
    return [
      { value: "all", label: "All Regions" },
      ...Array.from(set).sort().map((r) => ({ value: r, label: r })),
    ];
  }, [reps]);

  const teamRevenue = useMemo(
    () => reps.reduce((s, r) => s + r.revenueSold, 0),
    [reps]
  );

  // Company-wide revenue for the same period — sums EVERY WO that closed in
  // the period, including those owned by admins / orphaned / non-canonical
  // reps. Always ≥ teamRevenue. The gap is meaningful to surface: if it's
  // material ($10K+), there are WOs landing on accounts that aren't being
  // attributed to a field rep — usually a SF data hygiene issue worth
  // looking at (orphan account, missing OwnerId, suspended user still on
  // the deed). Karan 2026-06-08: "team revenue is 495K but total is 535K,
  // confusing" — adding the company-wide figure inline so the gap is
  // self-explained instead of forcing comparison against the home dashboard.
  const companyRevenue = useMemo(() => {
    if (!snapshot) return null;
    return derivePeriodDelta(snapshot, period).value; // in $K
  }, [snapshot, period]);

  const searchLower = search.trim().toLowerCase();
  const sorted = useMemo(() => {
    let list = [...reps];

    // Region filter
    if (regionFilter !== "all") {
      list = list.filter((r) => r.region === regionFilter);
    }

    // Search
    if (searchLower) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(searchLower) ||
          r.region.toLowerCase().includes(searchLower) ||
          r.serviceLine.toLowerCase().includes(searchLower)
      );
    }

    // Sort
    list.sort((a, b) => {
      let va: number | string = 0;
      let vb: number | string = 0;
      switch (sortKey) {
        case "revenue":
          va = a.revenueSold;
          vb = b.revenueSold;
          break;
        case "closeRate":
          va = a.closeRate;
          vb = b.closeRate;
          break;
        case "avgTicket":
          va = a.avgTicket;
          vb = b.avgTicket;
          break;
        case "openPipeline":
          va = a.openPipeline;
          vb = b.openPipeline;
          break;
        case "customers":
          va = accountStatsByRep.get(a.id)?.totalCustomers ?? 0;
          vb = accountStatsByRep.get(b.id)?.totalCustomers ?? 0;
          break;
        case "name":
          va = a.name;
          vb = b.name;
          break;
      }
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === "asc"
        ? (va as number) - (vb as number)
        : (vb as number) - (va as number);
    });

    return list;
  }, [reps, searchLower, regionFilter, sortKey, sortDir, accountStatsByRep]);

  const activeCount = reps.filter((r) => r.revenueSold > 0 || r.openPipeline > 0).length;

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Rep Profiles"
        subtitle={
          source === "salesforce"
            ? `${reps.length} rep${reps.length === 1 ? "" : "s"} · ${activeCount} active · scoped to ${PERIOD_LABELS[period].toLowerCase()}`
            : reason === "sf_not_connected"
            ? "Salesforce isn't connected yet — showing demo data."
            : "Pick a rep to view their full analytics."
        }
        actions={
          <FilterDropdown<Period>
            value={period}
            options={PERIOD_OPTIONS}
            onChange={setPeriod}
            srLabel="Period"
            icon={<IconCalendar />}
          />
        }
      />

      {snapshot?.isSandbox && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Sandbox data.</strong> Production reps will appear once Katie grants access.
        </div>
      )}

      {source === "mock" && reason && reason !== "sf_not_connected" && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Live data unavailable:</strong> {reason}. Falling back to demo data.
        </div>
      )}

      {/* Team stat strip — Karan 2026-06-08: "Total Revenue $2.0M" next to
          "Top Rep Andres" reads as if Andres did $2M alone. Renamed to "Team
          Revenue" + the period label inline + Top Rep value shows the rep's
          OWN $ next to their name so the team-vs-rep distinction is
          unambiguous. */}
      {reps.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 sm:px-5 sm:py-4 flex flex-wrap gap-x-6 gap-y-2">
          <Stat
            label={`Team Revenue · ${PERIOD_LABELS[period].toLowerCase()}`}
            value={fmtMoneyK(teamRevenue)}
            accent="navy"
            // When the company total differs by ≥ $10K from the team-attributed
            // sum, surface it. Shows "of $535K company · field reps only" so
            // admin sees why this number differs from the home dashboard's
            // Revenue KPI (which is company-wide) without having to dig.
            // Hidden when the gap is < $10K — the rounding noise isn't worth
            // explaining. Karan 2026-06-08.
            hint={
              companyRevenue !== null && companyRevenue - teamRevenue >= 10
                ? `of ${fmtMoneyK(companyRevenue)} company total · field reps only`
                : undefined
            }
          />
          <Stat
            label="Active Reps"
            value={`${activeCount}/${reps.length}`}
            accent="charcoal"
          />
          <Stat
            label="Avg Revenue / Rep"
            value={activeCount > 0 ? fmtMoneyK(teamRevenue / activeCount) : "—"}
            accent="charcoal"
          />
          <Stat
            label="Top Rep"
            value={
              sorted[0]?.revenueSold
                ? `${sorted[0].name} · ${fmtMoneyK(sorted[0].revenueSold)}`
                : "—"
            }
            accent="charcoal"
          />
        </div>
      )}

      {/* Filters row */}
      {reps.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <span className="absolute inset-y-0 left-3 flex items-center text-ppp-charcoal-300 pointer-events-none">
              <IconSearch />
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reps…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-ppp-charcoal-100 rounded-lg placeholder:text-ppp-charcoal-300 focus:outline-none focus:ring-2 focus:ring-ppp-blue-100 focus:border-ppp-blue-200"
            />
          </div>

          {regionOptions.length > 2 && (
            <FilterDropdown
              value={regionFilter}
              options={regionOptions}
              onChange={setRegionFilter}
              srLabel="Region"
              icon={<IconPin />}
            />
          )}

          <FilterDropdown<SortKey>
            value={sortKey}
            options={SORT_OPTIONS}
            onChange={(k) => {
              setSortKey(k);
              // Default direction to match the option's intent: Name → A→Z
              // (asc), numeric metrics → highest-first (desc). User can still
              // flip with the direction toggle.
              setSortDir(k === "name" ? "asc" : "desc");
            }}
            srLabel="Sort by"
            icon={<IconSort />}
          />

          <button
            type="button"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            className="px-3 py-2 text-xs font-medium border border-ppp-charcoal-100 rounded-lg hover:bg-ppp-charcoal-50/50 transition-colors"
            title={`Currently ${sortDir === "desc" ? "high → low" : "low → high"} — click to toggle`}
          >
            {sortDir === "desc" ? "↓ Desc" : "↑ Asc"}
          </button>

          <div className="text-[11px] text-ppp-charcoal-500 ml-auto">
            Showing {sorted.length} of {reps.length}
          </div>
        </div>
      )}

      {reps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">No reps to show</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect Salesforce in Admin → Integrations to populate this view.
          </p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">
            No reps match these filters
          </p>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setRegionFilter("all");
            }}
            className="text-xs text-ppp-blue hover:underline mt-1"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {sorted.map((r) => {
            const stats = accountStatsByRep.get(r.id);
            const teamShare = teamRevenue > 0
              ? Math.round((r.revenueSold / teamRevenue) * 100)
              : 0;
            const inactive = r.revenueSold === 0 && r.openPipeline === 0;
            const momentum = momentumByRep.get(r.id);
            return <RepCard
              key={r.id}
              rep={r}
              stats={stats}
              momentum={momentum}
              teamShare={teamShare}
              inactive={inactive}
            />;
          })}
        </div>
      )}
    </div>
  );
}

function RepCard({
  rep: r,
  stats,
  momentum,
  teamShare,
  inactive,
}: {
  rep: Rep;
  stats?: ReturnType<typeof deriveRepAccountStats>;
  momentum?: { thisWeek: number; priorWeek: number; deltaPct: number };
  teamShare: number;
  inactive: boolean;
}) {
  // "Hot" needs real revenue (≥ $1K this week) AND a real prior-week base
  // (≥ $1K) so we don't badge a rep as Hot for a $1 deal off a $0 prior week.
  const hot =
    momentum &&
    momentum.thisWeek >= 1000 &&
    momentum.priorWeek >= 1000 &&
    momentum.deltaPct >= 25;
  const cooling =
    momentum &&
    momentum.priorWeek >= 1000 &&
    momentum.thisWeek < momentum.priorWeek * 0.5;
  return (
    <Link
      href={`/dashboard/rep/${r.id}`}
      className={[
        "group bg-white border rounded-xl p-5 transition-all",
        inactive
          ? "border-ppp-charcoal-100 opacity-60 hover:opacity-100 hover:border-ppp-blue-200"
          : "border-ppp-charcoal-100 hover:border-ppp-blue-200 hover:shadow-md hover:shadow-ppp-charcoal/5",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 rounded-full bg-ppp-blue-50 text-ppp-blue text-sm font-bold flex items-center justify-center shrink-0">
          {r.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ppp-charcoal group-hover:text-ppp-blue transition-colors truncate flex items-center gap-1.5">
            <span className="truncate">{r.name}</span>
            {hot && (
              <span
                className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded px-1.5 py-0 shrink-0"
                title={`Up ${momentum!.deltaPct}% week-over-week (${fmtMoneyK(momentum!.thisWeek / 1000)} this week vs ${fmtMoneyK(momentum!.priorWeek / 1000)} prior)`}
              >
                🔥 Hot
              </span>
            )}
            {cooling && !hot && (
              <span
                className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded px-1.5 py-0 shrink-0"
                title={`Down ${Math.abs(momentum!.deltaPct)}% week-over-week`}
              >
                ❄ Cooling
              </span>
            )}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 truncate">
            {r.region}
            {inactive && <span className="ml-1 text-ppp-charcoal-200">· no activity</span>}
            {momentum && momentum.thisWeek > 0 && !hot && !cooling && (
              <span className="ml-1 text-ppp-charcoal-400">
                · {fmtMoneyK(momentum.thisWeek / 1000)} this wk
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Metric label="Revenue" value={fmtMoneyK(r.revenueSold)} primary />
        <Metric
          label="Close"
          value={`${r.closeRate.toFixed(1)}%`}
        />
        <Metric label="Avg Ticket" value={fmtMoneyK(r.avgTicket)} />
      </div>

      {/* Account stats — only shows when on live data */}
      {stats && (stats.totalCustomers > 0 || stats.repeatCustomers > 0) && (
        <div className="mt-3 pt-3 border-t border-ppp-charcoal-100 grid grid-cols-3 gap-2 text-center">
          <Metric
            label="Customers"
            value={stats.totalCustomers.toString()}
            small
          />
          <Metric
            label="Repeat"
            value={stats.repeatCustomers > 0 ? stats.repeatCustomers.toString() : "—"}
            small
            accent={stats.repeatCustomers > 0 ? "green" : "muted"}
          />
          <Metric
            label="Open"
            value={fmtMoneyK(r.openPipeline)}
            small
          />
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-ppp-charcoal-100 flex items-center justify-between">
        <span className="text-[11px] text-ppp-charcoal-500">
          {teamShare > 0 ? `${teamShare}% of team revenue` : "—"}
        </span>
        <span className="text-[11px] font-medium text-ppp-blue opacity-0 group-hover:opacity-100 transition-opacity">
          Open profile →
        </span>
      </div>
    </Link>
  );
}

function Metric({
  label,
  value,
  primary,
  small,
  accent,
}: {
  label: string;
  value: string;
  primary?: boolean;
  small?: boolean;
  accent?: "green" | "muted";
}) {
  const valueColor = accent === "green"
    ? "text-ppp-green-700"
    : accent === "muted"
    ? "text-ppp-charcoal-200"
    : "text-ppp-navy";
  return (
    <div>
      <div className={`font-condensed font-bold ${valueColor} ${small ? "text-sm" : primary ? "text-base" : "text-base"}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
        {label}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent: "navy" | "charcoal";
  /** Optional small line under the label — used to disambiguate scope when
   *  the headline number differs from a related figure elsewhere on the
   *  platform (e.g., "of $535K company total" under Team Revenue). */
  hint?: string;
}) {
  return (
    <div>
      <div className={`font-condensed text-lg sm:text-xl font-bold ${accent === "navy" ? "text-ppp-navy" : "text-ppp-charcoal"}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
        {label}
      </div>
      {hint && (
        <div className="text-[10px] text-ppp-charcoal-400 mt-0.5 normal-case font-normal">
          {hint}
        </div>
      )}
    </div>
  );
}

function IconCalendar() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18 M8 3v4 M16 3v4" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}

function IconSort() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h13 M3 12h9 M3 18h5" />
      <path d="M17 16l3 3 3-3 M20 19V4" />
    </svg>
  );
}
