"use client";

import { useState } from "react";

/**
 * "Send the customer their receipt" — the button Katie asked for on Internal
 * Entry (2026-10-01): "not automatically sent but have a button available to
 * send if clicked? That allows our team to update/save and come back and make
 * adjustments before sending to the customer."
 *
 * So it is deliberately a second, explicit step after saving, and it says who
 * it is about to email BEFORE sending — an AM entering colors for somebody
 * else cannot be expected to remember which address is on the work order, and
 * this is the one action here that reaches a customer.
 */
export default function SendReceiptButton({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function send() {
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/customer-form/send-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setState("idle");
        setMessage(body.message ?? body.error ?? `Couldn't send (HTTP ${res.status}).`);
        return;
      }
      setSentTo(body.to ?? null);
      setState("sent");
    } catch (err) {
      setState("idle");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (state === "sent") {
    return (
      <p className="mt-5 text-sm text-ppp-green-700 bg-ppp-green-50 border border-ppp-green-100 rounded-lg px-3 py-2 inline-block">
        Receipt sent{sentTo ? <> to <strong>{sentTo}</strong></> : null}.
      </p>
    );
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={send}
        disabled={state === "sending"}
        // Navy, not brand blue. White on #2BAAE1 is 2.64:1 and fails AA — the
        // repo's contrast test caught it — and blue-700 inverts in dark.
        // bg-ppp-navy is what every other primary action here already uses.
        className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg bg-ppp-navy text-white font-semibold text-sm hover:bg-ppp-charcoal disabled:opacity-60 min-h-[44px] touch-manipulation transition-colors"
      >
        {state === "sending" ? "Sending…" : "Send receipt to customer"}
      </button>
      <p className="mt-2 text-xs text-ppp-charcoal-500 max-w-md mx-auto leading-relaxed">
        Emails the customer a copy of these selections with a link to review them. Nothing is sent
        until you click.
      </p>
      {message && (
        <p className="mt-2 text-xs text-ppp-orange-700 max-w-md mx-auto leading-relaxed">{message}</p>
      )}
    </div>
  );
}
