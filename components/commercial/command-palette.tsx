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
import { IconBuilding, IconTarget, IconReceipt, IconFileDoc } from "./inline-icons";

type PaletteKind = "account" | "opportunity" | "proposal" | "invoice" | "document";

type PaletteResult = {
  kind: PaletteKind;
  id: string;
  label: string;
  hint: string;
  href: string;
};

const KIND_LABEL: Record<PaletteKind, string> = {
  account: "Accounts",
  opportunity: "Opportunities",
  proposal: "Proposals",
  invoice: "Invoices",
  document: "Documents",
};

const KIND_ICON: Record<PaletteKind, typeof IconBuilding> = {
  account: IconBuilding,
  opportunity: IconTarget,
  proposal: IconFileDoc,
  invoice: IconReceipt,
  document: IconFileDoc,
};

// Order the entity filter chips + result groups.
const KIND_ORDER: PaletteKind[] = ["account", "opportunity", "proposal", "invoice", "document"];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaletteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [filter, setFilter] = useState<"all" | PaletteKind>("all");
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
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      // Remember where focus was so we can return it on close — keyboard users
      // otherwise get dumped on <body> after Esc (2026-08 a11y walk).
      prevFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setResults([]);
      setHighlight(0);
      setFilter("all");
      setTimeout(() => inputRef.current?.focus(), 10);
    } else if (prevFocusRef.current) {
      prevFocusRef.current.focus?.();
      prevFocusRef.current = null;
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

  // Entity filter chips ("All · Accounts · Opportunities · Proposals · Invoices ·
  // Documents"). "all" shows every kind grouped; a specific kind narrows to it.
  // Which kinds actually have results (to render only useful chips).
  const availableKinds = KIND_ORDER.filter((k) => results.some((r) => r.kind === k));
  // If the query changed so the active filter's kind is gone, fall back to "all"
  // rather than showing a blank list under a stale chip.
  const effectiveFilter: "all" | PaletteKind =
    filter !== "all" && !availableKinds.includes(filter) ? "all" : filter;
  const shown = effectiveFilter === "all" ? results : results.filter((r) => r.kind === effectiveFilter);
  const groupedResults: Array<[PaletteKind, PaletteResult[]]> = KIND_ORDER
    .map((k) => [k, shown.filter((r) => r.kind === k)] as [PaletteKind, PaletteResult[]])
    .filter(([, arr]) => arr.length > 0);
  const flat: PaletteResult[] = groupedResults.flatMap(([, arr]) => arr);

  const commit = (r: PaletteResult) => {
    if (r.kind === "document") {
      // Documents open the file itself — new tab, keep context.
      window.open(r.href, "_blank", "noopener,noreferrer");
      setOpen(false);
      return;
    }
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
      onKeyDown={(e) => {
        // Trap Tab within the palette so focus can't slip to the obscured page
        // behind the modal (R7-a11y #14).
        if (e.key !== "Tab") return;
        const foc = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ).filter((el) => el.offsetParent !== null);
        if (foc.length === 0) return;
        const first = foc[0];
        const last = foc[foc.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-ppp-navy-900/50 backdrop-blur-[2px]"
      />
      <div className="relative w-full max-w-xl bg-surface rounded-2xl shadow-2xl border border-ppp-charcoal-200 overflow-hidden">
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
            placeholder="Search accounts, opportunities, proposals, invoices, documents…"
            className="flex-1 outline-none text-base text-ppp-charcoal placeholder:text-ppp-charcoal-400 bg-transparent"
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
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear what you typed"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full text-ppp-charcoal-400 hover:text-ppp-charcoal-800 hover:bg-ppp-charcoal-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 touch-manipulation"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6L6 18 M6 6l12 12" /></svg>
            </button>
          )}
          <span aria-hidden className="hidden sm:inline shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-400 bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded px-1.5 py-1 leading-none">Esc</span>
          {/* Divider so the two X glyphs don't read as one control. The Esc
              chip separates them on desktop but is hidden on mobile, which is
              exactly where they'd sit shoulder to shoulder — clear-the-text and
              close-the-whole-thing look identical and do very different things. */}
          {query && (
            <span aria-hidden className="sm:hidden shrink-0 self-center h-4 w-px bg-ppp-charcoal-200 mx-0.5" />
          )}
          <button
            type="button"
            aria-label="Close search"
            title="Close search"
            onClick={() => setOpen(false)}
            className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-ppp-charcoal-500 hover:text-ppp-charcoal-800 hover:bg-ppp-charcoal-100 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 touch-manipulation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6L6 18 M6 6l12 12" /></svg>
          </button>
        </div>
        {/* Entity filter chips — narrow the results to one kind. */}
        {availableKinds.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-ppp-charcoal-100 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {(["all", ...availableKinds] as ("all" | PaletteKind)[]).map((k) => {
              const active = effectiveFilter === k;
              const n = k === "all" ? results.length : results.filter((r) => r.kind === k).length;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setFilter(k);
                    setHighlight(0);
                  }}
                  aria-pressed={active}
                  className={`shrink-0 inline-flex items-center gap-1 px-2.5 min-h-[32px] rounded-full text-[11.5px] font-semibold border transition-colors touch-manipulation ${
                    active
                      ? "bg-cc-brand-600 text-white border-cc-brand-600"
                      : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
                  }`}
                >
                  {k === "all" ? "All" : KIND_LABEL[k]}
                  <span className={`tabular-nums ${active ? "text-white/80" : "text-ppp-charcoal-400"}`}>{n}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto" role="listbox" id="palette-results">
          {query.trim().length < 2 ? (
            /* Karan 2026-08: the old empty state was a big circled magnifier, a
               "Search everything" title, a list of five nouns, and five chips
               reading "a name" / "PO #" — decoration that told you almost
               nothing. This is the same space spent on what you can actually
               TYPE, each with a real example, left-aligned so it scans as
               instructions rather than as a splash screen. */
            <div className="px-4 py-5">
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-ppp-charcoal-400">
                Search by
              </p>
              <ul className="mt-2.5 space-y-2">
                {[
                  { ex: "Acme Drywall", what: "customer or contact" },
                  { ex: "PROP-0045", what: "proposal, invoice or opportunity number" },
                  { ex: "77 Windsor Pl", what: "project address" },
                  { ex: "12500", what: "an amount" },
                ].map((row) => (
                  <li key={row.ex} className="flex items-baseline gap-2.5 min-w-0">
                    <span className="shrink-0 font-mono text-[11.5px] text-ppp-navy-700 bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
                      {row.ex}
                    </span>
                    <span className="text-[12px] text-ppp-charcoal-500 min-w-0">{row.what}</span>
                  </li>
                ))}
              </ul>
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
        {/* "Press ⌘K anywhere" removed — telling someone how to open the thing
            they're already looking at is the definition of noise, and it was
            competing with the two hints that DO help. Hidden on mobile
            entirely: there's no keyboard to navigate with. */}
        <div className="hidden sm:flex px-4 py-2 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/40 text-[10px] text-ppp-charcoal-500 items-center gap-3">
          <span>
            <kbd className="font-mono bg-surface border border-ppp-charcoal-200 rounded px-1">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono bg-surface border border-ppp-charcoal-200 rounded px-1">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono bg-surface border border-ppp-charcoal-200 rounded px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
