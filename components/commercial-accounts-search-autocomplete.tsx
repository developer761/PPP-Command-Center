"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { INPUT_CLS } from "@/lib/commercial/form-classnames";

/**
 * Type-ahead account search for the /commercial/accounts list page.
 *
 * Karan: "when I search for a company name like Microsoft, if I type
 * 'mi' it should start coming up so we can click it." That's exactly
 * what this does. As the user types, we debounce-fetch the lightweight
 * suggestion endpoint and render a dropdown of matches; clicking a
 * row navigates straight to that account's detail page.
 *
 * Falls through to the regular form submit (Enter key) so the existing
 * "filter the list by search term" flow keeps working when the user
 * wants the full filtered list view instead of one specific match.
 *
 * Patterns:
 *   - 250ms debounce so backspacing/typing fast doesn't hammer the API
 *   - Cancels in-flight requests via AbortController when a new
 *     keystroke fires — no stale-response overwrites
 *   - Click-outside closes the dropdown
 *   - Keyboard arrows + Enter pick highlighted row; Escape closes
 *   - Empty state when no matches; spinner while in-flight
 *   - 44px tap targets on every result row
 */

type Suggestion = {
  id: string;
  company_name: string;
  industry: string | null;
  rating: string | null;
};

export default function CommercialAccountsSearchAutocomplete({
  defaultValue,
}: {
  defaultValue?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(defaultValue ?? "");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced fetch — fires 250ms after the last keystroke.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const t = setTimeout(async () => {
      // Cancel any in-flight request before starting a new one — keeps
      // results synchronized with the latest keystroke.
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/commercial/accounts/suggest?q=${encodeURIComponent(term)}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) {
          setResults([]);
          setOpen(true);
          return;
        }
        const json = await res.json();
        const items: Suggestion[] = Array.isArray(json.results) ? json.results : [];
        setResults(items);
        setOpen(true);
        setHighlight(items.length > 0 ? 0 : -1);
      } catch (err) {
        // AbortError is expected on rapid typing — ignore.
        if (!(err instanceof Error && err.name === "AbortError")) {
          console.warn("[accounts-search] fetch failed:", err);
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pickResult = (s: Suggestion) => {
    setOpen(false);
    router.push(`/commercial/accounts/${s.id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && highlight >= 0 && results[highlight]) {
        e.preventDefault();
        pickResult(results[highlight]);
      }
      // Otherwise let the form's default submit fire (full-list filter).
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <svg
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          id="q"
          name="q"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          placeholder="Company name or DBA"
          className={`${INPUT_CLS} pl-10`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="search-autocomplete-list"
        />
        {loading && (
          <div
            className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin"
            aria-hidden
          />
        )}
      </div>

      {open && q.trim().length > 0 && (
        <div
          id="search-autocomplete-list"
          role="listbox"
          className="absolute z-30 mt-1 w-full bg-white border border-ppp-charcoal-200 rounded-xl shadow-lg max-h-72 overflow-y-auto"
        >
          {results.length === 0 && !loading ? (
            <div className="px-4 py-3 text-sm text-ppp-charcoal-500 italic">
              No accounts match &ldquo;{q}&rdquo;. Press Enter to filter the full list.
            </div>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {results.map((s, idx) => (
                <li key={s.id} role="option" aria-selected={idx === highlight}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // onMouseDown not onClick so we fire BEFORE the
                      // input's blur cancels the dropdown.
                      e.preventDefault();
                      pickResult(s);
                    }}
                    onMouseEnter={() => setHighlight(idx)}
                    className={`w-full text-left px-4 py-3 min-h-[44px] touch-manipulation transition-colors ${
                      idx === highlight ? "bg-emerald-50" : "hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    <div className="text-sm font-semibold text-ppp-charcoal truncate">
                      {s.company_name}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-ppp-charcoal-500">
                      {s.industry && <span>{s.industry}</span>}
                      {s.rating && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-50 border border-ppp-charcoal-200 font-semibold text-ppp-charcoal-700">
                          {s.rating}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
