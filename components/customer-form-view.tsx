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

/** Prior submission shape (subset of submitted_payload) used to pre-fill the
 *  form when a customer is re-editing before the cutoff (Katie 2026-05-29). */
type PriorSurface = {
  surface: string;
  colorId: string | null;
  colorName: string | null;
  colorCode: string | null;
  finish: string | null;
  skipped?: boolean;
};
type PriorLineItem = { id: string; surfaces?: PriorSurface[]; notes?: string };
type PriorSubmission = { lineItems?: PriorLineItem[]; globalNotes?: string } | null;

type Props = {
  token: string;
  customerName: string | null;
  formData: FormRenderData;
  /** Editable customer-facing copy from lib/customer-form/templates.ts.
   *  Code defaults applied at the server side, so this is always populated. */
  copy: FormCopy;
  /** True when the customer is revising a prior submission (before the cutoff). */
  isEditing?: boolean;
  /** Prior picks to seed the form with when re-editing. */
  priorSubmission?: PriorSubmission;
  /** True when the token is a kind="preview" admin link. Form looks
   *  identical but renders a yellow banner + submit returns a no-op
   *  thank-you so admin can click through the whole flow without touching
   *  Salesforce or marking the token as submitted. */
  isPreview?: boolean;
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

// Katie 2026-06-03: Flat and Matte split into separate options — they are
// technically different sheens across different paint products (e.g. BM
// Ultra Spec ships them as distinct SKUs), and conflating them caused vendor
// confusion on the supplier email ("which one do I mix?"). Order matters —
// listed flattest-to-glossiest so customers can scan.
const FINISH_OPTIONS = [
  "Flat",
  "Matte",
  "Eggshell",
  "Satin",
  "Semi-Gloss",
  "Gloss",
  "High-Gloss",
];

// Material Type picklist mirrored from WorkOrder.MaterialType__c in the live
// PPP Salesforce org (queried 2026-06-03 via answer-katies-questions.ts).
// Customer picks which paint product line to mix their chosen colors in.
// Grouped visually so a customer can scan Benjamin Moore options vs Sherwin
// Williams vs Other without picking the wrong family.
const MATERIAL_TYPE_GROUPS: Array<{ label: string; options: string[] }> = [
  {
    label: "Benjamin Moore — Interior",
    options: ["Ultra Spec Interior", "Regal Select Interior", "Aura Interior"],
  },
  {
    label: "Benjamin Moore — Exterior",
    options: ["Ultra Spec Exterior", "Regal Select Exterior", "Aura Exterior"],
  },
  {
    label: "Sherwin Williams",
    options: ["SW Emerald", "SW Duration", "SW Super Paint"],
  },
  {
    label: "Other",
    options: ["Other"],
  },
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
  if (s.includes("ceiling")) return "Flat";
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

/** Format the editable-window deadline as a concrete date for the customer.
 *  Returns "Friday, June 6 at 8:00 AM" style — long enough that they don't
 *  misread "6/6" as today vs. days from now. Falls back to null when the
 *  scheduled start isn't set yet (admin will follow up). Renders in the
 *  US/Eastern timezone (PPP HQ is on Long Island; safer than the customer's
 *  TZ which we don't know). Katie 2026-06-04: agent flagged that "24 hours
 *  prior to start" copy without a concrete date leaves customers guessing. */
function formatEditDeadline(scheduledStart: string | null): string | null {
  if (!scheduledStart) return null;
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime())) return null;
  // 24h before — same anchor lib/customer-form/expiry.ts uses for the token.
  const deadline = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  if (deadline.getTime() <= Date.now()) {
    // Deadline already past — admin sent the form late; the link is still
    // active until token expiry, but say so honestly rather than display a
    // negative countdown.
    return "in the next few hours (your start date is approaching)";
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(deadline);
  } catch {
    return deadline.toDateString();
  }
}

export default function CustomerFormView({ token, customerName, formData, copy, isEditing = false, priorSubmission = null, isPreview = false }: Props) {
  const editDeadline = formatEditDeadline(formData.scheduledStart);
  // Seed state. When re-editing, pre-fill each surface from the customer's
  // prior submission (colors + finishes + skipped + notes) so they tweak what
  // they already chose rather than starting over. Otherwise start blank.
  const initialState = useMemo<Record<string, LineItemState>>(() => {
    // Index the prior submission by line-item id → surface name for O(1) lookup.
    const priorByLine = new Map<string, Map<string, PriorSurface>>();
    const priorNotesByLine = new Map<string, string>();
    for (const pl of priorSubmission?.lineItems ?? []) {
      const surfMap = new Map<string, PriorSurface>();
      for (const s of pl.surfaces ?? []) surfMap.set(s.surface, s);
      priorByLine.set(pl.id, surfMap);
      if (pl.notes) priorNotesByLine.set(pl.id, pl.notes);
    }

    const state: Record<string, LineItemState> = {};
    for (const li of formData.lineItems) {
      const priorSurfaces = priorByLine.get(li.id);
      state[li.id] = {
        picks: Object.fromEntries(
          li.surfaces.map((s) => {
            const p = priorSurfaces?.get(s);
            if (!p) return [s, emptyPick()];
            return [s, {
              colorId: p.colorId,
              colorName: p.colorName,
              colorCode: p.colorCode,
              colorHex: null, // re-resolved from the catalog by the swatch helper
              finish: p.finish,
              skipped: p.skipped ?? false,
            }];
          })
        ),
        notes: priorNotesByLine.get(li.id) ?? li.existingNotes ?? "",
      };
    }
    return state;
  }, [formData, priorSubmission]);

  const [state, setState] = useState(initialState);
  const [globalNotes, setGlobalNotes] = useState(priorSubmission?.globalNotes ?? "");
  // Material Type (paint product line). Pre-populated from
  // WorkOrder.MaterialType__c if admin set it, else empty so customer picks.
  // Katie 2026-06-03: this dictates which Benjamin Moore / Sherwin-Williams
  // product line we mix the customer's chosen colors in.
  const [materialType, setMaterialType] = useState<string>(formData.materialType ?? "");
  const [submitting, setSubmitting] = useState(false);
  // Ref-based guard — React batches setState so two rapid clicks could
  // both pass `if (submitting) return` before either commits the new value.
  // The ref updates synchronously so a double-click is caught immediately.
  const submitInFlight = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Extra note shown on the thank-you screen — e.g. when a re-edit lands after
  // the materials order already went out.
  const [postSubmitNote, setPostSubmitNote] = useState<string | null>(null);
  // Transient confirmation for "apply color to all areas".
  const [applyToast, setApplyToast] = useState<string | null>(null);
  useEffect(() => {
    if (!applyToast) return;
    const t = setTimeout(() => setApplyToast(null), 3500);
    return () => clearTimeout(t);
  }, [applyToast]);

  // Delivery address is DISPLAY-ONLY (Katie 2026-05-29). It's the address on
  // file in Salesforce; the customer can't edit it here — if it's wrong they
  // contact the team, who fix it in SF (the source of truth the supplier order
  // reads). We still record what they saw in submitted_payload.deliveryAddress.
  const addr = formData.billingAddress;
  const addrCityStateZip = [addr.city, [addr.state, addr.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const hasAddress = !!(addr.street || addrCityStateZip);

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
        <h1 className="text-xl sm:text-2xl font-bold text-ppp-navy">
          {isEditing ? "Your changes are saved!" : copy.thankyouTitle}
        </h1>
        <p className="mt-3 text-sm sm:text-base text-ppp-charcoal-500 max-w-md mx-auto whitespace-pre-line">
          {isEditing
            ? (postSubmitNote
                // Order already went out — don't tell them they can freely adjust
                // again; the orange note below explains they must contact us.
                ? "We've saved your updated color selections."
                : "We've updated your color selections. You can come back and adjust them again any time before your job starts.")
            : copy.thankyouBody}
        </p>
        {postSubmitNote && (
          <p className="mt-4 text-xs sm:text-sm text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2 max-w-md mx-auto">
            {postSubmitNote}
          </p>
        )}
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

  // "Apply this color to all areas" (Katie 2026-05-29). Fills ONLY rooms that
  // (a) have this surface in scope and (b) don't already have a color for it —
  // never overwrites a deliberate pick. Carries the finish along so each filled
  // surface lands complete. Targets are read from the current committed state
  // (closure) so the count + toast are exact, then applied in one setState.
  const applyColorToAll = (sourceLineId: string, surface: string, pick: SurfacePick) => {
    if (!pick.colorId) return;
    const targets = formData.lineItems.filter((li) => {
      if (li.id === sourceLineId) return false;
      if (!li.surfaces.includes(surface)) return false;
      const cur = state[li.id]?.picks[surface];
      return !!cur && !cur.skipped && !cur.colorId;
    });
    if (targets.length === 0) {
      setApplyToast(`Every other room's ${surface.toLowerCase()} is already set or skipped — nothing to fill.`);
      return;
    }
    const finish = pick.finish ?? defaultFinishForSurface(surface);
    const targetIds = new Set(targets.map((li) => li.id));
    setState((prev) => {
      const next = { ...prev };
      for (const id of targetIds) {
        next[id] = {
          ...next[id],
          picks: {
            ...next[id].picks,
            [surface]: {
              ...next[id].picks[surface],
              colorId: pick.colorId,
              colorName: pick.colorName,
              colorCode: pick.colorCode,
              colorHex: pick.colorHex,
              finish,
            },
          },
        };
      }
      return next;
    });
    setApplyToast(`Applied ${pick.colorName ?? "color"} to ${targets.length} more ${targets.length === 1 ? "room" : "rooms"}.`);
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
        // Material Type (paint product line) — sent only when the customer
        // actually picked one. Empty string skips the WO writeback so we
        // don't blank out an admin-set MaterialType__c.
        materialType: materialType.trim() || null,
        renderFetchedAt: formData.fetchedAt,
        // Customer-confirmed delivery address. Persisted to
        // customer_form_tokens.submitted_payload.deliveryAddress; the
        // supplier-order builder reads it in preference to the stale SF
        // Account.BillingAddress. Empty street = customer didn't fill it
        // in, builder will fall back to the SF account address.
        deliveryAddress: {
          name: customerName ?? null,
          street: (addr.street ?? "").trim(),
          city: (addr.city ?? "").trim(),
          state: (addr.state ?? "").trim(),
          postalCode: (addr.postalCode ?? "").trim(),
        },
      };
      const res = await fetch(`/api/customer-form/submit/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        // Prefer the human-readable `message` (drift detection, invalid finish,
        // locked submission, etc. all attach one). Fall back to the error code
        // only when no message exists. Showing "drift_line_item_added" to a
        // customer is opaque; "Our team just added a new room — please reload"
        // is what we actually want them to see.
        const d = data as { error?: string; message?: string };
        throw new Error(d.message || d.error || `Submit failed (${res.status})`);
      }
      if ((data as { orderAlreadyPlaced?: boolean }).orderAlreadyPlaced) {
        setPostSubmitNote(
          "Heads up — your materials order was already placed, so please contact our team to make sure this change makes it onto the order."
        );
      }
      // Preview-mode submit — admin tested the form. Override the celebratory
      // copy so it's obvious nothing actually persisted. The banner during
      // the form already warned, but the thank-you state would otherwise
      // look identical to a real customer submission.
      if ((data as { preview?: boolean }).preview) {
        setPostSubmitNote(
          "Preview submit — nothing was saved to Salesforce or marked as the real customer's submission. Close the tab when you're done testing."
        );
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
        {isEditing && !isPreview && (
          <div className="mt-4 text-xs sm:text-sm text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-3 py-2 leading-relaxed">
            You&apos;ve already submitted these colors — feel free to update anything below
            and save again. {editDeadline
              ? <>You can keep making changes until <strong>{editDeadline}</strong>.</>
              : "You can keep making changes up to 24 hours prior to your start date."}
          </div>
        )}
        {/* Preview-mode banner — admin generated this link to test the form
            without sending an email or creating real submission state. */}
        {isPreview && (
          <div className="mt-4 text-xs sm:text-sm text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-200 rounded-lg px-3 py-2 leading-relaxed">
            <strong>Preview mode.</strong> This link was generated by your PPP team to test the form. Anything you pick here <em>won&apos;t</em> be saved to your real job. To send the live link to the customer, use the &ldquo;Send Color Form&rdquo; button in the Command Center.
          </div>
        )}
        {/* Test-mode banner — writeback mode is "test_only" and this WO isn't
            on the allowlist. Colors saved in CC but won't propagate to SF
            until admin adds the WO id to customer_form_writeback_allowlist. */}
        {!isPreview && formData.writeback.mode === "test_only" && !formData.writeback.isInAllowlist && (
          <div className="mt-4 text-xs sm:text-sm text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg px-3 py-2 leading-relaxed">
            <strong>Saved here only.</strong> Your colors will be recorded in our Command Center, but won&apos;t automatically sync to Salesforce until your project manager enables that for this work order. You don&apos;t need to do anything — just complete the form.
          </div>
        )}
        {!isPreview && formData.writeback.mode === "off" && (
          <div className="mt-4 text-xs sm:text-sm text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg px-3 py-2 leading-relaxed">
            <strong>Saved here only.</strong> Salesforce writeback is currently paused. Your colors are saved in our Command Center and our team will reconcile them with Salesforce manually.
          </div>
        )}
      </div>

      {/* Material Type (paint product line) — one selection that applies to
          every color on this job. Pre-filled from WorkOrder.MaterialType__c
          when admin set it (about half of PPP WOs as of 2026-06-03); the
          customer can change it. Falls back to no default so the customer
          actively confirms which line to use. */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <label htmlFor="paint-product-line" className="block cursor-pointer">
            <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
              Paint Product Line
            </div>
            <h2 className="font-condensed text-base sm:text-lg font-bold text-ppp-navy mt-1">
              Which paint product would you like?
            </h2>
          </label>
          <p className="text-xs text-ppp-charcoal-500 mt-1 leading-relaxed">
            Pick one product line for all the colors below. The same color (e.g. &ldquo;Stardust&rdquo;) can be mixed in different product lines &mdash; each has its own price point and finish quality. If you&apos;re not sure, ask your project manager.
          </p>
          <select
            id="paint-product-line"
            value={materialType}
            onChange={(e) => setMaterialType(e.target.value)}
            className="mt-3 w-full px-3 py-3 sm:py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue bg-white"
          >
            <option value="">— Select product line —</option>
            {MATERIAL_TYPE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </optgroup>
            ))}
          </select>
          {materialType && formData.materialType && materialType !== formData.materialType && (
            <p className="text-[11px] text-ppp-orange-700 mt-2">
              ⓘ You changed this from the original ({formData.materialType}). The new selection will be saved when you submit.
            </p>
          )}
        </div>
      )}

      {/* Color-picking help — Katie 2026-06-05: customers often don't know
          where to start with colors. Surface BM's recommended palettes +
          interactive room visualizer right before the per-room picker so the
          customer has somewhere to research before they start picking. Both
          links open in a new tab (target=_blank + rel=noopener,noreferrer)
          so the customer doesn't lose their place in the form. */}
      {formData.lineItems.length > 0 && (
        <div className="bg-ppp-blue-50/40 border border-ppp-blue-100 rounded-2xl p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="shrink-0 h-9 w-9 rounded-full bg-white border border-ppp-blue-100 flex items-center justify-center text-ppp-blue-700">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-condensed text-base sm:text-lg font-bold text-ppp-navy">
                Need help picking colors?
              </h3>
              <p className="text-xs sm:text-sm text-ppp-charcoal-600 mt-1 leading-relaxed">
                Check out Benjamin Moore&apos;s recommended palettes and their
                interactive room visualizer to see colors before you pick.
              </p>
              <div className="mt-3 flex flex-col sm:flex-row gap-2">
                <a
                  href="https://www.benjaminmoore.com/en-us/color-overview/color-palettes"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 rounded-lg bg-white border border-ppp-blue-200 text-sm font-semibold text-ppp-blue-700 hover:bg-ppp-blue-50 active:bg-ppp-blue-100 transition-colors touch-manipulation"
                >
                  Recommended palettes
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7 17L17 7 M7 7h10v10" />
                  </svg>
                </a>
                <a
                  href="https://www.benjaminmoore.com/en-us/color-overview/find-your-color/color-a-room"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 rounded-lg bg-white border border-ppp-blue-200 text-sm font-semibold text-ppp-blue-700 hover:bg-ppp-blue-50 active:bg-ppp-blue-100 transition-colors touch-manipulation"
                >
                  Visualize on a room
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7 17L17 7 M7 7h10v10" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-line-item sections */}
      {formData.lineItems.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 text-center text-sm text-ppp-charcoal-500">
          {formData.hiddenLineItemCount > 0 ? (
            <>
              <strong className="block text-ppp-orange-700 mb-1">
                All rooms on this job have been removed or completed.
              </strong>
              {formData.hiddenLineItemCount === 1
                ? "1 room was on this work order but it's been marked Canceled or Completed."
                : `${formData.hiddenLineItemCount} rooms were on this work order but they've all been marked Canceled or Completed.`}
              {" "}If you think this is wrong, please reply to the PPP email so they can take a look.
            </>
          ) : (
            <>
              We don&apos;t have any rooms detailed for this work order yet. Please
              reply to the PPP email so they can add the details and resend the form.
            </>
          )}
        </div>
      ) : (
        formData.lineItems.map((li, idx) => (
          <LineItemSection
            key={li.id}
            index={idx + 1}
            lineItem={li}
            state={state[li.id]}
            token={token}
            canApplyToAll={formData.lineItems.length > 1}
            onSurfaceChange={(surface, patch) => updateSurfacePick(li.id, surface, patch)}
            onApplyToAll={(surface, pick) => applyColorToAll(li.id, surface, pick)}
            onNotesChange={(notes) => updateLineNotes(li.id, notes)}
          />
        ))
      )}

      {/* Delivery address — DISPLAY ONLY (Katie 2026-05-29). The address on
          file in Salesforce; not editable here. If it's wrong the customer
          contacts the team, who correct it in SF (the source the supplier
          order reads). */}
      {formData.lineItems.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
            Delivery address
          </div>
          <h2 className="font-condensed text-lg sm:text-xl font-bold text-ppp-navy mt-1">
            Where we&apos;ll deliver the materials
          </h2>
          <div className="mt-3 rounded-lg bg-[var(--color-surface-muted)]/50 border border-ppp-charcoal-100 px-4 py-3">
            {hasAddress ? (
              <div className="text-sm sm:text-base text-ppp-charcoal leading-relaxed">
                {addr.street && <div>{addr.street}</div>}
                {addrCityStateZip && <div>{addrCityStateZip}</div>}
              </div>
            ) : (
              <div className="text-sm text-ppp-charcoal-500 italic">
                We have your address on file with our team.
              </div>
            )}
          </div>
          <p className="mt-3 text-xs sm:text-sm text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2 leading-relaxed">
            If this delivery address is incorrect, please reach out to our team
            right away so we can update it before your materials are ordered —
            it can&apos;t be changed from this form.
          </p>
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
            {isPreview
              ? "Preview only — nothing will be saved when you click. This is to let our team test the form."
              : isEditing
              ? editDeadline
                ? `Save your changes — you can keep updating until ${editDeadline}.`
                : "Save your changes — you can keep updating your colors up to 24 hours prior to your start date."
              : editDeadline
              ? `Once you submit, we'll order the materials. You can still come back and update your colors until ${editDeadline}.`
              : "Once you submit, we'll order the materials. You can still come back and update your colors up to 24 hours prior to your start date."}
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 inline-flex items-center justify-center min-h-[48px] px-6 py-3 rounded-lg bg-ppp-blue text-white text-sm sm:text-base font-semibold hover:bg-ppp-blue-600 transition-colors shadow-md shadow-ppp-blue/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting
              ? "Saving…"
              : isPreview
              ? "Submit (preview only)"
              : isEditing
              ? "Save changes"
              : "Submit my colors"}
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
    {applyToast && (
      <div
        role="status"
        className="fixed inset-x-0 bottom-4 z-50 mx-auto w-fit max-w-[90vw] px-4 py-2.5 rounded-full bg-ppp-navy text-white text-sm font-medium shadow-lg shadow-ppp-navy/30 animate-fade-up"
      >
        {applyToast}
      </div>
    )}
    </CatalogContext.Provider>
  );
}

/* ─── Per-line-item section (one card per room/area) ─── */

function LineItemSection({
  index,
  lineItem,
  state,
  token,
  canApplyToAll,
  onSurfaceChange,
  onApplyToAll,
  onNotesChange,
}: {
  index: number;
  lineItem: FormLineItem;
  state: LineItemState | undefined;
  token: string;
  canApplyToAll: boolean;
  onSurfaceChange: (surface: string, patch: Partial<SurfacePick>) => void;
  onApplyToAll: (surface: string, pick: SurfacePick) => void;
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
            canApplyToAll={canApplyToAll}
            onChange={(patch) => onSurfaceChange(surface, patch)}
            onApplyToAll={() => onApplyToAll(surface, state.picks[surface] ?? emptyPick())}
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
  canApplyToAll,
  onChange,
  onApplyToAll,
}: {
  surface: string;
  pick: SurfacePick;
  token: string;
  canApplyToAll: boolean;
  onChange: (patch: Partial<SurfacePick>) => void;
  onApplyToAll: () => void;
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
        {/* `truncate` + `min-w-0` so long surface labels ("Window Frame Trim
            Exterior") don't push the skip button off-screen at 375px.
            Round 4 mobile audit 2026-06-05. */}
        <div className="font-condensed text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate min-w-0">
          {surface}
        </div>
        {/* Skip toggle — small text button. When skipped, label changes to
            "Add color" so customer can revert. Available always so the
            customer can opt out of any surface they don't want painted.
            Mobile: px-3 py-2 so the tap target hits the ~44px iOS HIG —
            tiny text without padding made this hard to land a finger on. */}
        <button
          type="button"
          onClick={toggleSkip}
          className="text-[11px] text-ppp-charcoal-500 hover:text-ppp-blue underline-offset-2 hover:underline transition-colors sm:hidden px-3 py-2 -my-2 -mr-1"
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
            {/* Apply this color to the same surface in every other room that
                doesn't have one yet (Katie 2026-05-29) — fill-empty-only,
                never overwrites. Only offered with a color picked + >1 room.
                Mobile: py-2 lifts the tap target above the 24px floor. */}
            {pick.colorId && canApplyToAll && (
              <button
                type="button"
                onClick={onApplyToAll}
                className="inline-flex items-center justify-end gap-1 text-[11px] sm:text-[11px] text-ppp-blue hover:text-ppp-blue-700 font-medium text-right self-end px-2 py-2 sm:py-1 -mr-2"
              >
                <span aria-hidden>⮌</span> Apply to all areas
              </button>
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
                  {/* Manufacturer label — Round 3 audit 2026-06-04: customers
                      could pick "White Dove" from SW when their Material Type
                      was Benjamin Moore (BM also has a "White Dove"). Showing
                      the manufacturer disambiguates same-name colors across
                      paint lines + lets the customer verify their pick. */}
                  {c.manufacturerName && (
                    <div className="text-[10px] text-ppp-charcoal-500 truncate">
                      {c.manufacturerName}
                    </div>
                  )}
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
