"use client";

/**
 * One-click copy-to-clipboard button. Flashes a green ✓ + "Copied!"
 * for 1.5s on success. Used platform-wide for emails, phones, project
 * numbers, invoice numbers, account addresses — anywhere Alex might
 * otherwise select-drag-copy the text manually.
 *
 * Karan 2026-07-11 (signature-moments batch): the platform has dozens
 * of surfaces displaying emails/phones/IDs where users copy them into
 * another tool (Salesforce, external email, phone dialer). A dedicated
 * button removes the click-drag motion that Alex does 50+ times a day.
 *
 * Renders inline next to the value being copied. Optional `label` prop
 * lets consumers customize the flash text (default "Copied!") — e.g.
 * "Email copied" for accessibility clarity when there are multiple
 * buttons in one row.
 */

import { useState } from "react";

export function CopyToClipboardButton({
  value,
  label = "Copied!",
  ariaLabel,
  className = "",
}: {
  value: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard fails in insecure contexts (http://) or
      // when permissions are denied. Fall back to a legacy select-copy
      // via a temporary textarea so users on stricter setups still
      // get the win. If both paths fail we swallow silently — the
      // value is still visible on screen so the user can select it
      // manually.
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* nothing more we can do */
      }
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Copy ${value}`}
      className={`shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ppp-charcoal-400 hover:text-cc-brand-700 hover:bg-cc-brand-50 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 transition-colors ${className}`}
      title={copied ? label : `Copy ${value}`}
    >
      {copied ? (
        <span aria-hidden className="text-cc-brand-600 text-[13px]">✓</span>
      ) : (
        // Standard "copy" icon — 12x12 sized to fit the 24px button.
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
