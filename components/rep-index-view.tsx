"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import PageHeader from "@/components/page-header";
import {
  PERIOD_LABELS,
  reps as mockReps,
  type Period,
} from "@/lib/mock-data";
import { deriveRepsForPeriod } from "@/lib/salesforce/derive";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  ["7d", "30d", "90d", "6m", "12m", "ytd"] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

type Props = {
  bundle: LiveDashboardBundle;
};

export default function RepIndexView({ bundle }: Props) {
  const [period, setPeriod] = useState<Period>("30d");

  const { source, reason, snapshot } = bundle;

  const reps = useMemo(() => {
    if (snapshot) return deriveRepsForPeriod(snapshot, period);
    return mockReps;
  }, [snapshot, period]);

  const teamRevenue = useMemo(
    () => reps.reduce((s, r) => s + r.revenueSold, 0),
    [reps]
  );

  const sorted = useMemo(
    () => [...reps].sort((a, b) => b.revenueSold - a.revenueSold),
    [reps]
  );

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Rep Profiles"
        subtitle={
          source === "salesforce"
            ? `${reps.length} active rep${reps.length === 1 ? "" : "s"} · metrics scoped to ${PERIOD_LABELS[period].toLowerCase()}`
            : reason === "sf_not_connected"
            ? "Salesforce isn't connected yet — showing demo data. Connect SF in Admin → Integrations to see real PPP reps."
            : reason === "sf_returned_no_reps"
            ? "Salesforce returned no reps — showing demo data. The sandbox may be empty."
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

      {source === "mock" && reason && reason !== "sf_not_connected" && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Live data unavailable:</strong> {reason}. Falling back to demo data.
        </div>
      )}

      {reps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">No reps to show</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect Salesforce in Admin → Integrations to populate this view.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {sorted.map((r) => {
            const teamShare = teamRevenue > 0
              ? Math.round((r.revenueSold / teamRevenue) * 100)
              : 0;
            const inactive = r.revenueSold === 0 && r.openPipeline === 0;
            return (
              <Link
                key={r.id}
                href={`/dashboard/rep/${r.id}`}
                className={[
                  "group bg-white border rounded-xl p-5 transition-all",
                  inactive
                    ? "border-ppp-charcoal-100 opacity-70 hover:opacity-100 hover:border-ppp-blue-200"
                    : "border-ppp-charcoal-100 hover:border-ppp-blue-200 hover:shadow-md hover:shadow-ppp-charcoal/5",
                ].join(" ")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-full bg-ppp-blue-50 text-ppp-blue text-sm font-bold flex items-center justify-center">
                    {r.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-ppp-charcoal group-hover:text-ppp-blue transition-colors truncate">
                      {r.name}
                    </div>
                    <div className="text-[11px] text-ppp-charcoal-500 truncate">
                      {r.region} · {r.serviceLine}
                      {inactive && <span className="ml-1 text-ppp-charcoal-200">· no activity</span>}
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="font-condensed text-base font-bold text-ppp-navy">
                      ${r.revenueSold}K
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                      Revenue
                    </div>
                  </div>
                  <div>
                    <div className="font-condensed text-base font-bold text-ppp-navy">
                      {r.closeRate.toFixed(1)}%
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                      Close
                    </div>
                  </div>
                  <div>
                    <div className="font-condensed text-base font-bold text-ppp-navy">
                      ${r.avgTicket.toFixed(1)}K
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mt-0.5">
                      Ticket
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-ppp-charcoal-100 flex items-center justify-between">
                  <span className="text-[11px] text-ppp-charcoal-500">
                    {teamShare}% of team revenue
                  </span>
                  <span className="text-[11px] font-medium text-ppp-blue opacity-0 group-hover:opacity-100 transition-opacity">
                    Open profile →
                  </span>
                </div>
              </Link>
            );
          })}
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
