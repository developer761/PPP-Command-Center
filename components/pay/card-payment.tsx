"use client";

import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";

/**
 * The card form on /pay/<token>/card.
 *
 * Two steps, so the customer always sees the final amount before paying:
 *   1. Enter the card → Continue. The browser turns the card into a Stripe
 *      ConfirmationToken (nothing is charged) and the server reads whether it
 *      is credit or debit.
 *   2. Review: "Debit card — no fee — $1,490.90" or "Credit card —
 *      $1,490.90 + $44.73 fee = $1,535.63" → Pay.
 *
 * The amounts shown come from the server; the browser never decides one.
 */

type Funding = "credit" | "debit" | "prepaid" | "unknown";
type Quote = { funding: Funding; label: string; baseCents: number; feeCents: number; totalCents: number };

type Phase =
  | { kind: "loading" }
  | { kind: "enter" }
  | { kind: "checking" }
  | { kind: "review"; ct: string; quote: Quote }
  | { kind: "paying"; ct: string; quote: Quote };

const ERRORS: Record<string, string> = {
  not_due: "This amount isn't due any more — go back to your invoice to see what is.",
  inactive: "This payment link is no longer active.",
  bad_card: "We couldn't read that card. Please check the details and try again.",
  unavailable: "Card payments aren't available right now. Please try again later.",
  too_many: "Too many card attempts on this invoice. Please wait an hour, pay by bank transfer, or call the office.",
  failed: "Something went wrong on our side. Nothing was charged — please try again.",
};

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const FUNDING_LABEL: Record<Funding, string> = {
  credit: "Credit card",
  debit: "Debit card",
  prepaid: "Prepaid card",
  unknown: "Card",
};

export function CardPayment({
  token,
  milestoneKey,
  baseCents,
  publishableKey,
  surcharge = true,
}: {
  token: string;
  milestoneKey: string;
  baseCents: number;
  publishableKey: string;
  /** False in states where card surcharges aren't allowed (CT/MA/ME). */
  surcharge?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stripe = await loadStripe(publishableKey);
      if (cancelled || !stripe || !mountRef.current) return;
      const elements = stripe.elements({
        mode: "payment",
        amount: baseCents,
        currency: "usd",
        paymentMethodTypes: ["card"],
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#172B4D",
            colorText: "#172B4D",
            fontFamily: "Roboto, system-ui, sans-serif",
            // 16px: anything smaller makes iOS zoom into the field.
            fontSizeBase: "16px",
            borderRadius: "10px",
          },
        },
        fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap" }],
      });
      // Card only. Wallets off: Link can offer a bank account inside a card
      // form (found in test), and Apple/Google Pay need a registered domain.
      const el = elements.create("payment", {
        layout: "tabs",
        wallets: { applePay: "never", googlePay: "never", link: "never" },
      });
      el.mount(mountRef.current);
      el.on("ready", () => !cancelled && setPhase({ kind: "enter" }));
      stripeRef.current = stripe;
      elementsRef.current = elements;
    })();
    return () => {
      cancelled = true;
    };
  }, [publishableKey, baseCents]);

  async function onContinue() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;
    setError(null);
    setPhase({ kind: "checking" });

    const submitted = await elements.submit();
    if (submitted.error) {
      setError(submitted.error.message ?? ERRORS.bad_card);
      setPhase({ kind: "enter" });
      return;
    }
    const { error: ctError, confirmationToken } = await stripe.createConfirmationToken({ elements });
    if (ctError || !confirmationToken) {
      setError(ctError?.message ?? ERRORS.bad_card);
      setPhase({ kind: "enter" });
      return;
    }
    const res = await fetch(`/pay/${token}/card/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestone: milestoneKey, confirmationToken: confirmationToken.id }),
    });
    const body = (await res.json().catch(() => ({}))) as { quote?: Quote; error?: string };
    if (!res.ok || !body.quote) {
      setError(ERRORS[body.error ?? "failed"] ?? ERRORS.failed);
      setPhase({ kind: "enter" });
      return;
    }
    setPhase({ kind: "review", ct: confirmationToken.id, quote: body.quote });
  }

  async function onPay() {
    if (phase.kind !== "review") return;
    const stripe = stripeRef.current;
    if (!stripe) return;
    setError(null);
    setPhase({ kind: "paying", ct: phase.ct, quote: phase.quote });

    const res = await fetch(`/pay/${token}/card/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestone: milestoneKey, confirmationToken: phase.ct, shownTotalCents: phase.quote.totalCents }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      paymentIntentId?: string;
      clientSecret?: string;
      error?: string;
      message?: string;
      quote?: Quote;
    };

    if (!res.ok) {
      if (body.error === "amount_changed" && body.quote) {
        // Nothing was charged. Show the new amount and let them decide again.
        setError("The amount changed — please check the new total below before paying.");
        setPhase({ kind: "review", ct: phase.ct, quote: body.quote });
        return;
      }
      if (body.error === "declined") {
        setError(body.message ?? "Your card was declined. Nothing was charged — try another card.");
      } else {
        setError(ERRORS[body.error ?? "failed"] ?? ERRORS.failed);
      }
      setPhase({ kind: "enter" });
      return;
    }

    let piId = body.paymentIntentId;
    if (body.status === "requires_action" && body.clientSecret) {
      // The bank's own security check (3-D Secure). Stripe shows it.
      const next = await stripe.handleNextAction({ clientSecret: body.clientSecret });
      if (next.error) {
        setError(next.error.message ?? "The card's security check didn't complete. Nothing was charged.");
        setPhase({ kind: "enter" });
        return;
      }
      piId = next.paymentIntent?.id ?? piId;
    }
    window.location.href = `/pay/${token}/thanks?payment_intent=${encodeURIComponent(piId ?? "")}`;
  }

  const busy = phase.kind === "loading" || phase.kind === "checking" || phase.kind === "paying";
  const reviewing = phase.kind === "review" || phase.kind === "paying";

  return (
    <div className="space-y-4">
      {/* Stays mounted through review so "Use a different card" is instant. */}
      <div className={reviewing ? "hidden" : ""}>
        <div ref={mountRef} className="min-h-[140px]" />
        {phase.kind === "loading" && <p className="text-[13px] text-ppp-charcoal-500 mt-2">Loading secure card form…</p>}
      </div>

      {reviewing && (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50 p-4 space-y-2">
          <div className="text-[13px] font-semibold text-ppp-navy">{FUNDING_LABEL[phase.quote.funding]}</div>
          <div className="flex justify-between text-sm text-ppp-charcoal-700">
            <span>{phase.quote.label}</span>
            <span className="tabular-nums">{money(phase.quote.baseCents)}</span>
          </div>
          {phase.quote.feeCents > 0 ? (
            <div className="flex justify-between text-sm text-ppp-charcoal-700">
              <span>Credit card service fee (3%)</span>
              <span className="tabular-nums">{money(phase.quote.feeCents)}</span>
            </div>
          ) : (
            <div className="text-[13px] text-ppp-green-700">No service fee on this card.</div>
          )}
          <div className="flex justify-between border-t border-ppp-charcoal-200 pt-2 font-bold text-ppp-navy">
            <span>Total</span>
            <span className="tabular-nums">{money(phase.quote.totalCents)}</span>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-ppp-orange-100 bg-ppp-orange-50 px-4 py-3 text-[13px] text-ppp-orange-700">
          {error}
        </div>
      )}

      {!reviewing ? (
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="w-full rounded-xl bg-ppp-navy text-white px-4 py-3 font-semibold min-h-[48px] disabled:opacity-60 hover:bg-ppp-navy-900"
        >
          {phase.kind === "checking" ? "Checking card…" : "Continue"}
        </button>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={onPay}
            disabled={busy}
            className="w-full rounded-xl bg-ppp-navy text-white px-4 py-3 font-semibold min-h-[48px] disabled:opacity-60 hover:bg-ppp-navy-900"
          >
            {phase.kind === "paying" ? "Paying…" : `Pay ${money(phase.quote.totalCents)}`}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPhase({ kind: "enter" });
            }}
            disabled={busy}
            className="w-full rounded-xl border border-ppp-charcoal-200 bg-white text-ppp-navy px-4 py-3 text-sm font-semibold min-h-[44px]"
          >
            Use a different card
          </button>
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-ppp-charcoal-600">
        {surcharge
          ? "Credit cards include a 3.00% service fee, which does not exceed our cost of accepting the card. Debit cards have no fee."
          : "No service fee on card payments."}{" "}
        You&rsquo;ll see the exact total before you pay.
      </p>
    </div>
  );
}
