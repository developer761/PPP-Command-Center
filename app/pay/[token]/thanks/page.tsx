import Link from "next/link";
import { notFound } from "next/navigation";
import { canOpenPayPages } from "@/lib/payments/access";
import { getStripe, paymentsConfig, syncCheckoutSession, syncPaymentIntent, type PaymentRow } from "@/lib/payments/service";
import { formatCents } from "@/lib/payments/schedule";
import { PayMessage, PayShell } from "@/components/pay/pay-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment received · Precision Painting Plus", robots: { index: false } };

/**
 * Where Stripe sends the customer after checkout.
 *
 * It also SYNCS the payment (same idempotent call the webhook makes), for two
 * reasons: the customer sees the true state instead of whatever the webhook
 * has or hasn't delivered yet, and a missing or misconfigured webhook still
 * records the payment. Whichever arrives first wins; the other is a no-op.
 */
export default async function ThanksPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session_id?: string; payment_intent?: string }>;
}) {
  const { token } = await params;
  const { session_id, payment_intent } = await searchParams;
  if (!(await canOpenPayPages())) notFound();
  const cfg = paymentsConfig();
  const previewNote = cfg.publicPages ? null : "Admin preview — customers can't open this page yet.";

  let payment: PaymentRow | null = null;
  if (session_id && /^cs_(test|live)_[A-Za-z0-9]+$/.test(session_id)) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(session_id);
      // A session from someone else's link must not show here.
      if (session.metadata?.token === token) {
        const res = await syncCheckoutSession(session);
        if (res.kind !== "ignored") payment = res.payment;
      }
    } catch (err) {
      console.error("[pay] thanks sync failed", session_id, err);
    }
  } else if (payment_intent && /^pi_[A-Za-z0-9]+$/.test(payment_intent)) {
    // Card payments made on /pay/<token>/card (and Stripe's return from the
    // bank's 3-D Secure check, which appends ?payment_intent=…).
    try {
      const pi = await getStripe().paymentIntents.retrieve(payment_intent);
      if (pi.metadata?.token === token) {
        const res = await syncPaymentIntent(pi);
        if (res.kind !== "ignored") payment = res.payment;
      }
    } catch (err) {
      console.error("[pay] thanks sync failed", payment_intent, err);
    }
  }

  const back = (
    <p className="mt-6 text-center">
      <Link href={`/pay/${token}`} className="text-sm font-semibold text-ppp-navy underline underline-offset-4">
        Back to your invoice
      </Link>
    </p>
  );

  if (!payment) {
    return (
      <PayShell previewNote={previewNote}>
        <PayMessage
          tone="ok"
          heading="Thank you"
          body="If your payment went through you'll get a receipt from Stripe by email. Your invoice page shows the latest balance."
        />
        {back}
      </PayShell>
    );
  }

  const amount = formatCents(payment.total_cents);
  // "the Final payment" / "your full balance" — the bare label read as
  // "for the Final on invoice…".
  const what =
    payment.milestone_key === "balance" ? (
      <strong>your full balance</strong>
    ) : (
      <>
        the <strong>{payment.milestone_label}</strong> payment
      </>
    );
  const body =
    payment.status === "succeeded" ? (
      <>
        We received {amount} for {what} on invoice {payment.work_order_number}.
        A receipt is on its way to your email.
      </>
    ) : payment.status === "processing" ? (
      <>
        Your bank payment of {amount} for {what} is on its way. Bank transfers
        take about 4 business days to clear — you don&rsquo;t need to do anything else, and we won&rsquo;t ask you to
        pay it twice.
      </>
    ) : (
      <>Your payment didn&rsquo;t go through. Nothing was charged — you can try again from your invoice page.</>
    );

  return (
    <PayShell previewNote={previewNote}>
      <PayMessage
        tone={payment.status === "succeeded" || payment.status === "processing" ? "ok" : "warn"}
        heading={
          payment.status === "succeeded"
            ? "Payment received — thank you!"
            : payment.status === "processing"
              ? "Payment started — thank you!"
              : "Payment not completed"
        }
        body={body}
      />
      {back}
    </PayShell>
  );
}
