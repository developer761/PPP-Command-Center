import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canOpenPayPages } from "@/lib/payments/access";
import { loadPayState, paymentsConfig } from "@/lib/payments/service";
import { cardFeeCents, formatCents, quoteCharge } from "@/lib/payments/schedule";
import { PayShell } from "@/components/pay/pay-shell";
import { CardPayment } from "@/components/pay/card-payment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay by card · Precision Painting Plus", robots: { index: false } };

/**
 * /pay/<token>/card?m=<milestone> — pay one milestone (or 'balance') by card.
 *
 * Why this page exists instead of Stripe's hosted Checkout: PPP charges the 3%
 * on CREDIT cards only. Hosted Checkout fixes the amount before the card is
 * typed; here the card is read first (see components/pay/card-payment.tsx).
 */
export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { token } = await params;
  const { m } = await searchParams;
  if (!(await canOpenPayPages())) notFound();

  const cfg = paymentsConfig();
  const back = `/pay/${token}`;
  if (!m) redirect(back);
  if (cfg.cardBlockedReason || !cfg.publishableKey) redirect(`${back}?err=unavailable`);

  const state = await loadPayState(token);
  if (state.kind !== "ok") redirect(back);
  const quote = quoteCharge(state.schedule, m, "ach");
  if (!quote) redirect(`${back}?err=not_due`);

  const previewNote = !cfg.publicPages
    ? `Admin preview — customers can't open this page yet.${cfg.stripeMode === "test" ? " Test cards: credit 4242 4242 4242 4242 · debit 4000 0566 5566 5556." : ""}`
    : null;

  return (
    <PayShell previewNote={previewNote}>
      <div className="space-y-5">
        <Link href={back} className="text-sm font-semibold text-ppp-navy underline underline-offset-4">
          ← Back to your invoice
        </Link>
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-charcoal-500">
            Invoice {state.wo.number} · {quote.label}
          </div>
          <h1 className="mt-1 text-xl sm:text-2xl font-bold text-ppp-navy">Pay by card</h1>
          <p className="mt-1 text-[13px] text-ppp-charcoal-600">
            Debit card: <span className="font-semibold tabular-nums">{formatCents(quote.baseCents)}</span> · Credit card:{" "}
            <span className="font-semibold tabular-nums">{formatCents(quote.baseCents + cardFeeCents(quote.baseCents))}</span>{" "}
            (includes 3% fee)
          </p>
        </section>
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <CardPayment token={token} milestoneKey={m} baseCents={quote.baseCents} publishableKey={cfg.publishableKey} />
        </section>
      </div>
    </PayShell>
  );
}
