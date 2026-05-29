"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FormRenderData, FormLineItem } from "@/lib/customer-form/render-data";
import { resolveSwatchHex } from "@/lib/customer-form/color-swatch";

/** Color catalog context — fetched once at form mount, shared by every ColorPicker. */
const CatalogContext = createContext<CatalogState>({ status: "loading" });
function useCatalog(): CatalogState {
  return useContext(CatalogContext);
}

type FormCopy = {
  headerEyebrow: string;
  headerTitle: string;
  headerSubtitle: string;
  globalNotesLabel: string;
  thankyouTitle: string;
  thankyouBody: string;
};

type Props = {
  token: string;
  customerName: string | null;
  formData: FormRenderData;
  /** Editable customer-facing copy from lib/customer-form/templates.ts.
   *  Code defaults applied at the server side, so this is always populated. */
  copy: FormCopy;
};

type ColorOption = {
  id: string;
  name: string;
  code: string | null;
  hex: string | null;
  manufacturerId: string | null;
  manufacturerName?: string | null;
};

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; colors: ColorOption[] }
  | { status: "error"; message: string };

/** One color pick per surface slot. The form holds N of these per line item.
 *  When `skipped` is true the customer explicitly opted out of painting this
 *  surface — the supplier order builder + SF write-back both skip it. */
type SurfacePick = {
  colorId: string | null;
  colorName: string | null;     // denormalized so we can render label without re-fetching
  colorCode: string | null;
  colorHex: string | null;
  finish: string | null;
  skipped: boolean;
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

/**
 * Sensible default finish per surface (Katie 2026-05-29) — auto-filled the
 * moment a customer picks a color so the choice is complete without extra
 * taps. Values match FINISH_OPTIONS exactly. Covers PPP's full Surfaces__c
 * picklist (Walls/Ceiling/Trim/Floor/Accent Wall/Cabinets/Door/Window/
 * Closet/Shelves): ceilings flat, woodwork semi-gloss, floors satin, the
 * rest eggshell.
 */
function defaultFinishForSurface(surface: string): string {
  const s = surface.toLowerCase();
  if (s.includes("ceiling")) return "Flat / Matte";
  if (s.includes("trim") || s.includes("door") || s.includes("window")) return "Semi-Gloss";
  if (s.includes("floor")) return "Satin";
  return "Eggshell";
}

/** Room/section title: Product Name · Area Label, with fallbacks. Shared by
 *  the section header + the submit-validation message so they always match. */
function roomTitle(li: FormLineItem, oneBasedIndex: number): string {
  const parts = [li.productName?.trim() || "", li.areaLabel?.trim() || ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : li.productFamily?.trim() || `Section ${oneBasedIndex}`;
}

export default function CustomerFormView({ token, customerName, formData, copy }: Props) {
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
  // Ref-based guard — React batches setState so two rapid clicks could
  // both pass `if (submitting) return` before either commits the new value.
  // The ref updates synchronously so a double-click is caught immediately.
  const submitInFlight = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // Delivery address confirmation — seeded from SF Account.BillingAddress.
  // Customer can edit before submit. Saved into customer_form_tokens.
  // submitted_payload.deliveryAddress so the supplier-order builder uses
  // the customer-verified address (preferred) over the stale SF account row.
  const [deliveryStreet, setDeliveryStreet] = useState(formData.billingAddress.street ?? "");
  const [deliveryCity, setDeliveryCity] = useState(formData.billingAddress.city ?? "");
  const [deliveryState, setDeliveryState] = useState(formData.billingAddress.state ?? "");
  const [deliveryPostalCode, setDeliveryPostalCode] = useState(formData.billingAddress.postalCode ?? "");

  // Fetch the full color catalog ONCE on form mount so every ColorPicker
  // filters in-memory (zero latency per keystroke). Previously every keystroke
  // round-tripped to /colors/search — added 200-400ms per character on cell
  // networks, frustrating customers. Catalog is ~5,762 colors, ~80KB gzipped;
  // browser caches it for 1 hour via the API's Cache-Control.
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/customer-form/colors/all?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          const msg = `HTTP ${res.status}`;
          if (!cancelled) setCatalog({ status: "error", message: msg });
          return;
        }
        const data = await res.json();
        const colors: ColorOption[] = Array.isArray(data?.colors) ? data.colors : [];
        if (!cancelled) setCatalog({ status: "ready", colors });
      } catch (err) {
        if (!cancelled) {
          setCatalog({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (submitted) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 sm:p-12 text-center">
        <div className="mx-auto h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-4">
          ✓
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">{copy.thankyouTitle}</h1>
        <p className="mt-3 text-sm sm:text-base text-ppp-charcoal-500 max-w-md mx-auto whitespace-pre-line">
          {copy.thankyouBody}
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
    // Double-submit guard — Enter key + button click can fire twice in
    // <100ms; React batches setSubmitting so two events can both pass the
    // submitting=false check. The ref updates synchronously.
    if (submitInFlight.current || submitting) return;
    // Block submit if the color catalog didn't load — without it the
    // customer's picks reference colors we can't look up, and the submit
    // would persist orphaned colorIds. Better to refuse early with a
    // clear message than corrupt the data quietly.
    if (catalog.status !== "ready") {
      setSubmitError(
        catalog.status === "error"
          ? `Couldn't load the color catalog: ${catalog.message}. Refresh the page and try again.`
          : "Color catalog still loading — wait a moment and try again."
      );
      return;
    }
    // Finish is required wherever a color is picked (Katie 2026-05-29). A
    // default auto-fills on pick, so this only fires if the customer cleared a
    // finish. Name the exact room → surface so they can find it fast.
    const missingFinish: string[] = [];
    formData.lineItems.forEach((li, i) => {
      const st = state[li.id];
      if (!st) return;
      for (const s of li.surfaces) {
        const p = st.picks[s];
        if (p && !p.skipped && p.colorId && !p.finish) {
          missingFinish.push(`${roomTitle(li, i + 1)} → ${s}`);
        }
      }
    });
    if (missingFinish.length > 0) {
      setSubmitError(`Please choose a finish for: ${missingFinish.join("; ")}.`);
      return;
    }
    submitInFlight.current = true;
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
            // Explicit "customer opted out" — distinct from "left blank /
            // didn't get to". Submit handler skips writing colors for
            // both, but the audit trail preserves the intent so admin can
            // see "customer specifically said don't paint the ceiling"
            // vs. "customer forgot to pick a color for the ceiling."
            skipped: state[li.id]?.picks[s]?.skipped ?? false,
          })),
          notes: state[li.id]?.notes ?? "",
        })),
        globalNotes,
        renderFetchedAt: formData.fetchedAt,
        // Customer-confirmed delivery address. Persisted to
        // customer_form_tokens.submitted_payload.deliveryAddress; the
        // supplier-order builder reads it in preference to the stale SF
        // Account.BillingAddress. Empty street = customer didn't fill it
        // in, builder will fall back to the SF account address.
        deliveryAddress: {
          name: customerName ?? null,
          street: deliveryStreet.trim(),
          city: deliveryCity.trim(),
          state: deliveryState.trim(),
          postalCode: deliveryPostalCode.trim(),
        },
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
      submitInFlight.current = false;
    }
  };

  return (
    <CatalogContext.Provider value={catalog}>
    <form onSubmit={handleSubmit} className="space-y-6 sm:space-y-8">
      {/* Greeting + WO header — all text editable via /dashboard/settings/templates */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
        <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
          {copy.headerEyebrow}
        </div>
        <h1 className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
          {copy.headerTitle}
        </h1>
        <p className="mt-2 text-xs sm:text-sm text-ppp-charcoal-500 leading-relaxed whitespace-pre-line">
          {copy.headerSubtitle}
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

      {/* Confirm delivery address — last review before submit. Materials get
          shipped here unless customer specifies pickup with PPP. Pre-filled
          from SF Account.BillingAddress so most customers just confirm
          rather than type. */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
            Delivery address
          </div>
          <h2 className="font-condensed text-lg sm:text-xl font-bold text-ppp-navy mt-1">
            Where should we deliver the materials?
          </h2>
          <p className="mt-2 text-xs sm:text-sm text-ppp-charcoal-500 leading-relaxed">
            Our team will deliver paint + supplies straight to this address before
            your job starts. Please correct anything that&apos;s out of date —
            this is the address our supplier uses.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                Street address
              </label>
              <input
                type="text"
                value={deliveryStreet}
                onChange={(e) => setDeliveryStreet(e.target.value)}
                placeholder="123 Main St"
                className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                autoComplete="street-address"
              />
            </div>
            {/* Mobile: City full-width on its own row; State + ZIP share the
                next row (50/50 split, both readable on iPhone SE 375px).
                Desktop keeps the existing 1fr / 160 / 140 layout. */}
            <div className="grid grid-cols-[1fr_1fr] sm:grid-cols-[1fr_160px_140px] gap-3 [&>:first-child]:col-span-2 sm:[&>:first-child]:col-span-1">
              <div>
                <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                  City
                </label>
                <input
                  type="text"
                  value={deliveryCity}
                  onChange={(e) => setDeliveryCity(e.target.value)}
                  placeholder="Smithtown"
                  className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                  autoComplete="address-level2"
                />
              </div>
              <div>
                <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                  State
                </label>
                <input
                  type="text"
                  value={deliveryState}
                  onChange={(e) => setDeliveryState(e.target.value)}
                  placeholder="NY"
                  maxLength={2}
                  className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue uppercase"
                  autoComplete="address-level1"
                />
              </div>
              <div>
                <label className="block text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-1">
                  ZIP
                </label>
                <input
                  type="text"
                  value={deliveryPostalCode}
                  onChange={(e) => setDeliveryPostalCode(e.target.value)}
                  placeholder="11787"
                  inputMode="numeric"
                  className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
                  autoComplete="postal-code"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global extra notes */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <label className="block text-sm font-semibold text-ppp-charcoal mb-2">
            {copy.globalNotesLabel}
          </label>
          <p className="text-xs text-ppp-charcoal-500 mb-3">
            Special requests, scheduling notes, things we should be careful around — anything.
          </p>
          <textarea
            value={globalNotes}
            onChange={(e) => setGlobalNotes(e.target.value)}
            rows={4}
            className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y"
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
    </CatalogContext.Provider>
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
  // Room title (Katie 2026-05-29): Product Name + Area Label, in that order.
  //   "Interior Painting · Master Bedroom"
  // Fallback chain when one/both are missing so the section is never blank
  // or a bare " · ":
  //   productName + areaLabel  →  whichever exists  →  productFamily  →  "Section N"
  const rawArea = lineItem.areaLabel?.trim() || "";
  const rawProduct = lineItem.productName?.trim() || "";
  const rawFamily = lineItem.productFamily?.trim() || "";
  const titleParts = [rawProduct, rawArea].filter(Boolean);
  const title = titleParts.length > 0 ? titleParts.join(" · ") : rawFamily || `Section ${index}`;
  // Show the scope family as a caption only when it isn't already in the title.
  const showFamilyCaption = !!rawFamily && !title.toLowerCase().includes(rawFamily.toLowerCase());
  const surfaces = lineItem.surfaces.length > 0 ? lineItem.surfaces : ["Walls"];

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-2xl overflow-hidden">
      <div className="px-5 sm:px-7 py-4 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]/40">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-condensed text-lg sm:text-xl font-bold text-ppp-navy">
            {title}
          </h2>
          <span className="text-[10px] sm:text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">
            Section {index}
          </span>
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
          {showFamilyCaption && <span>{rawFamily}</span>}
          {lineItem.numCoats && (
            <span>
              {showFamilyCaption ? "· " : ""}{lineItem.numCoats} coats
            </span>
          )}
          <span>{showFamilyCaption || lineItem.numCoats ? "· " : ""}Surfaces: {surfaces.join(", ")}</span>
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
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y"
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
  const toggleSkip = () => {
    if (pick.skipped) {
      // Un-skip — clear the skipped flag, leave color/finish empty so
      // customer picks fresh.
      onChange({ skipped: false });
    } else {
      // Skip — clear any picked color + flag explicitly skipped.
      onChange({
        skipped: true,
        colorId: null,
        colorName: null,
        colorCode: null,
        colorHex: null,
        finish: null,
      });
    }
  };

  // When the customer picks a color, auto-fill the surface's default finish if
  // they haven't chosen one — so a color always lands complete (finish is
  // required). Clearing the color also clears the finish so a stale finish
  // doesn't linger on an empty surface.
  const handleColorPick = (patch: Partial<SurfacePick>) => {
    if (patch.colorId) {
      onChange({ finish: pick.finish ?? defaultFinishForSurface(surface), ...patch });
    } else if (patch.colorId === null) {
      onChange({ ...patch, finish: null });
    } else {
      onChange(patch);
    }
  };

  // A picked color with no finish is incomplete — flag it (submit also blocks).
  const finishMissing = !!pick.colorId && !pick.finish;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[110px_1fr_180px] gap-3 sm:items-start">
      <div className="flex items-center gap-2 sm:pt-2.5 justify-between sm:justify-start">
        <div className="font-condensed text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          {surface}
        </div>
        {/* Skip toggle — small text button. When skipped, label changes to
            "Add color" so customer can revert. Available always so the
            customer can opt out of any surface they don't want painted. */}
        <button
          type="button"
          onClick={toggleSkip}
          className="text-[10px] text-ppp-charcoal-500 hover:text-ppp-blue underline-offset-2 hover:underline transition-colors sm:hidden"
        >
          {pick.skipped ? "Add color" : "Skip this"}
        </button>
      </div>
      {pick.skipped ? (
        <div className="sm:col-span-2 flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-[var(--color-surface-muted)]/40 border border-dashed border-ppp-charcoal-100">
          <span className="text-sm text-ppp-charcoal-500 italic">
            Not painting this surface — skipped
          </span>
          <button
            type="button"
            onClick={toggleSkip}
            className="text-xs text-ppp-blue hover:text-ppp-blue-700 font-medium shrink-0"
          >
            Add color instead
          </button>
        </div>
      ) : (
        <>
          <ColorPicker pick={pick} onPick={handleColorPick} />
          <div className="flex flex-col gap-1">
            <select
              value={pick.finish ?? ""}
              onChange={(e) => onChange({ finish: e.target.value || null })}
              aria-invalid={finishMissing}
              // text-base on mobile to keep ≥16px and avoid iOS zoom-on-focus;
              // py-3 on mobile to hit 44px target. Native <select> renders the
              // iOS wheel picker which is touch-perfect — keep using native here.
              className={[
                "w-full px-3 py-3 sm:py-2.5 text-base sm:text-sm border rounded-lg bg-white focus:outline-none focus:ring-2",
                finishMissing
                  ? "border-ppp-orange-300 focus:ring-ppp-orange-100 focus:border-ppp-orange-400"
                  : "border-ppp-charcoal-100 focus:ring-ppp-blue/30 focus:border-ppp-blue",
              ].join(" ")}
            >
              {/* When a color is picked, finish is REQUIRED (Katie 2026-05-29).
                  A default is auto-filled on pick, so this empty option only
                  appears if the customer deliberately clears it. */}
              <option value="">{pick.colorId ? "Choose a finish…" : "Finish (optional)"}</option>
              {FINISH_OPTIONS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            {finishMissing && (
              <span className="text-[10px] text-ppp-orange-700 font-medium">
                Pick a finish for this color
              </span>
            )}
            {/* Desktop-only skip link — under finish dropdown to match
                visual rhythm. Mobile gets the inline link in the label row. */}
            <button
              type="button"
              onClick={toggleSkip}
              className="hidden sm:inline-block text-[10px] text-ppp-charcoal-500 hover:text-ppp-blue underline text-right"
            >
              Don&apos;t paint this surface
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Color autocomplete picker ─── */

function ColorPicker({
  pick,
  onPick,
}: {
  pick: SurfacePick;
  onPick: (patch: Partial<SurfacePick>) => void;
}) {
  const catalog = useCatalog();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Client-side filter — zero latency per keystroke. Scoring matches the old
  // server-side scoring exactly:
  //   100 = exact code match (e.g. "2108-40" → BM Stardust)
  //   50  = name (or shortName) starts with query
  //   30  = code starts with query
  //   10  = name (or shortName) contains query
  //   5   = code contains query
  // Returns top 30 sorted by score desc, then alphabetically by name.
  const results: ColorOption[] = useMemo(() => {
    if (catalog.status !== "ready") return [];
    const q = query.trim().toLowerCase();

    // Empty query → return first 30 (starter set when picker just opened)
    if (q.length === 0) return catalog.colors.slice(0, 30);

    const scored: Array<{ score: number; c: ColorOption }> = [];
    const colors = catalog.colors;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const code = (c.code ?? "").toLowerCase();
      const name = (c.name ?? "").toLowerCase();
      let score = 0;
      if (code === q) score = 100;
      else if (name.startsWith(q)) score = 50;
      else if (code.startsWith(q)) score = 30;
      else if (name.includes(q)) score = 10;
      else if (code.includes(q)) score = 5;
      if (score > 0) scored.push({ score, c });
      // Early-exit if we've found a LOT of candidates — sorting is cheap on
      // small sets, but if a 1-char query matches 3000 colors we'd waste a
      // few ms sorting them all. Cap at 200 candidates; we only show 30.
      if (scored.length >= 200) break;
    }
    scored.sort((a, b) => (b.score - a.score) || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, 30).map((r) => r.c);
  }, [catalog, query]);

  // Click/tap outside to close. pointerdown handles BOTH mouse + touch in
  // one event — iOS Safari doesn't fire mousedown reliably on touch, which
  // meant the color picker stayed open on phones until reload. Critical for
  // this view because customers fill the form on their phones.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
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

  // Resolve a usable swatch for the picked color. Real hex takes priority;
  // name-keyword match is the visual fallback so customers see "something
  // like that color" rather than a confusing gray box when SF has no hex.
  const swatch = pick.colorId
    ? resolveSwatchHex(pick.colorHex, pick.colorName, pick.colorCode)
    : null;

  return (
    <div ref={wrapRef} className="relative">
      {pick.colorId ? (
        <div className="flex items-center gap-2 border border-ppp-charcoal-100 rounded-lg px-3 py-2 bg-[var(--color-surface-muted)]/40">
          {swatch ? (
            <div
              className="h-7 w-7 rounded border border-ppp-charcoal-100 shrink-0 relative"
              style={{ backgroundColor: swatch.hex }}
              aria-hidden
              title={swatch.isApproximate ? "Approximate — actual paint may vary" : undefined}
            >
              {swatch.isApproximate && (
                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-ppp-charcoal text-white text-[7px] flex items-center justify-center font-bold leading-none">
                  ~
                </span>
              )}
            </div>
          ) : (
            // No swatch resolvable — render a striped pattern so it's
            // visibly NOT a real color. Code/name still appear next to it.
            <div
              className="h-7 w-7 rounded border border-ppp-charcoal-100 shrink-0"
              style={{
                background: "repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 4px, #e5e7eb 4px, #e5e7eb 8px)",
              }}
              aria-hidden
              title="No color preview available — see code"
            />
          )}
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
          className="w-full px-3 py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
      )}

      {open && !pick.colorId && (
        <div className="absolute left-0 right-0 top-full mt-1.5 max-h-64 overflow-y-auto bg-white border border-ppp-charcoal-100 rounded-lg shadow-xl shadow-ppp-charcoal/10 z-50">
          {catalog.status === "loading" && (
            <div className="px-3 py-3 text-xs text-ppp-charcoal-500">Loading color catalog…</div>
          )}
          {catalog.status === "error" && (
            <div className="px-3 py-3 text-xs text-ppp-orange-700">
              Couldn&apos;t load colors: {catalog.message}. Reload the page or reply to PPP for help.
            </div>
          )}
          {catalog.status === "ready" && results.length === 0 && (
            <div className="px-3 py-3 text-xs text-ppp-charcoal-500">
              No matches for &ldquo;{query}&rdquo; — try a different name or code.
            </div>
          )}
          {catalog.status === "ready" && results.map((c) => {
            const rowSwatch = resolveSwatchHex(c.hex, c.name, c.code);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => pickColor(c)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ppp-blue-50/60 transition-colors border-t border-ppp-charcoal-100 first:border-t-0"
              >
                {rowSwatch ? (
                  <div
                    className="h-5 w-5 rounded border border-ppp-charcoal-100 shrink-0 relative"
                    style={{ backgroundColor: rowSwatch.hex }}
                    aria-hidden
                  >
                    {rowSwatch.isApproximate && (
                      <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-ppp-charcoal text-white text-[6px] flex items-center justify-center font-bold leading-none">
                        ~
                      </span>
                    )}
                  </div>
                ) : (
                  <div
                    className="h-5 w-5 rounded border border-ppp-charcoal-100 shrink-0"
                    style={{
                      background: "repeating-linear-gradient(45deg, #f3f4f6, #f3f4f6 3px, #e5e7eb 3px, #e5e7eb 6px)",
                    }}
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-ppp-charcoal truncate">{c.name}</div>
                </div>
                {c.code && (
                  <span className="font-mono text-[10px] text-ppp-charcoal-500 shrink-0">{c.code}</span>
                )}
              </button>
            );
          })}
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
    skipped: false,
  };
}
