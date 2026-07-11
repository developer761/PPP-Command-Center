"use client";

/**
 * Global keyboard shortcuts for Commercial CC. Karan 2026-07-11
 * signature-moments Tier 3: power-user unlock. Alex uses this daily,
 * so bind the core navigation keys.
 *
 * Bindings:
 * - `/`         — focus the ⌘K palette input (opens the palette)
 * - `n`         — jump to `/commercial/accounts?new_deal=1` (fastest
 *                 new-deal path from anywhere)
 * - `g` then `p` — go to Pipeline
 * - `g` then `a` — go to Accounts
 * - `g` then `i` — go to Invoices
 * - `g` then `d` — go to Dashboard
 * - `?`         — open the help sheet (list of shortcuts)
 *
 * Ignored when the user is typing in an input, textarea, contenteditable
 * element, or when a modifier key is held — Cmd+K already has its own
 * handler in CommandPalette.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function KeyboardShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [pendingG, setPendingG] = useState(false);

  useEffect(() => {
    const timer: { current: ReturnType<typeof setTimeout> | null } = { current: null };
    const isTypingTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      // Modifier-only shortcuts (Cmd+K) are owned by CommandPalette.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // "g" then <letter> sequence — 1s window.
      if (pendingG) {
        setPendingG(false);
        if (timer.current) clearTimeout(timer.current);
        const k = e.key.toLowerCase();
        if (k === "p") {
          e.preventDefault();
          router.push("/commercial/opportunities");
          return;
        }
        if (k === "a") {
          e.preventDefault();
          router.push("/commercial/accounts");
          return;
        }
        if (k === "i") {
          e.preventDefault();
          router.push("/commercial/invoices");
          return;
        }
        if (k === "d") {
          e.preventDefault();
          router.push("/commercial");
          return;
        }
        return;
      }

      if (e.key === "g") {
        setPendingG(true);
        timer.current = setTimeout(() => setPendingG(false), 1000);
        return;
      }
      if (e.key === "n") {
        e.preventDefault();
        router.push("/commercial/accounts?new_deal=1#new-deal");
        return;
      }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !e.shiftKey) {
        // Fire the same ⌘K opener via a synthetic event so we don't
        // duplicate the palette code here. CommandPalette listens for
        // metaKey/ctrlKey+k — we simulate by dispatching a custom
        // event that CommandPalette can also listen for.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("commercial-palette-open"));
        return;
      }
      if (e.key === "Escape" && helpOpen) {
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pendingG, helpOpen, router]);

  if (!helpOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <button
        type="button"
        aria-label="Close shortcuts"
        onClick={() => setHelpOpen(false)}
        className="absolute inset-0 bg-ppp-charcoal-900/50 backdrop-blur-[2px]"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-ppp-charcoal-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-ppp-charcoal-100 flex items-center justify-between">
          <h2 className="text-[15px] font-bold text-ppp-charcoal">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setHelpOpen(false)}
            className="inline-flex items-center justify-center w-8 h-8 rounded text-ppp-charcoal-400 hover:text-ppp-charcoal hover:bg-ppp-charcoal-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18 M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ul className="px-5 py-4 space-y-2.5 text-[13px]">
          <ShortcutRow keys={["⌘", "K"]} label="Open command palette (jump to anything)" />
          <ShortcutRow keys={["/"]} label="Focus the palette search" />
          <ShortcutRow keys={["N"]} label="Log a new deal" />
          <ShortcutRow keys={["G", "P"]} label="Go to Pipeline" />
          <ShortcutRow keys={["G", "A"]} label="Go to Accounts" />
          <ShortcutRow keys={["G", "I"]} label="Go to Invoices" />
          <ShortcutRow keys={["G", "D"]} label="Go to Dashboard" />
          <ShortcutRow keys={["?"]} label="Open this help sheet" />
          <ShortcutRow keys={["Esc"]} label="Close any open sheet or modal" />
        </ul>
        <div className="px-5 py-2.5 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/40 text-[11px] text-ppp-charcoal-500">
          Shortcuts ignored while typing in forms. Press <kbd className="font-mono bg-white border border-ppp-charcoal-200 rounded px-1">?</kbd> anywhere to reopen.
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-ppp-charcoal-700">{label}</span>
      <span className="flex items-center gap-1 shrink-0">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded border border-ppp-charcoal-200 bg-white font-mono text-[11px] font-bold text-ppp-charcoal-700"
          >
            {k}
          </kbd>
        ))}
      </span>
    </li>
  );
}
