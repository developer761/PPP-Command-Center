import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getArAging, type ArAgingBuckets } from "@/lib/commercial/reports/ar-aging";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import Link from "next/link";

export const dynamic = "force-dynamic";

const BUCKETS: { key: keyof Omit<ArAgingBuckets, "total">; label: string; danger?: boolean }[] = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1–30" },
  { key: "d31_60", label: "31–60" },
  { key: "d61_90", label: "61–90", danger: true },
  { key: "d90_plus", label: "90+", danger: true },
];

export default async function ArAgingReportPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const aging = await getArAging();
  const overdue = aging.totals.total - aging.totals.current;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">AR Aging</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            Open invoice balances by how far past due they are, per customer.
          </p>
        </div>
        {aging.invoiceCount > 0 && (
          <a
            href="/api/commercial/reports/ar-aging/export"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[13px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export CSV
          </a>
        )}
      </div>

      {aging.invoiceCount === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No open receivables</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">
            Every issued invoice is paid or there&rsquo;s nothing billed yet. Aging shows up here the moment a customer owes money.
          </p>
          <Link
            href="/commercial/invoices"
            className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            View all invoices
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
        </div>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tile label="Total AR" value={formatCentsCompact(aging.totals.total)} tone="brand" />
            <Tile label="Overdue" value={formatCentsCompact(overdue)} tone={overdue > 0 ? "amber" : "neutral"} sub={aging.totals.total > 0 ? `${Math.round((overdue / aging.totals.total) * 100)}% of AR` : undefined} />
            <Tile label="90+ days" value={formatCentsCompact(aging.totals.d90_plus)} tone={aging.totals.d90_plus > 0 ? "rose" : "neutral"} />
            <Tile label="Customers owing" value={String(aging.customerCount)} tone="neutral" sub={`${aging.invoiceCount} invoice${aging.invoiceCount === 1 ? "" : "s"}`} />
          </div>

          {/* Aging table */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px] min-w-[640px]">
                <thead>
                  <tr className="text-ppp-charcoal-500 border-b border-ppp-charcoal-200 bg-ppp-charcoal-50/50">
                    <th className="text-left font-semibold px-3 py-2.5">Customer</th>
                    {BUCKETS.map((b) => (
                      <th key={b.key} className="text-right font-semibold px-3 py-2.5">{b.label}</th>
                    ))}
                    <th className="text-right font-bold px-3 py-2.5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {aging.rows.map((r) => (
                    <tr key={r.accountId} className="border-b border-ppp-charcoal-50 hover:bg-cc-brand-50/30">
                      <td className="px-3 py-2.5">
                        <Link href={`/commercial/accounts/${r.accountId}`} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700">
                          {r.accountName}
                        </Link>
                        <span className="block text-[10.5px] text-ppp-charcoal-400">{r.invoiceCount} open · oldest {Math.max(0, r.oldestDays)}d</span>
                      </td>
                      {BUCKETS.map((b) => (
                        <td key={b.key} className={`text-right px-3 py-2.5 tabular-nums ${r[b.key] > 0 && b.danger ? "text-rose-600 font-semibold" : r[b.key] > 0 ? "text-ppp-charcoal-700" : "text-ppp-charcoal-300"}`}>
                          {r[b.key] > 0 ? formatCentsFull(r[b.key]) : "—"}
                        </td>
                      ))}
                      <td className="text-right px-3 py-2.5 tabular-nums font-bold text-ppp-charcoal">{formatCentsFull(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
                    <td className="px-3 py-2.5 text-ppp-charcoal">All customers</td>
                    {BUCKETS.map((b) => (
                      <td key={b.key} className={`text-right px-3 py-2.5 tabular-nums ${aging.totals[b.key] > 0 && b.danger ? "text-rose-700" : "text-ppp-charcoal-700"}`}>
                        {aging.totals[b.key] > 0 ? formatCentsFull(aging.totals[b.key]) : "—"}
                      </td>
                    ))}
                    <td className="text-right px-3 py-2.5 tabular-nums text-ppp-charcoal">{formatCentsFull(aging.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "brand" | "amber" | "rose" | "neutral" }) {
  const v = tone === "brand" ? "text-cc-brand-700" : tone === "amber" ? "text-amber-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] font-black tabular-nums leading-tight mt-0.5 ${v}`}>{value}</div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}
