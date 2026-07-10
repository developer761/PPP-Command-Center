"use client";

/**
 * "Copy link" button on the invoice detail hero. Alex-love (Karan
 * 2026-07-07): faster than typing the URL into an email / Slack when
 * Alex needs to send a specific invoice to the customer.
 *
 * Reads `location.href` at click time so it always copies whatever the
 * current URL is — no server prop needed. Falls back to a legacy
 * document.execCommand path if the Clipboard API is unavailable
 * (older mobile browsers).
 */

import { useState } from "react";

export default function CopyInvoiceLinkButton({ className }: { className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  const handleCopy = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (!url) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        // Legacy fallback for older browsers / non-HTTPS contexts.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setState("copied");
      setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2400);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy this invoice's link so you can paste it into an email or Slack"
      className={
        className ??
        "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 hover:border-cc-brand-300 hover:text-cc-brand-700 min-h-[40px] touch-manipulation transition-colors focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
      }
    >
      {state === "copied" ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Copied
        </>
      ) : state === "error" ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          Couldn't copy
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy link
        </>
      )}
    </button>
  );
}
