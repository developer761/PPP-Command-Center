"use client";

/**
 * Customer Color Form — what the homeowner sees at `/select/[token]`.
 *
 * Public-facing, NO auth. Token-gated via `validateToken` server-side
 * before this component ever renders.
 *
 * This is the single-most-touched user-facing surface — every paint job
 * has a customer fill this out. Treat changes here like production code,
 * not internal dashboard tweaks.
 *
 * WHAT IT RENDERS:
 *   1. Project context header (account name, WO number, address)
 *   2. Material Type picker (job-level — "BM Aura interior", etc.)
 *   3. Per-room cards with ColorPicker for each surface (walls / ceiling
 *      / trim / floor / other). Empty rooms render a notes-only path.
 *   4. Delivery address confirmation (last step before submit)
 *   5. Thank-you / re-edit state once submitted
 *
 * DATA INPUTS (all passed as props by `/select/[token]/page.tsx`):
 *   - renderData: FormRenderData — the WO + line items pulled live from
 *     Salesforce by `lib/customer-form/render-data.ts`. NOT cached — the
 *     customer must always see the latest WO state (estimators may be
 *     editing in SF while the customer holds the link).
 *   - Color catalog — fetched ONCE on mount from `/api/customer-form/
 *     colors/all` (24h HTTP cache, ~80KB). Every ColorPicker filters
 *     this in-memory, so per-keystroke filtering is zero-latency.
 *   - Re-edit prior submission — when status === "editable", the form
 *     pre-fills from `submitted_payload` so the customer can revise
 *     their picks before the lock cutoff.
 *
 * SUBMIT FLOW:
 *   POST → /api/customer-form/submit/[token] → drift-check vs latest SF
 *   data → write back to SF (if writeback-mode allows) → notify admin
 *   via Resend → show thank-you. See `app/api/customer-form/submit/`.
 *
 * SUPPORTING FILES (read these together if you're changing this):
 *   - lib/customer-form/render-data.ts     — server-side data prep
 *   - lib/customer-form/material-types.ts  — MT catalog (single source)
 *   - lib/customer-form/color-swatch.ts    — hex resolution per color
 *   - lib/customer-form/tokens.ts          — token lifecycle helpers
 *   - app/select/[token]/page.tsx          — the server-side wrapper
 *
 * For the full customer-form deep-dive (including the preview-token
 * filter, notes-only path, writeback-mode gate, etc.) see
 * `docs/ARCHITECTURE.md` → "Customer color form deep-dive".
 */

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

// Material Type picklist is now sourced from lib/customer-form/material-types
// so the customer picker, the server-side allowlist, and the admin per-
// surface override dropdown all stay in lockstep. Adding a product = one
// entry in that file. Picker is filtered per-WO (interior-only WOs hide
// exterior products and vice versa) — Katie 2026-06-05.
import { filterMaterialTypesForWorkOrder, isInteriorWorkOrder, isExteriorWorkOrder } from "@/lib/customer-form/material-types";
import MaterialTypePicker from "@/components/material-type-picker";

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

type EditDeadline =
  /** No scheduled start known → no concrete deadline to show. */
  | { kind: "unknown" }
  /** Start date is in the past — job has already begun. The 24h cutoff is
   *  long gone; the consumer should NOT use deadline.label inline ("until X")
   *  because the label is a full sentence, not a date. */
  | { kind: "past_start"; label: string }
  /** Inside the last 24h before start. Cutoff is past but the job's still
   *  ahead. Treat like past_start — the label is a phrase, not a date. */
  | { kind: "approaching"; label: string }
  /** Normal case — `label` is a date string like "Friday, June 6 at 8:00 AM
   *  EDT" that's safe to embed in "until {label}" copy. */
  | { kind: "deadline"; label: string };

/** Format the editable-window deadline for the customer. Returns a tagged
 *  variant so callers can render appropriate copy when the start has
 *  already passed (regression caught 2026-06-06: previously the past-start
 *  string was embedded into "you can keep updating until …" producing
 *  nonsensical "until your start date has already arrived" copy).
 *  Katie 2026-06-04: customers shouldn't have to compute "24h before start." */
function formatEditDeadline(scheduledStart: string | null): EditDeadline {
  if (!scheduledStart) return { kind: "unknown" };
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime())) return { kind: "unknown" };
  const now = Date.now();
  if (start.getTime() <= now) {
    return {
      kind: "past_start",
      label: "your start date has already arrived — please reply to PPP if you still need a change",
    };
  }
  const deadline = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  if (deadline.getTime() <= now) {
    return {
      kind: "approaching",
      label: "in the next few hours — your start date is almost here",
    };
  }
  let label: string;
  try {
    label = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(deadline);
  } catch {
    label = deadline.toDateString();
  }
  return { kind: "deadline", label };
}

export default function CustomerFormView({ token, customerName, formData, copy, isEditing = false, priorSubmission = null, isPreview = false }: Props) {
  const editDeadline = formatEditDeadline(formData.scheduledStart);
  // Per-WO filtered Material Type values — exterior-only WOs hide interior
  // products, vice versa. Set form (not grouped) — the MaterialTypePicker
  // component handles its own grouping/collapsing/search internally. Memoized
  // so re-renders don't re-walk the array on every keystroke.
  const materialTypeAvailableValues = useMemo(
    () => {
      const groups = filterMaterialTypesForWorkOrder({
        workTypeName: formData.workTypeName,
        lineItemProductNames: formData.lineItems.map((li) => li.productName),
      });
      const set = new Set<string>();
      for (const g of groups) for (const v of g.options) set.add(v);
      return set;
    },
    [formData.workTypeName, formData.lineItems]
  );

  // Interior/exterior detection for copy + layout decisions. Katie 2026-06-05:
  // exterior WOs rarely have a WOLI breakdown (workers put context only in
  // WO.Description), so we surface those notes prominently + ask the customer
  // for their own notes when no rooms are listed.
  const workContext = useMemo(() => {
    const productNames = formData.lineItems.map((li) => li.productName);
    const hasInterior = isInteriorWorkOrder({ workTypeName: formData.workTypeName, lineItemProductNames: productNames });
    const hasExterior = isExteriorWorkOrder({ workTypeName: formData.workTypeName, lineItemProductNames: productNames });
    return { hasInterior, hasExterior, isMixed: hasInterior && hasExterior };
  }, [formData.workTypeName, formData.lineItems]);
  const sfDescription = (formData.workOrderDescription ?? "").trim();
  const sfSubject = (formData.workOrderSubject ?? "").trim();
  const hasSfNotes = sfDescription.length > 0 || sfSubject.length > 0;
  const hasLineItems = formData.lineItems.length > 0;
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

  // Seed the project-notes textarea. Priority order:
  //   1. Customer's prior submission (re-edit) — their words win, no override.
  //   2. SF Description / Subject — for sparse WOs (no line items) or exterior
  //      jobs where SF has the only project context. We pre-fill the textarea
  //      with PPP's notes so the customer EDITS on top instead of typing the
  //      same context from scratch. Karan 2026-06-09: "use the notes from
  //      sales force to make the template as well."
  //   3. Empty otherwise.
  // The seed is computed once at mount; toggling pickers later doesn't
  // re-seed (avoids losing typed content).
  const initialGlobalNotes = useMemo(() => {
    if (priorSubmission?.globalNotes) return priorSubmission.globalNotes;
    const isSparseOrExterior = !hasLineItems || (workContext.hasExterior && !workContext.hasInterior);
    if (!isSparseOrExterior) return "";
    if (!hasSfNotes) return "";
    const parts: string[] = [];
    if (sfSubject) parts.push(sfSubject);
    if (sfDescription) parts.push(sfDescription);
    parts.push("");
    parts.push("— Add anything else we should know below —");
    return parts.join("\n\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — mount-only
  const [globalNotes, setGlobalNotes] = useState(initialGlobalNotes);
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
  // filters in-memory (zero latency per keystroke). The earlier per-keystroke
  // server call added 200-400ms per character on cell networks, frustrating
  // customers. Catalog is ~5,762 colors, ~80KB gzipped; browser caches it
  // for 24h via the API's Cache-Control.
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
      // Material Type the customer picked wasn't in our current catalog
      // (legacy SF value or stale picklist). Submit saved everything else
      // but skipped the paint-line write. Tell the customer so they know
      // to mention the paint line when they hear from us. Without this
      // they'd see the standard thank-you and assume their paint pick
      // landed in our system. Audit 2026-06-07.
      if ((data as { materialTypeDropped?: boolean }).materialTypeDropped) {
        setPostSubmitNote(
          "We saved your color picks, but the paint product line you selected isn't one we currently order. Please reply to our email with the paint line you'd like so we can make sure it's mixed correctly."
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
            and save again. {
              editDeadline.kind === "deadline"
                ? <>You can keep making changes until <strong>{editDeadline.label}</strong>.</>
                : editDeadline.kind === "approaching"
                ? <><strong>Heads up:</strong> {editDeadline.label}. Save changes now if you need to.</>
                : editDeadline.kind === "past_start"
                ? <><strong>Heads up:</strong> {editDeadline.label}.</>
                : "You can keep making changes up to 24 hours prior to your start date."
            }
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
          <div className="mt-3">
            <MaterialTypePicker
              id="paint-product-line"
              value={materialType}
              onChange={setMaterialType}
              availableValues={materialTypeAvailableValues}
              placeholder="— Select a product line —"
            />
          </div>
          {materialType && formData.materialType && materialType !== formData.materialType && (
            <p className="text-[11px] text-ppp-orange-700 mt-2">
              ⓘ You changed this from the original ({formData.materialType}). Your new selection will be saved when you submit.
            </p>
          )}
          {/* Pre-fill warning — if the WO has a MaterialType already set in SF
              but that value isn't in our current catalog (legacy SF value, or
              the catalog shrank since admin set it), the customer wouldn't
              know to pick something new. Submit would silently drop the
              write and the supplier email would warn "Paint product line not
              specified." Surface it at form mount so the customer picks
              again. Audit 2026-06-07. */}
          {formData.materialType
            && !materialTypeAvailableValues.has(formData.materialType)
            && materialType === formData.materialType && (
            <p className="text-[11px] text-ppp-orange-700 mt-2">
              ⚠ The originally selected paint line (<strong>{formData.materialType}</strong>) is no longer available for this job. Please pick a new product line above so your colors get mixed in the right paint.
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

      {/* Project context from PPP — when there's a Subject or Description on
          the WO, show it prominently. Most useful for exterior jobs where
          the WOLI breakdown is sparse (Katie 2026-06-05: "workers only put
          it into the notes section" for exterior). Customers reading the
          form know what their PPP team has written down for them. */}
      {hasSfNotes && (
        <div className="bg-ppp-blue-50/40 border border-ppp-blue-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
            From your PPP team
          </div>
          <h2 className="font-condensed text-base sm:text-lg font-bold text-ppp-navy mt-1">
            What we have noted for your job
          </h2>
          {sfSubject && (
            <p className="text-sm sm:text-base font-semibold text-ppp-charcoal mt-2 leading-relaxed">
              {sfSubject}
            </p>
          )}
          {sfDescription && (
            <p className="text-xs sm:text-sm text-ppp-charcoal-700 mt-2 leading-relaxed whitespace-pre-wrap">
              {sfDescription}
            </p>
          )}
          <p className="text-[11px] text-ppp-charcoal-500 mt-3 leading-relaxed italic">
            If anything above is wrong or missing, just describe it in the notes section below — we&apos;ll
            sort it out with you before we order materials.
          </p>
        </div>
      )}

      {/* Per-line-item sections */}
      {hasLineItems ? (
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
      ) : formData.hiddenLineItemCount > 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-8 text-center text-sm text-ppp-charcoal-500">
          <strong className="block text-ppp-orange-700 mb-1">
            All rooms on this job have been removed or completed.
          </strong>
          {formData.hiddenLineItemCount === 1
            ? "1 room was on this work order but it's been marked Canceled or Completed."
            : `${formData.hiddenLineItemCount} rooms were on this work order but they've all been marked Canceled or Completed.`}
          {" "}If you think this is wrong, please reply to the PPP email so they can take a look.
        </div>
      ) : (
        // No line items + no hidden items either — typical for exterior jobs
        // OR new WOs where the rep hasn't filled in room breakdowns yet.
        // Instead of telling the customer "reply to PPP and wait for a
        // resend", give them a primary notes textarea to describe what
        // they want. Their notes save into the token payload (admin reads
        // via Mail Hub) so PPP isn't blocked on a back-and-forth email.
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7">
          <div className="text-[10px] sm:text-xs font-condensed uppercase tracking-[0.18em] text-ppp-blue-700 font-bold">
            Tell us about your project
          </div>
          <h2 className="font-condensed text-lg sm:text-xl font-bold text-ppp-navy mt-1">
            {workContext.hasExterior && !workContext.hasInterior
              ? "Describe what you'd like painted on the exterior"
              : workContext.hasInterior && !workContext.hasExterior
              ? "Describe the rooms + colors you'd like"
              : "Describe what you'd like painted + which colors"}
          </h2>
          <p className="text-xs sm:text-sm text-ppp-charcoal-500 mt-2 leading-relaxed">
            {workContext.hasExterior && !workContext.hasInterior
              ? "List the surfaces you want painted (siding, trim, doors, deck, fence, etc.) and the colors / finishes you'd like. The more detail the better — we'll confirm everything with you before ordering paint."
              : "We don't have rooms broken down yet for your job. Give us as much detail as you can — rooms, surfaces (walls / ceiling / trim), colors with names or codes, finish (matte / eggshell / satin / etc.). We'll review and reach out to confirm."}
          </p>
          <textarea
            value={globalNotes}
            onChange={(e) => setGlobalNotes(e.target.value)}
            rows={8}
            placeholder={
              workContext.hasExterior && !workContext.hasInterior
                ? "Example:\n• Siding: Benjamin Moore Hale Navy HC-154, Aura Exterior, satin\n• Trim: Simply White OC-117, semi-gloss\n• Front door: Black HC-190\n• Deck (Woodluxe stain): Cedar"
                : "Example:\n• Living room walls: BM White Dove OC-17, eggshell\n• Living room trim: BM Decorator's White, semi-gloss\n• Bedroom 1: SW Sea Salt SW6204, satin\n• Kitchen ceiling: pure white, flat"
            }
            className="w-full mt-3 px-3 py-3 sm:py-2.5 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y leading-relaxed"
          />
        </div>
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

      {/* Global extra notes — only shown when there ARE line items. When
          there's no breakdown, the primary "tell us about your project"
          notes block above already owns globalNotes; rendering this again
          here would double the textarea. */}
      {hasLineItems && (
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

      {/* Submit — allow submit when there ARE line items OR when the
          customer has typed notes (the notes-only path for sparse
          exterior WOs). */}
      {(hasLineItems || globalNotes.trim().length > 0) && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-7 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-[11px] sm:text-xs text-ppp-charcoal-500">
            {isPreview ? (
              "Preview only — nothing will be saved when you click. This is to let our team test the form."
            ) : isEditing ? (
              editDeadline.kind === "deadline"
                ? `Save your changes — you can keep updating until ${editDeadline.label}.`
                : editDeadline.kind === "approaching"
                ? `Save your changes — ${editDeadline.label}.`
                : editDeadline.kind === "past_start"
                ? `Save your changes — ${editDeadline.label}.`
                : "Save your changes — you can keep updating your colors up to 24 hours prior to your start date."
            ) : (
              editDeadline.kind === "deadline"
                ? `Once you submit, we'll order the materials. You can still come back and update your colors until ${editDeadline.label}.`
                : editDeadline.kind === "approaching"
                ? `Once you submit, we'll order the materials right away — ${editDeadline.label}.`
                : editDeadline.kind === "past_start"
                ? "Once you submit, we'll order the materials right away. Reach out to PPP if anything else needs to change."
                : "Once you submit, we'll order the materials. You can still come back and update your colors up to 24 hours prior to your start date."
            )}
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
        // bottom-[max(1rem,env(safe-area-inset-bottom))] keeps the toast above
        // the iOS home indicator on notched phones; a plain bottom-4 disappears
        // under the gesture bar.
        className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto w-fit max-w-[90vw] px-4 py-2.5 rounded-full bg-ppp-navy text-white text-sm font-medium shadow-lg shadow-ppp-navy/30 animate-fade-up"
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
                Mobile: min-h-[44px] lifts the tap target to iOS HIG. */}
            {pick.colorId && canApplyToAll && (
              <button
                type="button"
                onClick={onApplyToAll}
                className="inline-flex items-center justify-end gap-1 min-h-[44px] sm:min-h-0 text-[11px] text-ppp-blue hover:text-ppp-blue-700 font-medium text-right self-end px-3 py-2 sm:py-1 -mr-1"
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
                className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-left text-sm hover:bg-ppp-blue-50/60 transition-colors border-t border-ppp-charcoal-100 first:border-t-0 touch-manipulation"
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
