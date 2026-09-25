import { DateField } from "@/components/commercial/date-field";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import type { AiaPayment } from "@/lib/commercial/aia/payments";

/**
 * Money received against ONE application.
 *
 * Stephanie 2026-09-24: *"At times we would need to record multiple payments
 * against 1 AIA."* And the day before, on an AIA-billed job: *"when I went
 * into record the payment, it didn't show up on the list because it was billed
 * as AIA."*
 *
 * Deliberately the same shape as the invoice's payment list — amount, date,
 * method, reference, remove — because the two ledgers should read the same
 * way. Nobody should have to learn a second vocabulary for "we got paid"
 * depending on how the job happens to be billed.
 *
 * The status follows the money rather than the other way round: entering
 * enough to cover Total Earned Less Retainage marks the certificate paid, and
 * removing a payment puts it back to submitted. That is why this panel has no
 * "mark paid" button of its own — it would be a second source of truth for the
 * same fact.
 */

const INPUT =
  "w-full rounded-lg border border-ppp-charcoal-200 px-2.5 py-2 text-[13px] min-h-[44px] focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function etDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AiaPaymentsPanel({
  applicationId,
  applicationNumber,
  accountId,
  dealId,
  back,
  from,
  origin,
  payments,
  earnedLessRetainageCents,
  recordAction,
  deleteAction,
  migrationPending = false,
}: {
  applicationId: string;
  applicationNumber: number;
  accountId: string;
  dealId: string;
  back: string;
  from: string;
  origin: string;
  payments: AiaPayment[];
  /** G702 line 6 — what this certificate is asking for. */
  earnedLessRetainageCents: number;
  recordAction: (formData: FormData) => void | Promise<void>;
  deleteAction: (formData: FormData) => void | Promise<void>;
  /** The payments table isn't there yet (migration not pasted in). */
  migrationPending?: boolean;
}) {
  const paid = payments.reduce((n, p) => n + Number(p.amount_cents ?? 0), 0);
  const outstanding = Math.max(0, earnedLessRetainageCents - paid);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const ctx = (
    <>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="app_id" value={applicationId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="origin" value={origin} />
    </>
  );

  return (
    <section className="rounded-xl border border-ppp-charcoal-100 bg-surface">
      <div className="px-4 pt-3.5 pb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">
          Payments on Application No. {applicationNumber}
        </h3>
        <p className="text-[11.5px] text-ppp-charcoal-500 tabular-nums">
          {money(paid)} received of {money(earnedLessRetainageCents)}
          {outstanding > 0 ? (
            <span className="text-ppp-charcoal-700 font-semibold"> · {money(outstanding)} outstanding</span>
          ) : earnedLessRetainageCents > 0 ? (
            <span className="text-emerald-700 font-semibold"> · paid in full</span>
          ) : null}
        </p>
      </div>

      {migrationPending ? (
        <p className="px-4 pb-4 text-[12px] text-amber-800 bg-amber-50 mx-4 mb-4 rounded-lg p-3 border border-amber-200">
          Recording payments against an AIA needs a database change that hasn&rsquo;t been applied
          yet. Everything else on this screen works normally.
        </p>
      ) : (
        <>
          {payments.length === 0 ? (
            <p className="px-4 pb-1 text-[12px] text-ppp-charcoal-500">
              Nothing received against this application yet. A GC paying it in two or three
              instalments is normal — record each one as it lands.
            </p>
          ) : (
            <ul className="px-4 divide-y divide-ppp-charcoal-100">
              {payments.map((p) => (
                <li key={p.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-condensed text-[15px] font-black tabular-nums text-ppp-charcoal">
                    {money(Number(p.amount_cents))}
                  </span>
                  <span className="text-[12px] text-ppp-charcoal-600">{etDate(p.paid_at)}</span>
                  {p.method && (
                    <span className="text-[11.5px] text-ppp-charcoal-500">{p.method}</span>
                  )}
                  {p.reference && (
                    <span className="text-[11.5px] text-ppp-charcoal-400">#{p.reference}</span>
                  )}
                  <form action={deleteAction} className="ml-auto">
                    {ctx}
                    <input type="hidden" name="payment_id" value={p.id} />
                    <ConfirmSubmitButton
                      message={`Remove the ${money(Number(p.amount_cents))} payment from ${etDate(p.paid_at)}? The certificate goes back to outstanding if this takes it below the amount billed.`}
                      pendingLabel="…"
                      className="inline-flex items-center justify-center min-h-[44px] px-2 text-[11px] font-semibold text-ppp-charcoal-500 hover:text-rose-700"
                      ariaLabel="Remove payment"
                    >
                      Remove
                    </ConfirmSubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form
            action={recordAction}
            className="px-4 py-3 mt-1 grid sm:grid-cols-5 gap-2.5 items-end border-t border-ppp-charcoal-100"
          >
            {ctx}
            <label className="block">
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">
                Amount ($)
              </span>
              <input
                name="amount"
                inputMode="decimal"
                required
                placeholder={outstanding > 0 ? (outstanding / 100).toFixed(2) : "0.00"}
                aria-label="Payment amount"
                className={INPUT}
              />
            </label>
            <div>
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">
                Date received
              </span>
              <DateField name="paid_at" defaultValue={today} ariaLabel="Date received" />
            </div>
            <label className="block">
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Method</span>
              <input name="method" maxLength={40} placeholder="Check, ACH…" aria-label="Payment method" className={INPUT} />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">
                Reference
              </span>
              <input name="reference" maxLength={60} placeholder="Check no." aria-label="Payment reference" className={INPUT} />
            </label>
            <PendingSubmitButton
              pendingLabel="Recording…"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >
              Record payment
            </PendingSubmitButton>
          </form>
        </>
      )}
    </section>
  );
}
