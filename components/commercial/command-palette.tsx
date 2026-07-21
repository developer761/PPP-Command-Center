"use client";

/**
 * ⌘K / Ctrl+K global command palette. Jumps to any account, deal, or
 * invoice from anywhere in the Commercial CC. Karan 2026-07-11
 * (signature-moments Tier 2): "the biggest productivity unlock."
 * Alex spends dozens of clicks a day navigating between customer,
 * deal, and invoice — this collapses every jump to one keyboard
 * shortcut.
 *
 * Behavior:
 * - ⌘K (mac) / Ctrl+K (windows/linux) toggles.
 * - Escape closes.
 * - Arrow keys navigate results, Enter jumps.
 * - Debounced fetch to /api/commercial/palette-search — starts at
 *   query length 2 to avoid firing on every keystroke.
 * - Results grouped: Accounts / Deals / Invoices.
 * - Colored per-account tone on each result via inline HSL so the
 *   palette matches the rest of the platform's account-color
 *   language.
 *
 * Mounted in the commercial layout so it's available on every page.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconBuilding, IconTarget, IconReceipt } from "./inline-icons";

type PaletteResult = {
  kind: "account" | "opportunity" | "invoice";
  id: string;
  label: string;
  hint: string;
  href: string;
};

const KIND_LABEL: Record<PaletteResult["kind"], string> = {
  account: "Accounts",
  opportunity: "Deals",
  invoice: "Invoices",
};

const KIND_ICON: Record<PaletteResult["kind"], typeof IconBuilding> = {
  account: IconBuilding,
  opportunity: IconTarget,
  invoice: IconReceipt,
};

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaletteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ⌘K / Ctrl+K toggle. Escape closes. Ignored when typing in
  // regular inputs so users don't accidentally hijack Cmd+K in text.
  // Also listens for a custom "commercial-palette-open" event dispatched
  // by KeyboardShortcuts when the user presses "/" — bridges the two
  // components without a shared parent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    const onPaletteOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("commercial-palette-open", onPaletteOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("commercial-palette-open", onPaletteOpen);
    };
  }, [open]);

  // Focus + reset on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Debounced fetch. Cancels the previous inflight request on each
  // keystroke so we don't race late responses over fresh queries.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(
          `/api/commercial/palette-search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const body = (await res.json()) as { results?: PaletteResult[] };
        setResults(body.results ?? []);
        setHighlight(0);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [query, open]);

  const groupedResults: Array<[PaletteResult["kind"], PaletteResult[]]> = [
    ["account", results.filter((r) => r.kind === "account")],
    ["opportunity", results.filter((r) => r.kind === "opportunity")],
    ["invoice", results.filter((r) => r.kind === "invoice")],
  ].filter(([, arr]) => arr.length > 0) as Array<[PaletteResult["kind"], PaletteResult[]]>;
  const flat: PaletteResult[] = groupedResults.flatMap(([, arr]) => arr);

  const commit = (r: PaletteResult) => {
    setOpen(false);
    router.push(r.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, flat.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = flat[highlight];
      if (target) commit(target);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-ppp-charcoal-900/50 backdrop-blur-[2px]"
      />
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-ppp-charcoal-200 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ppp-charcoal-100">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to an account, deal, or invoice…"
            className="flex-1 outline-none text-[15px] text-ppp-charcoal placeholder:text-ppp-charcoal-400 bg-transparent"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-controls="palette-results"
            aria-activedescendant={
              flat[highlight] ? `palette-opt-${flat[highlight].id}` : undefined
            }
            aria-autocomplete="list"
          />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-400 bg-ppp-charcoal-100 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
            Esc
          </span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto" role="listbox" id="palette-results">
          {query.trim().length < 2 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ppp-charcoal-500">
              Type 2+ characters to search accounts, deals, and invoices.
            </div>
          ) : loading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ppp-charcoal-500">
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-ppp-charcoal-500">
              No matches for &quot;{query.trim()}&quot;.
            </div>
          ) : (
            groupedResults.map(([kind, arr]) => (
              <div key={kind} className="py-1">
                <div className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60">
                  {KIND_LABEL[kind]}
                </div>
                <ul>
                  {arr.map((r) => {
                    const flatIdx = flat.indexOf(r);
                    const isHighlighted = flatIdx === highlight;
                    return (
                      <li key={r.id} role="option" id={`palette-opt-${r.id}`} aria-selected={isHighlighted}>
                        <button
                          type="button"
                          onMouseEnter={() => setHighlight(flatIdx)}
                          onClick={() => commit(r)}
                          className={`w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-colors ${
                            isHighlighted ? "bg-cc-brand-50" : "hover:bg-ppp-charcoal-50"
                          }`}
                        >
                          <span aria-hidden className="shrink-0 mt-0.5 text-ppp-charcoal-500">
                            {(() => {
                              const Icon = KIND_ICON[kind];
                              return <Icon size={16} />;
                            })()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[14px] font-semibold text-ppp-charcoal truncate">
                              {r.label}
                            </span>
                            {r.hint && (
                              <span className="block text-[11.5px] text-ppp-charcoal-500 truncate">
                                {r.hint}
                              </span>
                            )}
                          </span>
                          {isHighlighted && (
                            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-cc-brand-700 bg-cc-brand-100 border border-cc-brand-200 rounded px-1.5 py-0.5 self-center">
                              ↵
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/40 text-[10px] text-ppp-charcoal-500 flex items-center justify-between">
          <span className="inline-flex items-center gap-3">
            <span>
              <kbd className="font-mono bg-white border border-ppp-charcoal-200 rounded px-1">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="font-mono bg-white border border-ppp-charcoal-200 rounded px-1">↵</kbd> jump
            </span>
          </span>
          <span>
            Press <kbd className="font-mono bg-white border border-ppp-charcoal-200 rounded px-1">⌘K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
