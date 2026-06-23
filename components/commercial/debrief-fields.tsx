"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Win/Loss Debrief Fields — reactive add-on to the opp status-change form.
 *
 * Mounted INSIDE the existing form (so it submits with the same FormData).
 * When the parent status dropdown is set to a terminal state (won/lost/no_bid),
 * this component fades in the debrief fields. Otherwise renders nothing
 * (no spacer, no flicker).
 *
 * Wires:
 *   - `name="debrief_competitor"`   — free-text resolved server-side
 *   - `name="debrief_deciding_factor"` — enum value (same as loss_reason)
 *   - `name="debrief_lessons"`      — free text
 *   - `name="debrief_internal_notes"` — free text
 *   - `name="debrief_skip"`         — "1" if user explicitly skipped
 *
 * Watches the sibling `<select name="to_status">` for change events so we
 * don't need a context wrapper — keeps the integration into the existing
 * server-component form minimal.
 *
 * Mobile-first: full-width inputs, text-base sizing (no iOS auto-zoom),
 * 44px tap targets, sticky button positioning on small screens.
 */

const TERMINAL_STATUSES = new Set(["won", "lost", "no_bid"]);

type Props = {
  /** Initial status from URL pre-select (kanban-drag flow). Triggers
   *  the panel to render expanded on first paint when terminal. */
  initialStatus?: string;
  /** Optional already-stored values when re-opening the modal to fill out
   *  a skipped debrief later. */
  initialCompetitor?: string;
  initialDecidingFactor?: string;
  initialLessons?: string;
  initialInternalNotes?: string;
};

const DECIDING_FACTORS: Array<{ value: string; label: string; hint: string }> = [
  { value: "price", label: "Price", hint: "Won/lost based on dollars" },
  { value: "scope", label: "Scope mismatch", hint: "Job didn't fit our wheelhouse" },
  { value: "timing", label: "Timing", hint: "Schedule didn't align" },
  { value: "no_decision", label: "No decision made", hint: "Customer never picked anyone" },
  { value: "awarded_to_competitor", label: "Awarded to competitor", hint: "They picked someone else" },
  { value: "relationship", label: "Relationship", hint: "Existing relationship was the deciding factor" },
  { value: "other", label: "Other", hint: "Use lessons field below" },
];

export default function DebriefFields(props: Props) {
  const initial = props.initialStatus?.toLowerCase() ?? "";
  const [terminal, setTerminal] = useState<"won" | "lost" | "no_bid" | null>(
    TERMINAL_STATUSES.has(initial) ? (initial as "won" | "lost" | "no_bid") : null
  );

  // Watch the sibling status dropdown without needing a Context provider.
  // The form is in a server component; we hook directly to the DOM element.
  useEffect(() => {
    const select = document.querySelector<HTMLSelectElement>('select[name="to_status"]');
    if (!select) return;
    const onChange = () => {
      const v = select.value.toLowerCase();
      setTerminal(TERMINAL_STATUSES.has(v) ? (v as "won" | "lost" | "no_bid") : null);
    };
    select.addEventListener("change", onChange);
    // Sync once on mount in case the dropdown already has a pre-selected
    // terminal value from URL params.
    onChange();
    return () => select.removeEventListener("change", onChange);
  }, []);

  if (!terminal) return null;

  return (
    <section
      data-debrief
      className="mt-4 p-4 rounded-xl border border-emerald-200 bg-emerald-50/40 animate-fade-up"
      aria-label="Win/Loss debrief"
    >
      <header className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-ppp-charcoal">
            {terminal === "won" ? "🎉 Win Debrief" : terminal === "lost" ? "Loss Debrief" : "No-Bid Debrief"}
          </h3>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            {terminal === "won"
              ? "Capture what sealed it — feeds the quarterly review."
              : "Capture who won + why — feeds the quarterly review. You can skip + fill in later."}
          </p>
        </div>
      </header>

      <CompetitorTypeahead
        outcome={terminal}
        initialValue={props.initialCompetitor ?? ""}
      />

      <div className="mt-3">
        <label htmlFor="debrief_deciding_factor" className="block text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-1.5">
          {terminal === "won" ? "What sealed it?" : "Deciding factor"}
          {terminal !== "won" && <span className="text-rose-700 ml-1">*</span>}
        </label>
        <select
          id="debrief_deciding_factor"
          name="debrief_deciding_factor"
          defaultValue={props.initialDecidingFactor ?? ""}
          required={terminal !== "won"}
          className="block w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
        >
          <option value="">— pick one —</option>
          {DECIDING_FACTORS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <label htmlFor="debrief_lessons" className="block text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-1.5">
          {terminal === "won" ? "What would you do MORE of next time?" : "What would we do differently?"}
        </label>
        <textarea
          id="debrief_lessons"
          name="debrief_lessons"
          defaultValue={props.initialLessons ?? ""}
          rows={3}
          maxLength={2000}
          placeholder={
            terminal === "won"
              ? "e.g. They valued our portfolio over price — lean harder on portfolio early in pitches."
              : "e.g. We quoted 6 months but they wanted 4. Stop padding K-12 timelines."
          }
          className="block w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <p className="text-[10px] text-ppp-charcoal-400 mt-1">
          This is gold for the quarterly review — even one sentence helps.
        </p>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal select-none min-h-[24px] flex items-center">
          Add internal notes (optional)
        </summary>
        <textarea
          name="debrief_internal_notes"
          defaultValue={props.initialInternalNotes ?? ""}
          rows={2}
          maxLength={2000}
          placeholder="Anything else not captured above — private to the team."
          className="mt-2 block w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </details>

      <div className="mt-3 flex items-center gap-2">
        <input type="checkbox" id="debrief_skip" name="debrief_skip" value="1" className="h-4 w-4" />
        <label htmlFor="debrief_skip" className="text-[12px] text-ppp-charcoal-500">
          Skip the debrief for now — I&apos;ll fill it in later
        </label>
      </div>
    </section>
  );
}

function CompetitorTypeahead({
  outcome,
  initialValue,
}: {
  outcome: "won" | "lost" | "no_bid";
  initialValue: string;
}) {
  const [query, setQuery] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Debounced fetch on query change. Cancels in-flight on rapid typing.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/commercial/competitors?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data.competitors ?? []);
        }
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Close dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  // Show fuzzy-match suggestion when query is close to but not exactly a known competitor.
  const fuzzyHint = useMemo(() => {
    if (!query.trim()) return null;
    const lower = query.trim().toLowerCase();
    const exact = suggestions.find((s) => s.name.toLowerCase() === lower);
    if (exact) return null;
    const close = suggestions.find(
      (s) =>
        s.name.toLowerCase().startsWith(lower) ||
        s.name.toLowerCase().includes(lower)
    );
    return close ? `Did you mean ${close.name}?` : null;
  }, [query, suggestions]);

  const label =
    outcome === "won" ? "Who'd we beat? (optional)" : "Who won it?";
  const required = outcome === "lost"; // lost requires competitor; won + no_bid optional

  return (
    <div ref={wrapperRef} className="relative">
      <label htmlFor="debrief_competitor" className="block text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-1.5">
        {label}
        {required && <span className="text-rose-700 ml-1">*</span>}
      </label>
      <input
        ref={inputRef}
        id="debrief_competitor"
        name="debrief_competitor"
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        required={required}
        autoComplete="off"
        placeholder="Type to search or add a new competitor"
        className="block w-full px-3 py-2.5 rounded-lg border border-ppp-charcoal-200 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
      />
      {fuzzyHint && !open && (
        <p className="text-[10px] text-amber-700 mt-1">{fuzzyHint}</p>
      )}
      {open && (query.length > 0 || suggestions.length > 0) && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-ppp-charcoal-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {loading && suggestions.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-ppp-charcoal-500">Searching…</div>
          ) : suggestions.length === 0 ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="block w-full text-left px-3 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 min-h-[44px]"
            >
              + Add &quot;{query}&quot; as new competitor
            </button>
          ) : (
            <>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setQuery(s.name);
                    setOpen(false);
                    inputRef.current?.focus();
                  }}
                  className="block w-full text-left px-3 py-2.5 text-sm hover:bg-ppp-charcoal-50 text-ppp-charcoal min-h-[44px]"
                >
                  {s.name}
                </button>
              ))}
              {!suggestions.some((s) => s.name.toLowerCase() === query.trim().toLowerCase()) && query.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="block w-full text-left px-3 py-2.5 text-sm text-emerald-700 hover:bg-emerald-50 border-t border-ppp-charcoal-100 min-h-[44px]"
                >
                  + Add &quot;{query.trim()}&quot; as new competitor
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
