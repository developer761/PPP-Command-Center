"use client";

import { useCallback, useState } from "react";

/**
 * Copy-to-clipboard button for the BCC archive address.
 *
 * Usage:
 *   <CopyArchiveAddressButton address="orders+archive-opp-a1b2c3d4-1f2e3d@..." />
 *
 * Renders:
 *   - 44px-min tap target (iOS HIG)
 *   - Truncated address preview alongside the copy icon
 *   - Brief "Copied!" feedback flash (2s)
 *   - Falls back to a focusable + selectable input when clipboard API
 *     isn't available (older mobile browsers, locked-down work devices)
 *
 * Why a client component? `navigator.clipboard.writeText` is browser-only.
 * The server can't know if the clipboard API exists, so the fallback
 * input has to materialize client-side too.
 */

export default function CopyArchiveAddressButton({
  address,
}: {
  address: string;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(address);
        setCopied(true);
        // Reset after 2 seconds so the user can copy again immediately
        // without the success label being stuck.
        setTimeout(() => setCopied(false), 2000);
        return;
      }
    } catch {
      // Permission denied or insecure context — fall through to the
      // selectable input.
    }
    setFallback(true);
  }, [address]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy archive address ${address}`}
        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-700 active:bg-ppp-blue-800 transition-colors touch-manipulation min-h-[44px] shrink-0"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0"
        >
          {copied ? (
            <polyline points="20 6 9 17 4 12" />
          ) : (
            <>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </>
          )}
        </svg>
        <span>{copied ? "Copied!" : "Copy archive address"}</span>
      </button>
      {/* Address text under the button — readable, selectable, and obvious
          which opp/account it points to. break-all so the address wraps
          on mobile instead of pushing horizontal scroll. */}
      <p className="font-mono text-[11px] sm:text-xs text-ppp-charcoal-600 break-all leading-relaxed">
        {address}
      </p>
      {fallback && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-900 mb-2">
            Your browser blocked auto-copy. Tap and hold to select, then copy:
          </p>
          <input
            type="text"
            readOnly
            value={address}
            onFocus={(e) => e.currentTarget.select()}
            // text-base (16px) prevents iOS Safari from auto-zooming when
            // the input receives focus — text-xs would zoom and not zoom
            // back.
            className="w-full font-mono text-base px-3 py-2.5 rounded border border-amber-300 bg-white text-ppp-charcoal min-h-[44px]"
          />
        </div>
      )}
    </div>
  );
}
