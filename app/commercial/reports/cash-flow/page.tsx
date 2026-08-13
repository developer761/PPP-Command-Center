import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getCashFlowReport } from "@/lib/commercial/reports/cash-flow";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { etTodayIso } from "@/lib/date-et";

/**
 * Cash flow & collections.
 *
 * Sits beside AR aging on purpose, and each answers half of one question:
 * aging is the snapshot (what is owed, how late), this is the trend (what
 * actually arrived, how slowly). They link to each other both ways so nobody
 * has to remember which one holds which half.
 *
 * Not admin-gated — this is company money, not per-person performance.
 */

export const dynamic = "force-dynamic";

type Preset = "last_6m" | "last_12m" | "this_year" | "last_year";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "last_6m", label: "Last 6 months" },
  { key: "last_12m", label: "Last 12 months" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
];

function rangeFor(preset: Preset): { fromYmd: string; toYmd: string; label: string } {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  const backMonths = (n: number) => {
    const total = (y * 12 + (m - 1)) - n;
    return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
  };
  switch (preset) {
    case "last_12m":
      return { fromYmd: backMonths(11), toYmd: today, label: "Last 12 months" };
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "last_year":
      return { fromYmd: `${y - 1}-01-01`, toYmd: `${y - 1}-12-31`, label: `${y - 1}` };
    case "last_6m":
    default:
      return { fromYmd: backMonths(5), toYmd: today, label: "Last 6 months" };
  }
}

export default async function CashFlowReportPage({
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
  const preset: Preset = PRESETS.some((p) => p.key === raw) ? (raw as Preset) : "last_6m";
  const range = rangeFor(preset);
  const r = await getCashFlowReport(range);
  const t = r.totals;

  const peak = Math.max(1, ...r.months.map((m) => Math.max(m.collectedCents, m.billedCents)));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-ppp-charcoal">Cash flow &amp; collections</h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 max-w-2xl">
            Money that actually arrived, by the month it arrived in — a March invoice paid in July is
            July&rsquo;s cash. Days-to-pay is weighted by amount, so a large slow wire counts for more than
            a small slow cheque.
          </p>
        </div>
        <Link
          href="/commercial/reports/ar-aging"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] sm:min-h-0"
        >
          What&rsquo;s still owed →
        </Link>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/commercial/reports/cash-flow?preset=${p.key}`}
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

      {t.paymentCount === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <p className="text-[13px] font-semibold text-ppp-charcoal">No payments recorded in {range.label.toLowerCase()}.</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            Cash shows up here as payments are recorded against invoices. If money has come in, it needs
            logging on the invoice first.
          </p>
          <Link href="/commercial/invoices" className="inline-flex items-center mt-3 text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px]">
            Go to invoices →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi label="Collected" value={formatCentsFull(t.collectedCents)} sub={`${t.paymentCount} payment${t.paymentCount === 1 ? "" : "s"}`} tone="good" />
            <Kpi label="Billed (pre-tax)" value={formatCentsFull(t.billedCents)} sub="issued in this window" />
            <Kpi
              label="Avg days to pay"
              value={t.avgDaysToPay === null ? "—" : `${t.avgDaysToPay}d`}
              sub="weighted by amount"
              tone={t.avgDaysToPay === null ? undefined : t.avgDaysToPay > 60 ? "bad" : t.avgDaysToPay <= 30 ? "good" : undefined}
            />
            <Kpi label="Still owed" value={formatCentsFull(t.openCents)} sub="right now, all invoices" tone={t.openCents > 0 ? "warn" : undefined} />
          </div>

          {(r.untimedPayments > 0 || r.paidBeforeIssued > 0) && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-900 space-y-0.5">
              {r.untimedPayments > 0 && (
                <p>
                  <strong className="font-semibold">{r.untimedPayments}</strong> payment
                  {r.untimedPayments === 1 ? "" : "s"} landed on an invoice with no issue date, so
                  {r.untimedPayments === 1 ? " it is" : " they are"} counted in the cash but left out of
                  days-to-pay.
                </p>
              )}
              {r.paidBeforeIssued > 0 && (
                <p>
                  <strong className="font-semibold">{r.paidBeforeIssued}</strong> arrived before the invoice
                  was issued — deposits. Counted as same-day rather than as negative time.
                </p>
              )}
            </div>
          )}

          {/* Billed vs collected, side by side per month. The gap between the
              pair IS the story: bars that keep separating mean work going out
              faster than money coming back. */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <h3 className="text-[13px] font-bold text-ppp-charcoal">Billed vs collected</h3>
              <div className="flex items-center gap-3 text-[10.5px] text-ppp-charcoal-500">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-ppp-charcoal-300" />Billed</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" />Collected</span>
              </div>
            </div>
            <div className="flex items-end gap-2 h-32 overflow-x-auto">
              {r.months.map((m) => (
                <div key={m.key} className="flex flex-col items-center gap-1 min-w-[44px] flex-1">
                  <div className="flex items-end gap-0.5 h-24 w-full justify-center">
                    <div
                      className="w-1/2 max-w-[16px] rounded-t bg-ppp-charcoal-300 min-h-[2px]"
                      style={{ height: `${Math.round((m.billedCents / peak) * 92)}px` }}
                      title={`${m.label} · billed ${formatCentsCompact(m.billedCents)}`}
                    />
                    <div
                      className="w-1/2 max-w-[16px] rounded-t bg-emerald-500 min-h-[2px]"
                      style={{ height: `${Math.round((m.collectedCents / peak) * 92)}px` }}
                      title={`${m.label} · collected ${formatCentsCompact(m.collectedCents)}`}
                    />
                  </div>
                  <span className="text-[9px] text-ppp-charcoal-400 whitespace-nowrap">{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          {r.byMethod.length > 0 && (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-2">How it arrived</h3>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {r.byMethod.map((m) => (
                  <div key={m.method}>
                    <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{m.label}</div>
                    <div className="text-[14px] font-bold text-ppp-charcoal tabular-nums">{formatCentsCompact(m.collectedCents)}</div>
                    <div className="text-[10px] text-ppp-charcoal-400 tabular-nums">{m.count} payment{m.count === 1 ? "" : "s"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-ppp-charcoal-100">
              <h3 className="text-[13px] font-bold text-ppp-charcoal">Who pays slowly</h3>
              <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
                Slowest first — the list to chase. &ldquo;Still owed&rdquo; is today&rsquo;s balance, not this window&rsquo;s.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] text-[12.5px]">
                <thead>
                  <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60">
                    <th className="px-4 py-2 text-left">Customer</th>
                    <th className="px-4 py-2 text-right">Days to pay</th>
                    <th className="px-4 py-2 text-right">Collected</th>
                    <th className="px-4 py-2 text-right">Still owed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {r.slowest.map((s) => (
                    <tr key={s.accountId} className="hover:bg-ppp-charcoal-50/60">
                      <td className="px-4 py-2.5 text-left font-semibold text-ppp-charcoal">
                        <Link href={`/commercial/accounts/${s.accountId}`} className="hover:text-cc-brand-700 hover:underline">
                          {s.accountName}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {s.avgDaysToPay === null ? (
                          <span className="text-ppp-charcoal-400">—</span>
                        ) : (
                          <span className={s.avgDaysToPay > 60 ? "text-rose-700 font-semibold" : s.avgDaysToPay <= 30 ? "text-emerald-700" : "text-ppp-charcoal-700"}>
                            {s.avgDaysToPay}d
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">{formatCentsCompact(s.collectedCents)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ppp-charcoal-700">
                        {s.openCents > 0 ? formatCentsCompact(s.openCents) : <span className="text-ppp-charcoal-400">clear</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div
        className={`font-condensed text-[20px] font-black tabular-nums leading-tight mt-0.5 ${
          tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : tone === "warn" ? "text-amber-700" : "text-ppp-charcoal"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5">{sub}</div>}
    </div>
  );
}
