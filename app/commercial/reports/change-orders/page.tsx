import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getChangeOrderVendorReport } from "@/lib/commercial/reports/change-orders-vendors";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { etTodayIso } from "@/lib/date-et";

/**
 * Change orders & vendor spend — one page, two sections, because they answer
 * the same question from opposite ends: what did this job cost beyond the
 * contract, and who did we pay.
 *
 * The headline is deliberately "approved and not billed". Everything else here
 * is history; that one is money the GC has already agreed to pay and nobody
 * has invoiced.
 */

export const dynamic = "force-dynamic";

type Preset = "last_90" | "this_year" | "last_year" | "all";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "all", label: "All time" },
];

function rangeFor(preset: Preset): { fromYmd: string; toYmd: string; label: string } {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  switch (preset) {
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "last_year":
      return { fromYmd: `${y - 1}-01-01`, toYmd: `${y - 1}-12-31`, label: `${y - 1}` };
    case "all":
      return { fromYmd: "2000-01-01", toYmd: today, label: "all time" };
    case "last_90":
    default: {
      const d = new Date(Date.UTC(y, Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))));
      d.setUTCDate(d.getUTCDate() - 89);
      return { fromYmd: d.toISOString().slice(0, 10), toYmd: today, label: "last 90 days" };
    }
  }
}

export default async function ChangeOrdersReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const sp = await searchParams;
  const raw = Array.isArray(sp.preset) ? sp.preset[0] : sp.preset;
  const preset: Preset = PRESETS.some((p) => p.key === raw) ? (raw as Preset) : "this_year";
  const range = rangeFor(preset);
  const r = await getChangeOrderVendorReport(range);
  const co = r.co;
  const mergedVendors = r.vendors.filter((v) => v.variants > 1).length;
  const topVendorPct =
    r.vendorTotalCents > 0 && r.vendors[0]
      ? Math.round((r.vendors[0].cents / r.vendorTotalCents) * 100)
      : null;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-ppp-charcoal">Change orders &amp; vendor spend</h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-2xl">
          What the jobs cost beyond the contract, and who got paid. Change orders are counted from when
          they were <strong>raised</strong>; adds and credits are kept apart, because a job with $50k added
          and $50k credited is not a job with no change orders.
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/commercial/reports/change-orders?preset=${p.key}`}
            aria-current={p.key === preset ? "page" : undefined}
            className={`inline-flex items-center px-3 rounded-lg text-[12px] font-semibold min-h-[44px] sm:min-h-[34px] border transition-colors ${
              p.key === preset
                ? "bg-cc-brand-600 text-white border-cc-brand-600"
                : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {/* The one number here that is money on the floor rather than history. */}
      {co.unbilledCount > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5">
          <p className="text-[13.5px] font-bold text-amber-900">
            {formatCentsFull(co.unbilledCents)} in approved change orders has never been invoiced.
          </p>
          <p className="text-[12px] text-amber-800 mt-0.5">
            {co.unbilledCount} change order{co.unbilledCount === 1 ? "" : "s"} the GC has agreed to pay for
            and nobody has asked them for. Bill them from each deal&rsquo;s Invoices tab.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">Change orders · {range.label}</h3>

        {co.raised === 0 ? (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-6 text-center">
            <p className="text-[13px] font-semibold text-ppp-charcoal">No change orders raised in {range.label}.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi label="Raised" value={String(co.raised)} sub={`${co.pending.count} still pending`} />
              <Kpi
                label="Approval rate"
                value={co.approvalRatePct === null ? "—" : `${co.approvalRatePct}%`}
                sub={co.approvalRatePct === null ? "nothing decided yet" : `${co.approved.count} approved · ${co.declined.count} declined`}
                tone={co.approvalRatePct === null ? undefined : co.approvalRatePct >= 75 ? "good" : undefined}
              />
              <Kpi
                label="Added scope"
                value={formatCentsCompact(co.approvedAddCents)}
                sub={co.approvedDeductCents > 0 ? `less ${formatCentsCompact(co.approvedDeductCents)} credited` : "approved"}
                tone="good"
              />
              <Kpi
                label="Avg days to decide"
                value={co.avgDaysToDecide === null ? "—" : `${co.avgDaysToDecide}d`}
                sub={co.decidedSample > 0 ? `over ${co.decidedSample}` : "none decided"}
              />
            </div>

            {co.byAccount.length > 0 && (
              <Table
                head={["GC", "Approved", "Added", "Credited", "Pending"]}
                rows={co.byAccount.map((a) => ({
                  href: `/commercial/accounts/${a.accountId}`,
                  cells: [
                    a.accountName,
                    String(a.approvedCount),
                    formatCentsCompact(a.approvedAddCents),
                    a.approvedDeductCents > 0 ? `−${formatCentsCompact(a.approvedDeductCents)}` : "—",
                    a.pendingCount > 0 ? String(a.pendingCount) : "—",
                  ],
                }))}
                hint="Most added scope first. Credits shown separately, never netted against adds."
              />
            )}
          </>
        )}
      </section>

      <section className="space-y-3 pt-2">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">Vendor spend · {range.label}</h3>

        {r.vendorTotalCents === 0 ? (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-6 text-center">
            <p className="text-[13px] font-semibold text-ppp-charcoal">No purchases logged in {range.label}.</p>
            <p className="text-[12px] text-ppp-charcoal-500 mt-1">
              Purchases are logged on each deal&rsquo;s Transactions tab.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Kpi label="Total spend" value={formatCentsFull(r.vendorTotalCents)} sub={`${r.vendors.length} vendor${r.vendors.length === 1 ? "" : "s"}`} />
              <Kpi
                label="Biggest vendor"
                value={r.vendors[0] ? formatCentsCompact(r.vendors[0].cents) : "—"}
                sub={r.vendors[0] ? `${r.vendors[0].name} · ${topVendorPct}% of spend` : undefined}
              />
              <Kpi
                label="Unattributed"
                value={r.unattributedCents > 0 ? formatCentsCompact(r.unattributedCents) : "—"}
                sub={r.unattributedCount > 0 ? `${r.unattributedCount} with no vendor` : "every purchase named"}
                tone={r.unattributedCents > 0 ? "warn" : undefined}
              />
            </div>

            {r.categories.length > 0 && (
              <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {r.categories.map((c) => (
                    <div key={c.category}>
                      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{c.label}</div>
                      <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(c.cents)}</div>
                      <div className="text-[10px] text-ppp-charcoal-400 tabular-nums">{c.count} purchase{c.count === 1 ? "" : "s"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vendor names are typed by hand, so a row may have folded several
                spellings together. Saying so beats a silent merge. */}
            {mergedVendors > 0 && (
              <p className="text-[11.5px] text-ppp-charcoal-500">
                {mergedVendors} vendor{mergedVendors === 1 ? " row combines" : " rows combine"} more than one
                spelling of the same name — hover a row to see how many.
              </p>
            )}

            <Table
              head={["Vendor", "Mostly", "Purchases", "Spend"]}
              rows={r.vendors.map((v) => ({
                title: v.variants > 1 ? `${v.variants} spellings of this name were combined` : undefined,
                cells: [
                  v.variants > 1 ? `${v.name} *` : v.name,
                  v.topCategory,
                  String(v.count),
                  formatCentsCompact(v.cents),
                ],
              }))}
              hint="Biggest spend first."
            />
          </>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div
        className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 ${
          tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-ppp-charcoal"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Table({
  head,
  rows,
  hint,
}: {
  head: string[];
  rows: { cells: string[]; href?: string; title?: string }[];
  hint: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-ppp-charcoal-100">
        <p className="text-[11.5px] text-ppp-charcoal-500">{hint}</p>
      </div>
      {/* Scrolls inside itself so the page never slides sideways on a phone. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-[12.5px]">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60">
              {head.map((h, i) => (
                <th key={h} className={`px-4 py-2 ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ppp-charcoal-100">
            {rows.map((row, i) => (
              <tr key={`${row.cells[0]}-${i}`} className="hover:bg-ppp-charcoal-50/60" title={row.title}>
                {row.cells.map((cell, j) => (
                  <td key={j} className={`px-4 py-2.5 ${j === 0 ? "text-left font-semibold text-ppp-charcoal" : "text-right tabular-nums text-ppp-charcoal-700"}`}>
                    {j === 0 && row.href ? (
                      <Link href={row.href} className="hover:text-cc-brand-700 hover:underline">{cell}</Link>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
