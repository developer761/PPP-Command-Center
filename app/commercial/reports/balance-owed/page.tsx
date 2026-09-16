import { redirect } from "next/navigation";
import Link from "next/link";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getBalanceOwedRows, BALANCE_OWED_SPEC } from "@/lib/commercial/reports/tomco/balance-owed";
import { GroupedReport } from "@/components/commercial/grouped-report";

export const dynamic = "force-dynamic";

/**
 * Balance Owed — the report Brendan and Mary both run, in the shape they run it.
 *
 * `?view=` picks the grouping. Mary chases by GC, Brendan works by status, and
 * the money is identical either way, which is the point of offering both rather
 * than choosing for them.
 */
const VIEWS = [
  { key: "account-status", label: "By GC, then status", index: 0 },
  { key: "status", label: "By status", index: 1 },
  { key: "account", label: "By GC", index: 2 },
];

export default async function BalanceOwedReportPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "balance-owed");

  const sp = await searchParams;
  const view = VIEWS.find((v) => v.key === sp.view) ?? VIEWS[0];
  const rows = await getBalanceOwedRows();
  // Biggest balance first, which is the order anyone chasing money wants; the
  // grouping preserves it.
  rows.sort((a, b) => b.balanceCents - a.balanceCents);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-400">
          {BALANCE_OWED_SPEC.sourceLabel}
        </p>
        <h2 className="text-lg font-bold text-ppp-charcoal leading-tight">{BALANCE_OWED_SPEC.title}</h2>
        {BALANCE_OWED_SPEC.blurb && (
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-2xl">{BALANCE_OWED_SPEC.blurb}</p>
        )}
      </div>

      <GroupedReport
        spec={BALANCE_OWED_SPEC}
        rows={rows}
        groupingIndex={view.index}
        emptyHint="Nothing is finished-and-unpaid right now. A job lands here once its work order is complete or on hold with a balance outstanding."
        controls={
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">Group by</span>
            {VIEWS.map((v) => {
              const active = v.key === view.key;
              return (
                <Link
                  key={v.key}
                  href={`/commercial/reports/balance-owed?view=${v.key}`}
                  aria-current={active ? "true" : undefined}
                  className={`px-2.5 rounded-lg border text-[12px] font-semibold min-h-[36px] inline-flex items-center transition-colors ${
                    active
                      ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                      : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  {v.label}
                </Link>
              );
            })}
          </div>
        }
      />
    </div>
  );
}
