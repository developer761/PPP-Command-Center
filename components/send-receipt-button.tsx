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
  /**
   * Kate 2026-10-09: "allow the AM to enter the customer's name and email in
   * the same way they do to send the color form to the customer."
   *
   * Hidden until it is wanted. The work order carries the address on most
   * jobs and Katie's one-click flow is the right default; these are for the
   * ones where it does not, where the route used to answer "Add one in
   * Salesforce, then send the receipt" and leave the AM stuck mid-job.
   *
   * Opens by itself when the send comes back with no_customer_email, so the
   * dead end becomes the fix rather than a message about one.
   */
  const [showTo, setShowTo] = useState(false);
  const [toEmail, setToEmail] = useState("");
  const [toName, setToName] = useState("");

  async function send() {
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/customer-form/send-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          ...(toEmail.trim() ? { toEmail: toEmail.trim(), toName: toName.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setState("idle");
        setMessage(body.message ?? body.error ?? `Couldn't send (HTTP ${res.status}).`);
        // The one failure the AM can fix from here.
        if (body.error === "no_customer_email" || body.error === "invalid_email") setShowTo(true);
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
      {/* No mx-auto / max-w here: this renders BOTH inside the centered
          post-save panel and inside the left-aligned internal-entry banner,
          and centering constraints meant for the first one left the text
          visibly offset in the second. The container decides alignment. */}
      <p className="mt-2 text-xs text-ppp-charcoal-500 leading-relaxed">
        Emails the customer a copy of these selections with a link to review them. Nothing is sent
        until you click.
      </p>
      {message && (
        <p className="mt-2 text-xs text-ppp-orange-700 leading-relaxed">{message}</p>
      )}
      <button
        type="button"
        onClick={() => setShowTo((v) => !v)}
        aria-expanded={showTo}
        aria-controls="receipt-recipient"
        className="mt-2 text-xs text-ppp-blue-700 hover:underline min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
      >
        {showTo ? "Use the address on the work order" : "Send to a different address"}
      </button>
      {showTo && (
        <div id="receipt-recipient" className="mt-2 flex flex-col gap-2 max-w-sm">
          <label className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
            Customer name
            <input
              type="text"
              value={toName}
              onChange={(e) => setToName(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
            />
          </label>
          <label className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
            Customer email
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="name@example.com"
              className="mt-1 w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
            />
          </label>
          <p className="text-[11px] text-ppp-charcoal-500 leading-relaxed">
            Used instead of the address on the work order. It is not saved back
            to Salesforce — correct it there too if it is wrong.
          </p>
        </div>
      )}
    </div>
  );
}
