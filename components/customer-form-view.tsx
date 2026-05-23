"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormRenderData, FormLineItem } from "@/lib/customer-form/render-data";

type Props = {
  token: string;
  customerName: string | null;
  formData: FormRenderData;
};

type ColorOption = {
  id: string;
  name: string;
  code: string | null;
  hex: string | null;
  manufacturerId: string | null;
};

/** One color pick per surface slot. The form holds N of these per line item. */
type SurfacePick = {
  colorId: string | null;
  colorName: string | null;     // denormalized so we can render label without re-fetching
  colorCode: string | null;
  colorHex: string | null;
  finish: string | null;
};

type LineItemState = {
  picks: Record<string, SurfacePick>; // key = surface name e.g. "Walls"
  notes: string;
};

const FINISH_OPTIONS = [
  "Flat / Matte",
  "Eggshell",
  "Satin",
  "Semi-Gloss",
  "Gloss / High-Gloss",
];

export default function CustomerFormView({ token, customerName, formData }: Props) {
  // Seed state from any existing color picks on the WOLI (in case admin
  // resent the form after a prior submission).
  const initialState = useMemo<Record<string, LineItemState>>(() => {
    const state: Record<string, LineItemState> = {};
    for (const li of formData.lineItems) {
      state[li.id] = {
        picks: Object.fromEntries(
          li.surfaces.map((s) => [s, emptyPick()])
        ),
        notes: li.existingNotes ?? "",
      };
    }
    return state;
  }, [formData]);

  const [state, setState] = useState(initialState);
  const [globalNotes, setGlobalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 sm:p-12 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-4">
          ✓
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">Got it — thanks!</h1>
        <p className="mt-3 text-sm sm:text-base text-ppp-charcoal-500 max-w-md mx-auto">
          Your color picks are with our team. We&apos;ll order the materials and
          reach out to confirm your start date. If anything changes, just
          reply to the email we sent you.
        </p>
      </div>
    );
  }

  const updateSurfacePick = (lineId: string, surface: string, patch: Partial<SurfacePick>) => {
    setState((prev) => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        picks: {
          ...prev[lineId].picks,
          [surface]: { ...prev[lineId].picks[surface], ...patch },
        },
      },
    }));
  };

  const updateLineNotes = (lineId: string, notes: string) => {
    setState((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], notes },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = {
        token,
        lineItems: formData.lineItems.map((li) => ({
          id: li.id,
          surfaces: li.surfaces.map((s) => ({
            surface: s,
            colorId: state[li.id]?.picks[s]?.colorId ?? null,
            colorName: state[li.id]?.picks[s]?.colorName ?? null,
            colorCode: state[li.id]?.picks[s]?.colorCode ?? null,
            finish: state[li.id]?.picks[s]?.finish ?? null,
          })),
          notes: state[li.id]?.notes ?? "",
        })),
        globalNotes,
        renderFetchedAt: formData.fetchedAt,
      };
      const res = await fetch(`/api/customer-form/submit/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(data?.error || `Submit failed (${res.status})`);
      }
      setSubmitted(true);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setSubmitError(m);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 sm:space-y-8">
      {/* Greeting + WO header */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
        <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
          Pick your paint colors
        </div>
        <h1 className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
          {customerName ? `Hi ${customerName} —` : "Hi —"} let&apos;s lock in your colors
        </h1>
        <p className="mt-2 text-xs sm:text-sm text-ppp-charcoal-500 leading-relaxed">
          Below are the areas {formData.ownerName ? `${formData.ownerName} ` : ""}
          scoped during your appointment{formData.workOrderNumber ? ` (Work Order #${formData.workOrderNumber})` : ""}.
          For each surface, pick a color — type a name or code to search the catalog.
          You can add a finish and any notes for our team. We&apos;ll order the
          materials once you submit.
        </p>
      </div>

      {/* Per-line-item sections */}
      {formData.lineItems.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 text-center text-sm text-ppp-charcoal-500">
          We don&apos;t have any rooms detailed for this work order yet. Please
          reply to the PPP email so they can add the details and resend the form.
        </div>
      ) : (
        formData.lineItems.map((li, idx) => (
          <LineItemSection
            key={li.id}
            index={idx + 1}
            lineItem={li}
            state={state[li.id]}
            token={token}
            onSurfaceChange={(surface, patch) => updateSurfacePick(li.id, surface, patch)}
            onNotesChange={(notes) => updateLineNotes(li.id, notes)}
          />
        ))
      )}

      {/* Global extra notes */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <label className="block text-sm font-semibold text-ppp-charcoal mb-2">
            Anything else we should know?
          </label>
          <p className="text-xs text-ppp-charcoal-500 mb-3">
            Special requests, scheduling notes, things we should be careful around — anything.
          </p>
          <textarea
            value={globalNotes}
            onChange={(e) => setGlobalNotes(e.target.value)}
            rows={4}
            className="w-full px-3 py-2.5 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y"
            placeholder="e.g. We have a Friday move-in date, please plan around that. Don't paint the inside of the closets."
          />
        </div>
      )}

      {/* Submit */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-[11px] sm:text-xs text-ppp-charcoal-500">
            Once you submit, we&apos;ll order the materials. To make a change after,
            just reply to the email we sent you.
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 inline-flex items-center justify-center min-h-[48px] px-6 py-3 rounded-lg bg-ppp-blue text-white text-sm sm:text-base font-semibold hover:bg-ppp-blue-600 transition-colors shadow-md shadow-ppp-blue/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? "Sending…" : "Submit my colors"}
          </button>
        </div>
      )}

      {submitError && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-sm text-ppp-orange-700">
          <span className="font-semibold">Something went wrong:</span> {submitError}
          <br />
          Please try again. If it keeps failing, reply to the PPP email and we&apos;ll fix it on our end.
        </div>
      )}
    </form>
  );
}

/* ─── Per-line-item section (one card per room/area) ─── */

function LineItemSection({
  index,
  lineItem,
  state,
  token,
  onSurfaceChange,
  onNotesChange,
}: {
  index: number;
  lineItem: FormLineItem;
  state: LineItemState | undefined;
  token: string;
  onSurfaceChange: (surface: string, patch: Partial<SurfacePick>) => void;
  onNotesChange: (notes: string) => void;
}) {
  if (!state) return null;
  const title = lineItem.areaLabel?.trim() || `Area ${index}`;
  const surfaces = lineItem.surfaces.length > 0 ? lineItem.surfaces : ["Walls"];

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-2xl overflow-hidden">
      <div className="px-5 sm:px-7 py-4 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]/40">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-condensed text-lg sm:text-xl font-bold text-ppp-navy">
            {title}
          </h2>
          <span className="text-[10px] sm:text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
            Room {index}
          </span>
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
          {lineItem.productFamily && <span>{lineItem.productFamily}</span>}
          {lineItem.numCoats && <span>· {lineItem.numCoats} coats</span>}
          <span>· Surfaces: {surfaces.join(", ")}</span>
        </div>
      </div>
      <div className="p-5 sm:p-7 space-y-5">
        {surfaces.map((surface) => (
          <SurfaceRow
            key={surface}
            surface={surface}
            pick={state.picks[surface] ?? emptyPick()}
            token={token}
            onChange={(patch) => onSurfaceChange(surface, patch)}
          />
        ))}
        <div>
          <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
            Notes for this room
          </label>
          <textarea
            value={state.notes}
            onChange={(e) => onNotesChange(e.target.value)}
            rows={2}
            placeholder="Optional — e.g. 'keep accent wall the same' or 'use leftover paint if possible'"
            className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y"
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Surface row: surface label + color picker + finish dropdown ─── */

function SurfaceRow({
  surface,
  pick,
  token,
  onChange,
}: {
  surface: string;
  pick: SurfacePick;
  token: string;
  onChange: (patch: Partial<SurfacePick>) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr_180px] gap-3 sm:items-start">
      <div className="flex items-center gap-2 sm:pt-2.5">
        <div className="font-condensed text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          {surface}
        </div>
      </div>
      <ColorPicker pick={pick} token={token} onPick={onChange} />
      <div>
        <select
          value={pick.finish ?? ""}
          onChange={(e) => onChange({ finish: e.target.value || null })}
          className="w-full px-3 py-2.5 text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        >
          <option value="">Finish (optional)</option>
          {FINISH_OPTIONS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* ─── Color autocomplete picker ─── */

function ColorPicker({
  pick,
  token,
  onPick,
}: {
  pick: SurfacePick;
  token: string;
  onPick: (patch: Partial<SurfacePick>) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ColorOption[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Debounced search on query change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open) return;
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `/api/customer-form/colors/search?token=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        setResults(Array.isArray(data?.results) ? data.results : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, token]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const pickColor = (c: ColorOption) => {
    onPick({
      colorId: c.id,
      colorName: c.name,
      colorCode: c.code,
      colorHex: c.hex,
    });
    setQuery("");
    setOpen(false);
  };

  const clear = () => {
    onPick({ colorId: null, colorName: null, colorCode: null, colorHex: null });
  };

  return (
    <div ref={wrapRef} className="relative">
      {pick.colorId ? (
        <div className="flex items-center gap-2 border border-ppp-charcoal-100 rounded-lg px-3 py-2 bg-[var(--color-surface-muted)]/40">
          <div
            className="h-7 w-7 rounded border border-ppp-charcoal-100 shrink-0"
            style={{
              backgroundColor:
                pick.colorHex && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(pick.colorHex)
                  ? pick.colorHex
                  : "var(--color-ppp-charcoal-100, #e5e7eb)",
            }}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ppp-charcoal truncate">
              {pick.colorName}
            </div>
            {pick.colorCode && (
              <div className="text-[10px] text-ppp-charcoal-500 font-mono">{pick.colorCode}</div>
            )}
          </div>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-ppp-blue hover:text-ppp-blue-700 font-medium shrink-0"
          >
            Change
          </button>
        </div>
      ) : (
        <input
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder="Type a color name or code (e.g. Stardust, 2108-40)"
          className="w-full px-3 py-2.5 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
      )}

      {open && !pick.colorId && (
        <div className="absolute left-0 right-0 top-full mt-1.5 max-h-64 overflow-y-auto bg-white border border-ppp-charcoal-100 rounded-lg shadow-xl shadow-ppp-charcoal/10 z-50">
          {loading && (
            <div className="px-3 py-3 text-xs text-ppp-charcoal-500">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-3 text-xs text-ppp-charcoal-500">
              {query.length === 0 ? "Type to search the color catalog." : "No matches — try a different name or code."}
            </div>
          )}
          {!loading && results.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickColor(c)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ppp-blue-50/60 transition-colors border-t border-ppp-charcoal-100 first:border-t-0"
            >
              <div
                className="h-5 w-5 rounded border border-ppp-charcoal-100 shrink-0"
                style={{
                  backgroundColor:
                    c.hex && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.hex)
                      ? c.hex
                      : "var(--color-ppp-charcoal-100, #e5e7eb)",
                }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="text-ppp-charcoal truncate">{c.name}</div>
              </div>
              {c.code && (
                <span className="font-mono text-[10px] text-ppp-charcoal-500 shrink-0">{c.code}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function emptyPick(): SurfacePick {
  return {
    colorId: null,
    colorName: null,
    colorCode: null,
    colorHex: null,
    finish: null,
  };
}
