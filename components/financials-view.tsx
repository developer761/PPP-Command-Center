"use client";

/**
 * Financials View — /dashboard/financials. Admin-only.
 *
 * The CFO-style surface: AR aging, gross profit, lead-fee ROI, discount
 * leaks, commission totals. All scoped to the selected period.
 *
 * WHAT IT RENDERS:
 *   - AR aging buckets (current / 30 / 60 / 90 / 90+) with bar percentages
 *   - Net revenue + GP + GP-margin headline
 *   - Lead-fee ROI + total discount + commission stats
 *   - Top discounters + top GP contributors tables
 *
 * DATA SOURCES:
 *   - bundle.snapshot — full SF snapshot
 *   - deriveFinancials(snapshot, period) — pure derive (memoized per-snapshot)
 *
 * Period change = instant client-side recompute via the memoized derive;
 * no SF round-trip on filter changes.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import PageHeader from "@/components/page-header";
import { PERIOD_LABELS, type Period } from "@/lib/mock-data";
import { deriveFinancials } from "@/lib/salesforce/derive";
import { fmtMoneyK } from "@/lib/format";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  ["this-month", "last-month", "30d", "90d", "this-year", "last-year", "12m", "lifetime"] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

type Props = { bundle: LiveDashboardBundle };

export default function FinancialsView({ bundle }: Props) {
  const [period, setPeriod] = useState<Period>("this-month");
  const { snapshot, viewer } = bundle;
  // Hide cross-rep leaderboards when scoped to one rep (collapses to self).
  const repScopedToSelf = viewer?.scope === "my" && !!viewer.effectiveUserId;

  const fin = useMemo(
    () => (snapshot ? deriveFinancials(snapshot, period) : null),
    [snapshot, period]
  );

  if (!fin) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader title="Financials" subtitle="AR, gross profit, lead-fee ROI, discounts, commissions" />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">Salesforce not connected</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect in Admin → Integrations to populate financial metrics.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Financials"
        subtitle={`AR aging, gross profit, lead ROI, discounts · ${PERIOD_LABELS[period].toLowerCase()}`}
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
          <strong>Sandbox data.</strong> Production financials will surface here once OAuth flips.
        </div>
      )}

      {/* AR Aging — flagship card */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-3 mb-4">
          <div>
            <h3 className="text-base font-semibold text-ppp-charcoal">Accounts Receivable</h3>
            <p className="text-xs text-ppp-charcoal-500 mt-1">
              Outstanding balances right now, bucketed by age
            </p>
          </div>
          <div className="text-right">
            <div className="font-condensed text-3xl font-bold text-ppp-orange">
              {fmtMoneyK(fin.arAging.total / 1000)}
            </div>
            <div className="text-[11px] text-ppp-charcoal-500">total outstanding</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <AgingBucket label="Current" sub="0-29 days" value={fin.arAging.current} total={fin.arAging.total} accent="green" />
          <AgingBucket label="30 days" sub="30-59 days" value={fin.arAging.days30} total={fin.arAging.total} accent="blue" />
          <AgingBucket label="60 days" sub="60-89 days" value={fin.arAging.days60} total={fin.arAging.total} accent="navy" />
          <AgingBucket label="90 days" sub="90-119 days" value={fin.arAging.days90} total={fin.arAging.total} accent="orange" />
          <AgingBucket label="90+ days" sub="120+ days" value={fin.arAging.days90Plus} total={fin.arAging.total} accent="red" />
        </div>
      </section>

      {/* Top-line metrics */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Metric label="Net Revenue" value={fmtMoneyK(fin.netRevenue / 1000)} sub={`${PERIOD_LABELS[period].toLowerCase()}`} />
        <Metric
          label="Gross Profit"
          value={fmtMoneyK(fin.grossProfit / 1000)}
          sub={
            fin.gpCoveragePct < 50
              ? `${fin.gpMargin.toFixed(1)}% margin · ⚠ only ${fin.gpCoveragePct.toFixed(0)}% of WOs have cost data`
              : `${fin.gpMargin.toFixed(1)}% margin · ${fin.gpCoveragePct.toFixed(0)}% data coverage`
          }
          accent={
            fin.gpCoveragePct < 30
              ? "orange"
              : fin.gpMargin >= 30
              ? "green"
              : fin.gpMargin >= 20
              ? "blue"
              : "orange"
          }
        />
        <Metric
          label="Lead Fee ROI"
          value={fin.leadFeeRoi > 0 ? `${fin.leadFeeRoi.toFixed(1)}x` : "—"}
          sub={`$${(fin.totalLeadFee / 1000).toFixed(1)}K spent`}
          accent={fin.leadFeeRoi >= 5 ? "green" : "blue"}
        />
        <Metric
          label="Discount Given"
          value={fmtMoneyK(fin.totalDiscount / 1000)}
          sub={`${fin.discountPctOfRevenue.toFixed(1)}% of revenue`}
          accent={fin.discountPctOfRevenue > 5 ? "orange" : "blue"}
        />
      </section>

      {/* Commission + top discounters + GP contributors.
          The two leaderboards are cross-rep by design — when scoped to one rep
          they'd collapse to a 1-row "you vs you" view, so we drop them. The
          rep still gets their own GP / discount totals in the strip above. */}
      <section className={`grid grid-cols-1 gap-3 sm:gap-4 ${repScopedToSelf ? "lg:grid-cols-1" : "lg:grid-cols-3"}`}>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ppp-charcoal mb-3">
            {repScopedToSelf ? "Your Commissions" : "Commissions Paid"}
          </h3>
          <div className="font-condensed text-3xl font-bold text-ppp-navy">
            {fmtMoneyK(fin.totalCommission / 1000)}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 mt-1">
            {fin.commissionPctOfRevenue.toFixed(1)}% of net revenue · {PERIOD_LABELS[period].toLowerCase()}
          </div>
        </div>

        {!repScopedToSelf && (<>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ppp-charcoal mb-3">Top GP Contributors</h3>
          {fin.topGPContributors.length === 0 ? (
            <p className="text-xs text-ppp-charcoal-500 italic">No GP data in this period.</p>
          ) : (
            <ul className="space-y-2">
              {fin.topGPContributors.map((r) => (
                <li key={r.ownerId} className="flex items-center justify-between gap-2 text-xs">
                  <Link
                    href={`/dashboard/rep/${r.ownerId}`}
                    className="text-ppp-charcoal hover:text-ppp-blue transition-colors truncate"
                  >
                    {r.ownerName}
                  </Link>
                  <span className="font-semibold text-ppp-green-700 whitespace-nowrap">
                    {fmtMoneyK(r.gp / 1000)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ppp-charcoal mb-3">Top Discounters</h3>
          <p className="text-[10px] text-ppp-charcoal-500 mb-3 italic">
            Reps giving the biggest discounts (worth a coaching conversation)
          </p>
          {fin.topDiscounters.length === 0 ? (
            <p className="text-xs text-ppp-charcoal-500 italic">No discounts in this period.</p>
          ) : (
            <ul className="space-y-2">
              {fin.topDiscounters.map((r) => (
                <li key={r.ownerId} className="flex items-center justify-between gap-2 text-xs">
                  <Link
                    href={`/dashboard/rep/${r.ownerId}`}
                    className="text-ppp-charcoal hover:text-ppp-blue transition-colors truncate"
                  >
                    {r.ownerName}
                  </Link>
                  <span className="font-semibold text-ppp-orange-700 whitespace-nowrap">
                    {fmtMoneyK(r.discount / 1000)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </>)}
      </section>
    </div>
  );
}

function AgingBucket({
  label,
  sub,
  value,
  total,
  accent,
}: {
  label: string;
  sub: string;
  value: number;
  total: number;
  accent: "green" | "blue" | "navy" | "orange" | "red";
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const bg = {
    green: "bg-ppp-green",
    blue: "bg-ppp-blue",
    navy: "bg-ppp-navy",
    orange: "bg-ppp-orange",
    red: "bg-ppp-orange-700",
  }[accent];
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-3">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">
        {label}
      </div>
      <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">{sub}</div>
      <div className="font-condensed text-lg font-bold text-ppp-navy mt-1">
        {fmtMoneyK(value / 1000)}
      </div>
      <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">{pct}% of AR</div>
      <div className="mt-2 h-1.5 bg-white rounded">
        <div className={`h-full ${bg} rounded transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "blue" | "orange" | "navy";
}) {
  const valueColor = {
    green: "text-ppp-green-700",
    blue: "text-ppp-blue-700",
    orange: "text-ppp-orange-700",
    navy: "text-ppp-navy",
  }[accent ?? "navy"];
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-2xl sm:text-3xl font-bold ${valueColor} mt-1`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-1">{sub}</div>}
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
