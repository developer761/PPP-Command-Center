import Link from "next/link";
import { redirect } from "next/navigation";
import PageHeader from "@/components/page-header";
import KPICard from "@/components/kpi-card";
import { getSignedInAdminEmail } from "@/lib/payments/access";
import { listLedgerPayments, paymentsConfig } from "@/lib/payments/service";
import { formatCents } from "@/lib/payments/schedule";
import {
  PAID_WITH_LABEL,
  RANGE_LABEL,
  STAGE_LABEL,
  filterLedger,
  ledgerQueryString,
  paidWith,
  parseLedgerQuery,
  paymentDateEt,
  stageOf,
  totalsOf,
  type LedgerPayment,
  type PaidWith,
  type RangePreset,
  type Stage,
} from "@/lib/payments/ledger";
import { etTodayIso } from "@/lib/date-et";
import { paymentsSalesforceBaseUrl } from "@/lib/salesforce/payments-org";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments · PPP Command Center" };

/**
 * Payments — every online invoice payment, with the BASE amount (what pays
 * down the job and what Salesforce gets) and the 3% CREDIT-CARD FEE (collected
 * on top, never booked into the Payment In) kept apart, plus what Stripe
 * charged PPP to process each one. Filter by date / how it was paid; Export
 * downloads exactly what's on screen.
 *
 * Admin-only: it's company revenue.
 */

type SP = Promise<Record<string, string | string[] | undefined>>;

const SF_FALLBACK = (process.env.SF_LOGIN_URL ?? "https://precisionplus.my.salesforce.com").replace(/\/$/, "");
/** A record link in the org the payments code is on (production, or the sandbox when testing). */
const sfLink = (base: string, id: string) => `${base}/${id}`;
const stripeLink = (pi: string, live: boolean) => `https://dashboard.stripe.com/${live ? "" : "test/"}payments/${pi}`;

const STAGE_CLS: Record<Stage, string> = {
  processing: "bg-sky-50 text-sky-800 border-sky-200",
  awaiting_payout: "bg-amber-50 text-amber-900 border-amber-200",
  cleared: "bg-emerald-50 text-emerald-800 border-emerald-200",
  booked: "bg-emerald-50 text-emerald-800 border-emerald-200",
  booking_failed: "bg-red-50 text-red-800 border-red-200",
  refunded: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200",
};

export default async function PaymentsPage({ searchParams }: { searchParams: SP }) {
  if (!(await getSignedInAdminEmail())) redirect("/dashboard");
  const sp = await searchParams;
  const cfg = paymentsConfig();
  const today = etTodayIso();
  // Show the mode the Stripe key is in, so a test setup isn't an empty page.
  const q = parseLedgerQuery(sp, today, cfg.stripeMode !== "test");
  const sfBase = await paymentsSalesforceBaseUrl().catch(() => SF_FALLBACK);

  let all: LedgerPayment[] = [];
  let loadError: string | null = null;
  try {
    all = (await listLedgerPayments()) as LedgerPayment[];
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  const rows = filterLedger(all, q);
  const t = totalsOf(rows);
  const qs = (over: Parameters<typeof ledgerQueryString>[1] = {}) => ledgerQueryString(q, over);
  const rangeText =
    q.from && q.to ? `${q.from} → ${q.to}` : q.from ? `from ${q.from}` : q.to ? `to ${q.to}` : "all time";

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="Payments"
        subtitle="Online invoice payments. Salesforce gets the base amount; the 3% credit-card fee is tracked here, separately."
        actions={
          <a
            href={`/api/payments/export?${qs()}`}
            className="inline-flex items-center gap-2 rounded-lg bg-ppp-navy text-white px-4 min-h-[44px] text-sm font-semibold hover:bg-ppp-navy-900"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12 M7 10l5 5 5-5 M5 21h14" />
            </svg>
            Export to Excel
          </a>
        }
      />

      {loadError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Couldn&rsquo;t load payments: {loadError}
          {/stripe_fee_cents|customer_name|payout_id|cleared_at/.test(loadError) &&
            " — run supabase/migrations/20261007190000_stripe_payments_ledger.sql."}
        </div>
      )}

      {/* Filters — plain links, so every view is a shareable URL and the export matches it. */}
      <section className="rounded-xl bg-white border border-ppp-charcoal-100 p-4 space-y-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Date range">
          {(Object.keys(RANGE_LABEL) as RangePreset[])
            .filter((p) => p !== "custom")
            .map((p) => (
              <Chip key={p} href={`?${qs({ preset: p })}`} active={q.preset === p}>
                {RANGE_LABEL[p]}
              </Chip>
            ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="range" value="custom" />
          <input type="hidden" name="mode" value={q.livemode ? "live" : "test"} />
          {q.paidWith !== "all" && <input type="hidden" name="with" value={q.paidWith} />}
          <label className="text-[12px] text-ppp-charcoal-600">
            From
            <input
              type="date"
              name="from"
              defaultValue={q.preset === "custom" ? (q.from ?? "") : ""}
              className="block mt-0.5 rounded-lg border border-ppp-charcoal-200 px-2 min-h-[44px] text-base sm:text-sm"
            />
          </label>
          <label className="text-[12px] text-ppp-charcoal-600">
            To
            <input
              type="date"
              name="to"
              defaultValue={q.preset === "custom" ? (q.to ?? "") : ""}
              className="block mt-0.5 rounded-lg border border-ppp-charcoal-200 px-2 min-h-[44px] text-base sm:text-sm"
            />
          </label>
          <button
            type="submit"
            className={`rounded-lg border px-3 min-h-[44px] text-sm font-semibold ${
              q.preset === "custom" ? "border-ppp-navy bg-ppp-navy text-white" : "border-ppp-charcoal-200 text-ppp-navy"
            }`}
          >
            Custom range
          </button>
        </form>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Paid with">
          <Chip href={`?${qs({ paidWith: "all" })}`} active={q.paidWith === "all"}>
            All
          </Chip>
          {(Object.keys(PAID_WITH_LABEL) as PaidWith[]).map((w) => (
            <Chip key={w} href={`?${qs({ paidWith: w })}`} active={q.paidWith === w}>
              {PAID_WITH_LABEL[w]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ppp-charcoal-600">
          <span>Showing</span>
          <Chip href={`?${qs({ livemode: true })}`} active={q.livemode}>
            Real payments
          </Chip>
          <Chip href={`?${qs({ livemode: false })}`} active={!q.livemode}>
            Stripe test payments
          </Chip>
          <span>· {rangeText}</span>
        </div>
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard
          label="Collected (to Salesforce)"
          value={formatCents(t.baseCents)}
          change={`${t.count} payment${t.count === 1 ? "" : "s"}`}
          trend="flat"
          accent="blue"
          hint="Base amounts — what pays down the jobs and what's booked as Payment Ins. No card fees."
        />
        <KPICard
          label="Card fees collected"
          value={formatCents(t.feeCents)}
          change={`${t.byPaidWith.credit.count} credit-card payment${t.byPaidWith.credit.count === 1 ? "" : "s"}`}
          trend="flat"
          accent="orange"
          hint="The 3% charged on credit cards. Debit, prepaid and bank payments carry none."
        />
        <KPICard
          label="Total charged"
          value={formatCents(t.totalCents)}
          change="Base + card fees"
          trend="flat"
          accent="green"
          hint="What customers actually paid through Stripe."
        />
        <KPICard
          label="Stripe's cost to PPP"
          value={t.stripeFeeKnownCount ? formatCents(t.stripeFeeCents) : "—"}
          change={
            t.stripeFeeKnownCount
              ? `Fees ${t.feeNetCents >= 0 ? "cover it by" : "fall short by"} ${formatCents(Math.abs(t.feeNetCents))}`
              : "Known once payments clear"
          }
          trend={t.stripeFeeKnownCount ? (t.feeNetCents >= 0 ? "up" : "down") : "flat"}
          accent="blue"
          hint={`What Stripe kept for processing, from the payouts. Known for ${t.stripeFeeKnownCount} of ${t.count} payments — the rest haven't cleared yet.`}
        />
      </section>

      <section className="rounded-xl bg-white border border-ppp-charcoal-100 overflow-x-auto">
        <h2 className="text-base font-semibold text-ppp-charcoal px-5 pt-5 pb-3">By how it was paid</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[12px] text-ppp-charcoal-500 border-b border-ppp-charcoal-100">
              <th className="px-5 py-2 font-medium">Paid with</th>
              <th className="px-3 py-2 font-medium text-right">Payments</th>
              <th className="px-3 py-2 font-medium text-right">Base</th>
              <th className="px-3 py-2 font-medium text-right">Card fees</th>
              <th className="px-5 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {(Object.keys(PAID_WITH_LABEL) as PaidWith[])
              .filter((w) => t.byPaidWith[w].count > 0)
              .map((w) => (
                <tr key={w} className="border-b border-ppp-charcoal-50 last:border-0">
                  <td className="px-5 py-2 text-ppp-charcoal">{PAID_WITH_LABEL[w]}</td>
                  <td className="px-3 py-2 text-right">{t.byPaidWith[w].count}</td>
                  <td className="px-3 py-2 text-right">{formatCents(t.byPaidWith[w].baseCents)}</td>
                  <td className="px-3 py-2 text-right">{formatCents(t.byPaidWith[w].feeCents)}</td>
                  <td className="px-5 py-2 text-right font-semibold">{formatCents(t.byPaidWith[w].totalCents)}</td>
                </tr>
              ))}
            {t.count === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-4 text-ppp-charcoal-500">
                  No payments in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {t.refundedCount > 0 && (
          <p className="px-5 py-3 text-[12px] text-ppp-charcoal-600 border-t border-ppp-charcoal-100">
            Not counted above: {t.refundedCount} refunded payment{t.refundedCount === 1 ? "" : "s"} ({formatCents(t.refundedCents)}).
          </p>
        )}
      </section>

      <section className="rounded-xl bg-white border border-ppp-charcoal-100">
        <h2 className="text-base font-semibold text-ppp-charcoal px-5 pt-5 pb-3">
          Payments <span className="text-ppp-charcoal-500 font-normal">({rows.length})</span>
        </h2>
        {rows.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ppp-charcoal-500">
            Nothing here for {rangeText}
            {q.paidWith !== "all" ? ` paid by ${PAID_WITH_LABEL[q.paidWith].toLowerCase()}` : ""}.
          </p>
        ) : (
          <>
            {/* Desktop */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[12px] text-ppp-charcoal-500 border-b border-ppp-charcoal-100">
                    <th className="px-5 py-2 font-medium">Paid</th>
                    <th className="px-3 py-2 font-medium">Customer · Work Order</th>
                    <th className="px-3 py-2 font-medium">Paid with</th>
                    <th className="px-3 py-2 font-medium text-right">Base</th>
                    <th className="px-3 py-2 font-medium text-right">Card fee</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                    <th className="px-3 py-2 font-medium text-right">Stripe cost</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {rows.map((p) => (
                    <tr key={p.id} className="border-b border-ppp-charcoal-50 last:border-0 align-top">
                      <td className="px-5 py-3 whitespace-nowrap">{paymentDateEt(p)}</td>
                      <td className="px-3 py-3">
                        <div className="font-semibold text-ppp-charcoal">{p.customer_name ?? "—"}</div>
                        <div className="text-[12px] text-ppp-charcoal-600">
                          <a href={sfLink(sfBase, p.work_order_id)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            WO {p.work_order_number}
                          </a>{" "}
                          · {p.milestone_label}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">{PAID_WITH_LABEL[paidWith(p)]}</td>
                      <td className="px-3 py-3 text-right">{formatCents(p.base_cents)}</td>
                      <td className="px-3 py-3 text-right">{p.fee_cents ? formatCents(p.fee_cents) : "—"}</td>
                      <td className="px-3 py-3 text-right font-semibold">{formatCents(p.total_cents)}</td>
                      <td className="px-3 py-3 text-right">{p.stripe_fee_cents == null ? "—" : formatCents(p.stripe_fee_cents)}</td>
                      <td className="px-5 py-3">
                        <StageChip p={p} />
                        <RowLinks p={p} sfBase={sfBase} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile */}
            <ul className="md:hidden divide-y divide-ppp-charcoal-100">
              {rows.map((p) => (
                <li key={p.id} className="px-4 py-3 space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-ppp-charcoal truncate">{p.customer_name ?? "—"}</div>
                      <div className="text-[12px] text-ppp-charcoal-600">
                        {paymentDateEt(p)} · WO {p.work_order_number} · {p.milestone_label}
                      </div>
                    </div>
                    <div className="text-right tabular-nums shrink-0">
                      <div className="font-semibold">{formatCents(p.total_cents)}</div>
                      <div className="text-[11px] text-ppp-charcoal-600">{PAID_WITH_LABEL[paidWith(p)]}</div>
                    </div>
                  </div>
                  <div className="text-[12px] text-ppp-charcoal-600 tabular-nums">
                    Base {formatCents(p.base_cents)}
                    {p.fee_cents ? ` + fee ${formatCents(p.fee_cents)}` : " · no fee"}
                    {p.stripe_fee_cents != null && ` · Stripe ${formatCents(p.stripe_fee_cents)}`}
                  </div>
                  <StageChip p={p} />
                  <RowLinks p={p} sfBase={sfBase} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="text-[12px] text-ppp-charcoal-500">
        Payment links, test tools and Stripe settings live in{" "}
        <Link href="/dashboard/settings/payments" className="underline underline-offset-2">
          Settings → Online Payments
        </Link>
        .
      </p>
    </div>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex items-center rounded-full border px-3 min-h-[36px] text-[13px] font-semibold ${
        active ? "border-ppp-navy bg-ppp-navy text-white" : "border-ppp-charcoal-200 bg-white text-ppp-navy hover:bg-ppp-charcoal-50"
      }`}
    >
      {children}
    </Link>
  );
}

function StageChip({ p }: { p: LedgerPayment }) {
  const s = stageOf(p);
  return (
    <span className={`inline-block text-[11px] font-semibold border rounded-full px-2 py-0.5 ${STAGE_CLS[s]}`}>
      {STAGE_LABEL[s]}
      {!p.livemode && " · TEST"}
    </span>
  );
}

function RowLinks({ p, sfBase }: { p: LedgerPayment; sfBase: string }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 text-[12px]">
      {p.payment_intent_id && (
        <a href={stripeLink(p.payment_intent_id, p.livemode)} target="_blank" rel="noreferrer" className="text-ppp-navy underline underline-offset-2">
          Stripe
        </a>
      )}
      {p.sf_transaction_id && (
        <a href={sfLink(sfBase, p.sf_transaction_id)} target="_blank" rel="noreferrer" className="text-ppp-navy underline underline-offset-2">
          Payment In
        </a>
      )}
    </div>
  );
}
