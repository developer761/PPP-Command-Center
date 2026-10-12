import Link from "next/link";
import { redirect } from "next/navigation";
import { PayShell } from "@/components/pay/pay-shell";
import { formatCents } from "@/lib/payments/schedule";
import { DEMO_TERMS } from "@/lib/payments/demo";
import { SIM_NOTE, SIM_TEST_CARD, SIM_WO, parsePaid, simCharge } from "@/lib/payments/demo-sim";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay by card · Demo · Precision Painting Plus", robots: { index: false } };

/**
 * Simulated demo — the card page. The card is already filled in with Stripe's
 * test number (credit or debit, switchable), so nobody types anything:
 * Continue → the review with the exact total → Pay.
 */
export default async function DemoCardPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; card?: string; step?: string }>;
}) {
  const sp = await searchParams;
  const paid = parsePaid(sp.p);
  const p = paid.join("");
  const term = paid.length;
  if (term >= DEMO_TERMS.length) redirect(`/demo/payments/invoice?p=${p}`);
  const card = sp.card === "d" ? "d" : "c";
  const review = sp.step === "review";
  const label = DEMO_TERMS[term].type ?? "Payment";
  const charge = simCharge(term, card);
  const back = `/demo/payments/invoice?p=${p}`;
  const tc = SIM_TEST_CARD[card];

  return (
    <PayShell previewNote={SIM_NOTE}>
      <div className="space-y-5">
        <Link href={back} className="text-sm font-semibold text-ppp-navy underline underline-offset-4">
          ← Back to your invoice
        </Link>
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-charcoal-500">
            Invoice {SIM_WO.number} · {label} ({DEMO_TERMS[term].percent}% of the job)
          </div>
          <h1 className="mt-1 text-xl sm:text-2xl font-bold text-ppp-navy">Pay by card</h1>
          <p className="mt-1 text-[13px] text-ppp-charcoal-600">
            Debit card: <span className="font-semibold tabular-nums">{formatCents(charge.baseCents)}</span> · Credit card:{" "}
            <span className="font-semibold tabular-nums">{formatCents(simCharge(term, "c").totalCents)}</span> (includes 3% fee)
          </p>
        </section>

        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6 space-y-4">
          {!review ? (
            <>
              <div className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 p-3">
                <div className="text-[13px] font-semibold text-ppp-orange-700">Demo — card already filled in</div>
                <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Test card">
                  {(["c", "d"] as const).map((k) => (
                    <Link
                      key={k}
                      href={`/demo/payments/card?p=${p}&card=${k}`}
                      aria-current={card === k ? "true" : undefined}
                      className={`flex items-center justify-center rounded-xl px-3 min-h-[44px] text-sm font-semibold ${
                        card === k ? "bg-ppp-navy text-white" : "border border-ppp-charcoal-200 bg-white text-ppp-navy"
                      }`}
                    >
                      Test {SIM_TEST_CARD[k].kind.toLowerCase()} card
                    </Link>
                  ))}
                </div>
              </div>

              {/* Looks like Stripe's card form; read-only — it's a picture of one. */}
              <div className="space-y-3" aria-label="Card details (filled in for the demo)">
                <Field label="Card number" value={tc.number} badge={tc.brand} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Expiration date" value="12 / 34" />
                  <Field label="Security code" value="123" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Country" value="United States" />
                  <Field label="ZIP code" value="11743" />
                </div>
              </div>

              <Link
                href={`/demo/payments/card?p=${p}&card=${card}&step=review`}
                className="flex w-full items-center justify-center rounded-xl bg-ppp-navy text-white px-4 py-3 font-semibold min-h-[48px] hover:bg-ppp-navy-900"
              >
                Continue
              </Link>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50 p-4 space-y-2">
                <div className="text-[13px] font-semibold text-ppp-navy">{tc.kind} card</div>
                <div className="flex justify-between text-sm text-ppp-charcoal-700">
                  <span>{label}</span>
                  <span className="tabular-nums">{formatCents(charge.baseCents)}</span>
                </div>
                {charge.feeCents > 0 ? (
                  <div className="flex justify-between text-sm text-ppp-charcoal-700">
                    <span>Credit card service fee (3%)</span>
                    <span className="tabular-nums">{formatCents(charge.feeCents)}</span>
                  </div>
                ) : (
                  <div className="text-[13px] text-ppp-green-700">No service fee on this card.</div>
                )}
                <div className="flex justify-between border-t border-ppp-charcoal-200 pt-2 font-bold text-ppp-navy">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCents(charge.totalCents)}</span>
                </div>
              </div>
              <Link
                href={`/demo/payments/thanks?p=${p}${card}`}
                className="flex w-full items-center justify-center rounded-xl bg-ppp-navy text-white px-4 py-3 font-semibold min-h-[48px] hover:bg-ppp-navy-900"
              >
                Pay {formatCents(charge.totalCents)}
              </Link>
              <Link
                href={`/demo/payments/card?p=${p}&card=${card}`}
                className="flex w-full items-center justify-center rounded-xl border border-ppp-charcoal-200 bg-white text-ppp-navy px-4 py-3 text-sm font-semibold min-h-[44px]"
              >
                Use a different card
              </Link>
            </>
          )}
          <p className="text-[12px] leading-relaxed text-ppp-charcoal-600">
            Credit cards include a 3.00% service fee, which does not exceed our cost of accepting the card. Debit cards have
            no fee. You&rsquo;ll see the exact total before you pay.
          </p>
        </section>
      </div>
    </PayShell>
  );
}

function Field({ label, value, badge }: { label: string; value: string; badge?: string }) {
  return (
    <div>
      <div className="text-[13px] text-ppp-charcoal-600 mb-1">{label}</div>
      <div className="flex items-center justify-between rounded-[10px] border border-ppp-charcoal-200 bg-white px-3 min-h-[44px] text-base text-ppp-navy tabular-nums">
        <span>{value}</span>
        {badge && <span className="text-[11px] font-bold italic tracking-wide text-ppp-blue-700">{badge}</span>}
      </div>
    </div>
  );
}
