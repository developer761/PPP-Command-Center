"use client";

import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import PageHeader from "@/components/page-header";
import { PERIOD_LABELS, type Period } from "@/lib/mock-data";
import { deriveOperations } from "@/lib/salesforce/derive";
import { fmtMoneyK } from "@/lib/format";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  ["this-month", "last-month", "30d", "90d", "this-year", "last-year", "12m", "lifetime"] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

type Props = { bundle: LiveDashboardBundle };

export default function OperationsView({ bundle }: Props) {
  const [period, setPeriod] = useState<Period>("this-month");
  const { snapshot, viewer } = bundle;
  const repScopedToSelf = viewer?.scope === "my" && !!viewer.effectiveUserId;

  const ops = useMemo(
    () => (snapshot ? deriveOperations(snapshot, period) : null),
    [snapshot, period]
  );

  if (!ops) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader title="Operations" subtitle="Labor utilization, capacity, materials cost" />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">Salesforce not connected</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect in Admin → Integrations to populate ops metrics.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Operations"
        subtitle={`Labor capacity, utilization, materials · ${PERIOD_LABELS[period].toLowerCase()}`}
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
          <strong>Sandbox data.</strong> Production ops data will surface here once OAuth flips.
        </div>
      )}

      {/* Capacity headline */}
      <section className="bg-gradient-to-br from-ppp-navy to-ppp-charcoal text-white rounded-xl p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide font-semibold opacity-70">Backlog</div>
            <div className="font-condensed text-3xl sm:text-4xl font-bold mt-1">
              {ops.totalLaborDaysRemaining.toLocaleString()} <span className="text-lg opacity-70">labor-days</span>
            </div>
            <div className="text-xs opacity-70 mt-1">
              Total work remaining across all active WOs
            </div>
          </div>
          <div className="text-right text-[11px] opacity-70">
            <div>Utilization {period === "this-month" ? "MTD" : ""}:</div>
            <div className="font-condensed font-bold text-lg text-white">
              {ops.utilizationPct.toFixed(1)}%
            </div>
            <div className="text-[10px]">
              {ops.totalLaborDaysActual.toLocaleString()} of {ops.totalLaborDaysProjected.toLocaleString()} projected
            </div>
          </div>
        </div>
      </section>

      {/* Cost ratios */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Metric
          label="Materials Cost"
          value={fmtMoneyK(ops.totalMaterialsCost / 1000)}
          sub={`${ops.materialsRatio.toFixed(1)}% of revenue`}
          accent={ops.materialsRatio < 15 ? "green" : ops.materialsRatio < 25 ? "blue" : "orange"}
        />
        <Metric
          label="Labor Payouts"
          value={fmtMoneyK(ops.totalLaborPayout / 1000)}
          sub={`${ops.laborPayoutRatio.toFixed(1)}% of revenue`}
          accent={ops.laborPayoutRatio < 40 ? "green" : ops.laborPayoutRatio < 55 ? "blue" : "orange"}
        />
        <Metric
          label="Actual Labor"
          value={`${ops.totalLaborDaysActual.toLocaleString()}d`}
          sub={`vs ${ops.totalLaborDaysProjected.toLocaleString()}d projected`}
        />
        <Metric
          label="Remaining Backlog"
          value={`${ops.totalLaborDaysRemaining.toLocaleString()}d`}
          sub="work scheduled out"
        />
      </section>

      {/* Over-runs + top margins */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Labor Over-Runs</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            WOs taking longer than projected · {PERIOD_LABELS[period].toLowerCase()}
          </p>
          {ops.overRuns.length === 0 ? (
            <p className="text-xs text-ppp-charcoal-500 italic">No labor over-runs in this period. ✓</p>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {ops.overRuns.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 py-2.5 text-xs first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-medium text-ppp-charcoal truncate">
                      {w.account ?? "(no account)"}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500 truncate">
                      WO {w.workOrderNumber ?? w.id.slice(-6)} · projected {w.projected}d, actual {w.actual}d
                    </div>
                  </div>
                  <span className="font-semibold text-ppp-orange-700 whitespace-nowrap">
                    +{w.overByDays}d
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            {repScopedToSelf ? "Your Top Margin Jobs" : "Top Margin Jobs"}
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            Highest gross-profit % WOs · {PERIOD_LABELS[period].toLowerCase()}
          </p>
          {ops.topGPMargin.length === 0 ? (
            <p className="text-xs text-ppp-charcoal-500 italic">No GP data in this period.</p>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {ops.topGPMargin.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 py-2.5 text-xs first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-medium text-ppp-charcoal truncate">
                      {w.account ?? "(no account)"}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500 truncate">
                      {fmtMoneyK(w.revenue / 1000)} revenue · {fmtMoneyK(w.gp / 1000)} GP
                    </div>
                  </div>
                  <span className="font-semibold text-ppp-green-700 whitespace-nowrap">
                    {w.marginPct.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
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
