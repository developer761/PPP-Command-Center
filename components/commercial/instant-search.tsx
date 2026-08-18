"use client";

/**
 * <InstantSearch> — the ONE search box for the Commercial platform.
 *
 * Karan 2026-08-17: *"for the search bar there anywhere i shouldn't have to
 * press enter for results to show up. as soon as i start typing like 'br' it
 * should give me results to click on them and bring me into that page, it
 * should be a smart search bar everywhere as well the same rule."*
 *
 * Every page search box was a plain `<form><input name="q">` — you typed, you
 * pressed Enter, the server re-rendered the whole page, and you got a FILTERED
 * LIST, not an answer. Finding one opportunity took a keystroke you had to know
 * about plus a full round-trip plus a scan of the results.
 *
 * Two behaviours, one component, because the platform has two kinds of search:
 *
 *  - `mode="jump"` (records: opportunities, GCs, invoices, projects, proposals)
 *    Typing fires a debounced lookup and drops a result list under the box.
 *    Click — or ↑/↓ then Enter — and you land ON the record. Enter with nothing
 *    highlighted still submits the filter form, so the old muscle memory works.
 *
 *  - `mode="filter"` (libraries: products, exclusions)
 *    There is nothing to "land on" — the answer IS the filtered list — so the
 *    list re-filters as you type via a debounced URL update. No dropdown, no
 *    Enter.
 *
 * Deliberate details:
 *  - 2-character floor. One letter matches most of the book and the dropdown
 *    becomes noise.
 *  - Requests are sequence-stamped; a slow early response can never overwrite a
 *    newer one (type fast on a cold connection and the old shape flickered the
 *    wrong results in).
 *  - The dropdown is keyboard-complete and `aria-activedescendant`-wired, and
 *    every row is 44px so it is usable with a thumb — this is the surface Alex
 *    opens on a phone every morning.
 *  - Blur closes on a timeout, not immediately, or the click that picks a
 *    result unmounts the row before the click lands.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type InstantKind =
  | "account"
  | "opportunity"
  | "proposal"
  | "invoice"
  | "document";

type Hit = {
  kind: InstantKind;
  id: string;
  label: string;
  hint: string;
  href: string;
};

const KIND_LABEL: Record<InstantKind, string> = {
  account: "GC",
  opportunity: "Opportunity",
  proposal: "Proposal",
  invoice: "Invoice",
  document: "Document",
};

const KIND_TONE: Record<InstantKind, string> = {
  account: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200",
  opportunity: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200",
  proposal: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200",
  invoice: "bg-emerald-50 text-emerald-800 border-emerald-200",
  document: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200",
};

const MIN_CHARS = 2;
const DEBOUNCE_MS = 160;

export function InstantSearch({
  name = "q",
  defaultValue = "",
  placeholder,
  ariaLabel,
  mode = "jump",
  kinds,
  className = "",
  autoFocus = false,
}: {
  name?: string;
  defaultValue?: string;
  placeholder: string;
  ariaLabel?: string;
  mode?: "jump" | "filter";
  /** Which record types the dropdown may return. Omit for everything. */
  kinds?: InstantKind[];
  className?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const listId = useId();
  const [value, setValue] = useState(defaultValue);
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const [searched, setSearched] = useState(false);

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLInputElement | null>(null);

  // The URL this box owns, for filter mode. Rebuilt from the LIVE URL each time
  // so a filter/sort/view the user set elsewhere on the page is preserved —
  // rewriting the whole query string here silently cleared them.
  const pushFilter = useCallback(
    (q: string) => {
      const url = new URL(window.location.href);
      if (q.trim()) url.searchParams.set(name, q.trim());
      else url.searchParams.delete(name);
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    },
    [name, router]
  );

  const runLookup = useCallback(
    async (q: string) => {
      const seq = ++seqRef.current;
      setBusy(true);
      try {
        const params = new URLSearchParams({ q });
        if (kinds && kinds.length > 0) params.set("kinds", kinds.join(","));
        const res = await fetch(`/api/commercial/palette-search?${params}`, {
          cache: "no-store",
        });
        // A response that is no longer the newest must not paint. Without this,
        // typing "brendan" fast on a slow link could land "b"'s results last.
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          setHits([]);
          setSearched(true);
          return;
        }
        const json = (await res.json()) as { results?: Hit[] };
        if (seq !== seqRef.current) return;
        setHits(json.results ?? []);
        setSearched(true);
        setActive(-1);
      } catch {
        if (seq === seqRef.current) {
          // Offline / aborted: fall back to the plain filter form silently
          // rather than showing a scary empty dropdown.
          setHits([]);
          setSearched(true);
        }
      } finally {
        if (seq === seqRef.current) setBusy(false);
      }
    },
    [kinds]
  );

  function onChange(next: string) {
    setValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);

    if (mode === "filter") {
      timerRef.current = setTimeout(() => pushFilter(next), DEBOUNCE_MS * 2);
      return;
    }

    if (next.trim().length < MIN_CHARS) {
      seqRef.current++; // cancel anything in flight
      setHits([]);
      setSearched(false);
      setOpen(false);
      setBusy(false);
      return;
    }
    setOpen(true);
    timerRef.current = setTimeout(() => runLookup(next.trim()), DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (blurRef.current) clearTimeout(blurRef.current);
    },
    []
  );

  function go(hit: Hit) {
    setOpen(false);
    if (hit.kind === "document") {
      // Documents are a file, not a page — same as the ⌘K palette does.
      window.open(hit.href, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(hit.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (mode === "filter") return;
    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!open || hits.length === 0) {
      // Enter with no dropdown = the old behaviour: submit the filter form.
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? hits.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0 && active < hits.length) {
      // Only intercept Enter when a row is actually highlighted — otherwise the
      // form submit (filter the list) still wins, which is what someone who has
      // typed a broad term and wants the filtered view expects.
      e.preventDefault();
      go(hits[active]);
    }
  }

  const showDropdown =
    mode === "jump" && open && value.trim().length >= MIN_CHARS;

  return (
    <div className={`relative min-w-0 ${className}`}>
      <svg
        aria-hidden
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={boxRef}
        type="search"
        name={name}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (mode === "jump" && value.trim().length >= MIN_CHARS) setOpen(true);
        }}
        onBlur={() => {
          // Deferred: an immediate close unmounts the row before its click
          // registers, so picking a result did nothing at all.
          blurRef.current = setTimeout(() => setOpen(false), 140);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        role={mode === "jump" ? "combobox" : undefined}
        aria-expanded={mode === "jump" ? showDropdown : undefined}
        aria-controls={mode === "jump" ? listId : undefined}
        aria-autocomplete={mode === "jump" ? "list" : undefined}
        aria-activedescendant={
          showDropdown && active >= 0 ? `${listId}-${active}` : undefined
        }
        // text-base on mobile: anything under 16px makes iOS Safari zoom the
        // whole page on focus, and it never zooms back out.
        className="w-full pl-9 pr-9 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
      />
      {busy && (
        <svg
          aria-hidden
          className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-ppp-charcoal-400"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M21 12a9 9 0 1 1-6.2-8.6" />
        </svg>
      )}

      {showDropdown && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-[min(60vh,380px)] overflow-y-auto rounded-xl border border-ppp-charcoal-200 bg-surface shadow-xl p-1"
        >
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-ppp-charcoal-500">
              {busy || !searched
                ? "Searching…"
                : `Nothing matches "${value.trim()}". Press Enter to filter the list instead.`}
            </p>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.kind}:${h.id}`}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                // onMouseDown, not onClick: the input's blur fires first and
                // would otherwise close the list out from under the click.
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(h);
                }}
                onMouseEnter={() => setActive(i)}
                className={`w-full flex items-center gap-2.5 text-left px-2.5 py-2 rounded-lg min-h-[44px] ${
                  i === active ? "bg-cc-brand-50" : "hover:bg-ppp-charcoal-50"
                }`}
              >
                <span
                  className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-wide ${KIND_TONE[h.kind]}`}
                >
                  {KIND_LABEL[h.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-ppp-charcoal truncate">
                    {h.label}
                  </span>
                  {h.hint && (
                    <span className="block text-[11px] text-ppp-charcoal-500 truncate">
                      {h.hint}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default InstantSearch;
