"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import MaterialTypePicker from "@/components/material-type-picker";
import SupplierPickList, { type ActiveSupplier } from "@/components/supplier-pick-list";
import {
  formatOrderQuantity,
  formatOrderTotal,
  summarizeOrder,
  addCustomItemsToTotal,
  quantityKey,
  overrideTotal,
  packageForUnit,
  type GallonEstimate,
  type PaintUnit,
} from "@/lib/supplier-order/estimate-gallons";
import { PRIMER_MATERIAL_TYPES, PRIMER_MATERIAL_VALUES, PAINT_LINE_VALUES } from "@/lib/customer-form/material-types";
import { emptyBuildPayload, type OrderBuildPayload } from "@/lib/supplier-order/build-state";

/**
 * ORDER BUILDING — stage one of the Order Materials split (Kate round-3 #18).
 *
 * Everything that decides WHAT TO BUY lives here: the vendor, the paint line,
 * quantities, colour notes, extras and worker-typed colour lines. When the
 * worker advances, the payload is committed to `supplier_order_builds` and the
 * fulfilment page reads it back — it has no way to change any of it.
 *
 * That separation is the fix for a whole class of bugs Kate reported. In the
 * old single modal, every input change re-fetched the draft and the refetch
 * cleared the typed quantities, so adding an extra silently reverted the
 * numbers (#22), a per-colour paint line arrived with "(PPP to confirm
 * quantities)" (#23), and the per-line row and the total disagreed about
 * whether a colour still needed a manual quantity (#26).
 *
 * It is also a real page rather than an overlay, which is what fixes the scroll
 * trap (#21) and the tab-switch data loss (#20 — the work-order page runs a
 * focus-triggered router.refresh() that re-mounted the modal underneath it).
 */

export type SourceLine = {
  id: string;
  room: string;
  surfaces: string[];
  detail: string;
  sqft: number;
};

export type PreviewColor = {
  id: string;
  name: string;
  code: string | null;
  hex: string | null;
  /** Where this colour goes — room + surface, not a generic "Area" (#15). */
  placements: Array<{ room: string; surface: string }>;
};

export type PreviewGroup = {
  supplierName: string;
  supplierAccountId: string | null;
  colors: PreviewColor[];
};

type Draft = {
  gallonEstimates: GallonEstimate[];
  colorNotesDefault: string;
  allowedMaterialTypeValues?: string[];
  noColorsPicked: boolean;
};

type ExtraCatalogItem = {
  id: string;
  name: string;
  unit: string;
  default_qty: number;
  sort_order: number;
};

export default function OrderBuilderView({
  workOrderId,
  workOrderNumber,
  customerName,
  sourceLines,
  initialPayload,
  initialSupplierId,
  persistenceAvailable,
}: {
  workOrderId: string;
  workOrderNumber: string | null;
  customerName: string | null;
  sourceLines: SourceLine[];
  initialPayload: OrderBuildPayload;
  /** Resume straight into a supplier the worker already started building for. */
  initialSupplierId: string | null;
  /** False while migration 144 is pending — the builder still works, it just
   *  can't survive a reload. Said out loud rather than failing quietly. */
  persistenceAvailable: boolean;
}) {
  const router = useRouter();
  const woLabel = workOrderNumber ?? workOrderId.slice(-6);

  const [supplier, setSupplier] = useState<{ accountId: string; name: string } | null>(
    initialSupplierId ? { accountId: initialSupplierId, name: "" } : null
  );
  const [payload, setPayload] = useState<OrderBuildPayload>(initialPayload ?? emptyBuildPayload());
  // The draft is stamped with the supplier it was built FOR. Without that, the
  // moment you switch vendors you keep seeing the previous vendor's colours and
  // quantities until the refetch lands — briefly on a fast connection, visibly
  // on a slow one, and it looks like the vendor change didn't take.
  const [draft, setDraft] = useState<{ forSupplierId: string; data: Draft } | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ExtraCatalogItem[]>([]);
  const [extrasSearch, setExtrasSearch] = useState("");
  const [advancing, setAdvancing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The server accepted the write but isn't keeping it (saved-order table
  // missing). Distinct from an error — nothing failed, it just won't survive,
  // and the next step will read an empty order.
  const [notPersisted, setNotPersisted] = useState(false);
  /** Which vendor the in-memory payload was loaded for. */
  const [loadedFor, setLoadedFor] = useState<string | null>(initialSupplierId);

  /* ── Persist ─────────────────────────────────────────────────────────────
   * Autosave is debounced and fire-and-forget; the commit on "Continue" is
   * awaited, because that one has to land before fulfilment reads it.
   *
   * The payload and supplier are passed IN rather than read from refs — refs
   * written during render are a cascading-render trap, and there's no need for
   * them here: every caller already has the current values in scope.
   */
  const save = useCallback(
    async (
      supplierAccountId: string,
      body: OrderBuildPayload,
      commit: boolean
    ): Promise<{ ok: true; persisted: boolean } | { ok: false; error: string }> => {
      const res = await fetch("/api/admin/supplier-order/build", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId, supplierAccountId, payload: body, commit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        return { ok: false, error: data.message ?? data.error ?? `HTTP ${res.status}` };
      }
      // The route answers 200 with persistence:"unavailable" when the table
      // isn't there — an honest "I took it but didn't keep it". Trusting the
      // page-load flag alone would keep reporting "Order saved" if saving
      // stopped working mid-session. Believe the response, not the page load.
      return { ok: true, persisted: data.persistence !== "unavailable" };
    },
    [workOrderId]
  );

  // Debounced autosave. Skipped until a supplier is chosen (the row is keyed by
  // work order + supplier).
  useEffect(() => {
    if (!supplier) return;
    // Don't write until the payload in memory is THIS vendor's.
    if (loadedFor !== supplier.accountId) return;
    const accountId = supplier.accountId;
    const snapshot = payload;
    const t = setTimeout(() => {
      void save(accountId, snapshot, false).then((r) => {
        if (!r.ok) { setSaveError(r.error); setNotPersisted(false); return; }
        setSaveError(null);
        setNotPersisted(!r.persisted);
      });
    }, 600);
    return () => clearTimeout(t);
  }, [payload, supplier, save, loadedFor]);

  /* ── Load the saved order for THIS vendor ───────────────────────────────
   * Without this, switching vendors carried the previous vendor's payload:
   * the autosave (keyed on work order + supplier) immediately wrote Sherwin's
   * quantities, extras and custom lines onto the Benjamin Moore row, and the
   * BM order was never loaded at all. On a two-vendor job the tape got ordered
   * twice and one vendor's order silently became the other's.
   *
   * `loadedFor` tracks which vendor the in-memory payload belongs to, so the
   * autosave below can't fire with a mismatched pair.
   */
  useEffect(() => {
    if (!supplier) return;
    if (loadedFor === supplier.accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/supplier-order/build?workOrderId=${encodeURIComponent(workOrderId)}` +
            `&supplierAccountId=${encodeURIComponent(supplier.accountId)}`
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.ok !== false && data.payload) {
          setPayload({
            ...(data.payload as OrderBuildPayload),
            // Keep the work order's paint line as the fallback for a vendor
            // that has no saved order yet (#24).
            mainMaterialType:
              (data.payload as OrderBuildPayload).mainMaterialType || initialPayload.mainMaterialType || "",
          });
        }
      } catch (err) {
        console.warn("[order-builder] couldn't load this vendor's saved order:", err);
      } finally {
        if (!cancelled) setLoadedFor(supplier.accountId);
      }
    })();
    return () => { cancelled = true; };
  }, [supplier, workOrderId, loadedFor, initialPayload.mainMaterialType]);

  // Resume: we know the vendor's id but not its name until the list loads.
  useEffect(() => {
    if (!supplier || supplier.name) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/suppliers/active");
        const data = await res.json();
        if (cancelled || !res.ok || !data.ok) return;
        const hit = (data.suppliers ?? []).find(
          (x: ActiveSupplier) => x.accountId === supplier.accountId
        );
        if (hit) setSupplier({ accountId: hit.accountId, name: hit.name });
      } catch {
        /* leave the placeholder — not worth failing the page over */
      }
    })();
    return () => { cancelled = true; };
  }, [supplier]);

  /* ── Extras catalogue ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!supplier) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/supplier-order/extras?supplierAccountId=${encodeURIComponent(supplier.accountId)}`
        );
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.extras)) setCatalog(data.extras);
      } catch (err) {
        console.warn("[order-builder] extras fetch failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [supplier]);

  /* ── Draft (the estimate + what-to-buy list) ────────────────────────────
   * Re-fetched when the inputs that change the ORDER change. Crucially the
   * response is now rendered directly: the server applies the worker's
   * quantities, so `draft.gallonEstimates` is the single source of truth for
   * both the rows and the total. Nothing local re-folds them (#26).
   */
  useEffect(() => {
    // No synchronous setDraft(null) here — clearing state in an effect body
    // cascades a render. `estimates` below reads through `supplier` instead, so
    // a stale draft can't leak into the UI after the vendor is changed.
    if (!supplier) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoadingDraft(true);
      setDraftError(null);
      try {
        const res = await fetch("/api/admin/supplier-order/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderId,
            supplierAccountId: supplier.accountId,
            manualSupplier: true,
            fulfillmentMethod: "delivery",
            extras: payload.extras,
            materialType: payload.mainMaterialType || undefined,
            materialTypeOverrides:
              Object.keys(payload.materialTypeOverrides).length > 0 ? payload.materialTypeOverrides : undefined,
            quantityOverrides:
              Object.keys(payload.quantities).length > 0 ? payload.quantities : undefined,
            customColorItems: payload.customColorItems,
            colorNotes: payload.colorNotes ?? undefined,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setDraftError(data.message ?? data.error ?? `HTTP ${res.status}`);
          setDraft(null);
        } else {
          setDraft({ forSupplierId: supplier.accountId, data: data.draft as Draft });
        }
      } catch (err) {
        if (!cancelled) {
          setDraftError(err instanceof Error ? err.message : String(err));
          setDraft(null);
        }
      } finally {
        if (!cancelled) setLoadingDraft(false);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [
    workOrderId,
    supplier,
    payload.extras,
    payload.mainMaterialType,
    payload.materialTypeOverrides,
    payload.quantities,
    payload.customColorItems,
    payload.colorNotes,
  ]);

  // Only ever the draft built for the CURRENTLY selected vendor.
  const currentDraft = supplier && draft?.forSupplierId === supplier.accountId ? draft.data : null;
  const estimates = currentDraft?.gallonEstimates ?? [];

  /* ── Paint-line options ────────────────────────────────────────────────── */
  const lineMaterialValues = useMemo<ReadonlySet<string>>(() => {
    // Falls back to the LINE vocabulary, not the full allowlist — the allowlist
    // also carries legacy line+finish values for back-compat, and those must
    // never be offered as a fresh choice (Kate round-3 #09).
    const base = (currentDraft?.allowedMaterialTypeValues ?? []).length
      ? currentDraft!.allowedMaterialTypeValues!
      : [...PAINT_LINE_VALUES];
    // Primers are Extras, never a topcoat line (Kate round-2 #22 / round-3 #08).
    return new Set(base.filter((v) => !PRIMER_MATERIAL_VALUES.has(v)));
  }, [currentDraft]);

  /* ── Mutators ──────────────────────────────────────────────────────────── */
  const patch = (p: Partial<OrderBuildPayload>) => setPayload((cur) => ({ ...cur, ...p }));

  const adjustQuantity = (e: GallonEstimate, delta: number) => {
    const key = quantityKey(e.colorId, e.finish);
    setPayload((cur) => {
      const existing = cur.quantities[key];
      const unit: PaintUnit = existing?.unit ?? e.unit ?? "gal";
      const currentTotal = existing
        ? overrideTotal(existing)
        : (e.manualOnly ? 0 : overrideTotal({ buckets: e.buckets, cans: e.cans, unit }));
      const next = Math.max(0, Math.min(99, currentTotal + delta));
      return { ...cur, quantities: { ...cur.quantities, [key]: packageForUnit(next, unit) } };
    });
  };

  const setUnit = (e: GallonEstimate, unit: PaintUnit) => {
    const key = quantityKey(e.colorId, e.finish);
    setPayload((cur) => {
      const existing = cur.quantities[key];
      const total = existing
        ? overrideTotal(existing)
        : (e.manualOnly ? 0 : overrideTotal({ buckets: e.buckets, cans: e.cans, unit: e.unit ?? "gal" }));
      return { ...cur, quantities: { ...cur.quantities, [key]: packageForUnit(total, unit) } };
    });
  };

  const resetQuantity = (e: GallonEstimate) => {
    const key = quantityKey(e.colorId, e.finish);
    setPayload((cur) => {
      const next = { ...cur.quantities };
      delete next[key];
      return { ...cur, quantities: next };
    });
  };

  const setLineFor = (e: GallonEstimate, value: string) => {
    const key = quantityKey(e.colorId, e.finish);
    setPayload((cur) => {
      const next = { ...cur.materialTypeOverrides };
      if (!value) delete next[key];
      else next[key] = value;
      return { ...cur, materialTypeOverrides: next };
    });
  };

  const toggleExtra = (item: { id: string; name: string; unit: string; default_qty: number }) => {
    setPayload((cur) => {
      const has = cur.extras.some((e) => e.extraId === item.id);
      return {
        ...cur,
        extras: has
          ? cur.extras.filter((e) => e.extraId !== item.id)
          : [...cur.extras, { extraId: item.id, name: item.name, unit: item.unit, qty: item.default_qty }],
      };
    });
  };

  const setExtraQty = (extraId: string, qty: number) => {
    setPayload((cur) => ({
      ...cur,
      extras: cur.extras.map((e) =>
        e.extraId === extraId ? { ...e, qty: Math.max(1, Math.min(99, Math.floor(qty || 1))) } : e
      ),
    }));
  };

  const removeExtra = (extraId: string) =>
    setPayload((cur) => ({ ...cur, extras: cur.extras.filter((e) => e.extraId !== extraId) }));

  const togglePrimer = (value: string) => {
    const id = `primer-${value.toLowerCase().replace(/\s+/g, "-")}`;
    toggleExtra({ id, name: value, unit: "gal", default_qty: 1 });
  };

  /* ── Advance ───────────────────────────────────────────────────────────── */
  const handleAdvance = async () => {
    if (!supplier || advancing) return;
    setAdvancing(true);
    setSaveError(null);
    const r = await save(supplier.accountId, payload, true);
    if (!r.ok) {
      setSaveError(r.error);
      setAdvancing(false);
      return;
    }
    setNotPersisted(!r.persisted);
    router.push(
      `/dashboard/materials/${encodeURIComponent(workOrderId)}/order/${encodeURIComponent(supplier.accountId)}`
    );
  };

  const selectedExtras = payload.extras;
  const filteredCatalog = useMemo(() => {
    const q = extrasSearch.trim().toLowerCase();
    return q ? catalog.filter((c) => c.name.toLowerCase().includes(q)) : catalog;
  }, [catalog, extrasSearch]);

  // Matches the vendor email exactly — custom colour lines included (#28).
  const totals = addCustomItemsToTotal(summarizeOrder(estimates), payload.customColorItems);
  // A line still needs a human number when the estimator couldn't size it AND
  // the worker hasn't typed one. Because the server already folded the typed
  // quantities in, this is simply "what's left" — no second calculation to
  // disagree with the rows (#26).
  const needQty = estimates.filter(
    // A colour the worker zeroed out on purpose is answered, not outstanding.
    (e) => !e.excluded && (e.manualOnly || (e.buckets === 0 && e.cans === 0))
  );

  return (
    <div className="space-y-5 pb-4">
      {/* Header */}
      <div>
        <Link
          href={`/dashboard/materials/${encodeURIComponent(workOrderId)}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline"
        >
          <span aria-hidden>←</span> Back to work order
        </Link>
        <h1 className="mt-2 text-xl sm:text-2xl font-condensed font-bold text-ppp-navy">
          Build the order
        </h1>
        <p className="text-xs text-ppp-charcoal-500 mt-1">
          {customerName ?? "(unknown customer)"} · WO {woLabel} · Step 1 of 2 — decide what to buy, then continue to fulfilment.
        </p>
        {!persistenceAvailable && (
          <p className="mt-2 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
            Saved order state isn&apos;t switched on yet, so this order won&apos;t survive a page reload.
            Everything else works — finish the order in one go, or ask Karan to apply migration 144.
          </p>
        )}
      </div>

      {/* ── Step 1: vendor. Inline pick list, not a pop-up (#18/#21). ─────── */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-ppp-charcoal">Vendor</h2>
            <p className="text-[11px] text-ppp-charcoal-500">Who this order goes to.</p>
          </div>
          {supplier && (
            <button
              type="button"
              onClick={() => setSupplier(null)}
              className="text-xs font-medium text-ppp-blue-700 hover:underline px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
            >
              Change vendor
            </button>
          )}
        </div>
        {supplier ? (
          <div className="px-4 py-3 flex items-center gap-2 text-sm">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ppp-green-50 text-ppp-green-700 text-xs font-bold" aria-hidden>✓</span>
            {/* On a resumed order the name isn't known until the supplier list
                loads — say "Loading…" rather than "Selected vendor", which read
                as a real state and left the only way to identify the store as
                "Change vendor", i.e. discarding the order to find out what it
                was for. */}
            <span className="font-semibold text-ppp-charcoal">{supplier.name || "Loading vendor…"}</span>
          </div>
        ) : (
          <SupplierPickList
            onPick={(s: ActiveSupplier) => setSupplier({ accountId: s.accountId, name: s.name })}
          />
        )}
      </section>

      {!supplier && (
        <p className="text-xs text-ppp-charcoal-500 italic px-1">
          Pick a vendor to start building the order.
        </p>
      )}

      {supplier && (
        <>
          {/* ── Paint line (moved here from the order page — #17/#18) ─────── */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ppp-charcoal">Default paint product line</h2>
                <p className="text-[11px] text-ppp-charcoal-500">
                  Applies to every color — override per color below if the job mixes lines.
                </p>
              </div>
              <div className="w-full sm:w-auto sm:ml-auto max-w-[260px]">
                <MaterialTypePicker
                  id="main-material-type"
                  value={payload.mainMaterialType}
                  onChange={(v) => patch({ mainMaterialType: v })}
                  placeholder="— pick a paint line —"
                  allowClear
                  availableValues={lineMaterialValues}
                />
              </div>
            </div>
            {!payload.mainMaterialType && (
              <p className="mt-2 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
                ⚠ Paint line not set — pick one here.
              </p>
            )}
          </section>

          {/* ── Manual-quantity banner (#06 grammar, #19 wording) ─────────── */}
          {needQty.length > 0 && (
            <div
              role="alert"
              className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2.5 text-xs text-ppp-orange-700 flex items-start gap-2"
            >
              <span aria-hidden>⚠</span>
              <span>
                <strong>Manual quantity required</strong> —{" "}
                {needQty.length === 1 ? "1 color has" : `${needQty.length} colors have`} no
                measurements in Salesforce. Update the gallons using the +/- buttons below.
              </span>
            </div>
          )}

          {/* ── Order — what to buy ───────────────────────────────────────── */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-ppp-charcoal">Order — what to buy</h2>
              {(totals.buckets > 0 || totals.cans > 0 || totals.quarts > 0) && (
                <span className="text-[11px] text-ppp-charcoal-500">
                  Total: <strong className="text-ppp-charcoal">{formatOrderTotal(totals)}</strong>
                  {totals.reviewColors > 0 && (
                    <span className="text-ppp-orange-700"> · {totals.reviewColors} to confirm</span>
                  )}
                </span>
              )}
            </div>

            {loadingDraft && !currentDraft && (
              <div className="px-4 py-6 text-sm text-ppp-charcoal-500 italic">Working out what to buy…</div>
            )}
            {draftError && (
              <div role="alert" className="m-4 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2 text-xs text-ppp-orange-700">
                Couldn&apos;t build the order: {draftError}
              </div>
            )}
            {currentDraft && estimates.length === 0 && (
              <div className="px-4 py-5 text-xs text-ppp-charcoal-500">
                No colors on this work order yet. You can still order extras and custom color items below.
              </div>
            )}

            <ul className="divide-y divide-ppp-charcoal-100">
              {estimates.map((e) => {
                const key = quantityKey(e.colorId, e.finish);
                const override = payload.quantities[key];
                const unit: PaintUnit = override?.unit ?? e.unit ?? "gal";
                const total = overrideTotal({ buckets: e.buckets, cans: e.cans, unit });
                // Two very different zeros. `excluded` is the worker saying
                // "don't buy this one" — a decision, shown neutrally and
                // reversible via "reset to estimate". A placeholder zero is the
                // estimator saying "I couldn't size this" — a gap, shown as a
                // warning. Collapsing them made the deliberate choice look like
                // an unfinished field and still shipped the colour to the vendor.
                const isExcluded = !!e.excluded;
                const isPlaceholder = !isExcluded && (e.manualOnly || (e.buckets === 0 && e.cans === 0));
                return (
                  <li key={key} className="px-4 py-3 text-xs">
                    {/* basis-full sm:basis-auto makes the name take its own row
                        on a phone. flex-wrap alone never fired here: flex-1 is
                        `flex: 1 1 0%`, so the name's hypothetical size is 0 and
                        the browser keeps both children on one line, handing the
                        name whatever the shrink-0 button cluster leaves — which
                        at 320px is nothing, and the parent's overflow-hidden
                        then clipped the "+" button off the card. */}
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 break-words">
                        <div>
                          <span className="font-medium text-ppp-charcoal">{e.colorName}</span>
                          {e.colorCode && <span className="text-ppp-charcoal-400 ml-1">{e.colorCode}</span>}
                          {e.finish && <span className="text-ppp-charcoal-500"> · {e.finish}</span>}
                        </div>
                        {/* Kate round-3 #25: room(s) AND surface, so a colour used
                            in two rooms can't collapse into one nameless line. */}
                        {/* R4.19: all the rooms then all the surfaces in one
                            run made it impossible to tell which surface went
                            with which room. Grouped by surface instead:
                            "Walls — Kitchen, Bathroom · Ceiling — Kitchen". */}
                        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                          {e.placements && e.placements.length > 0 ? (
                            <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
                              {e.placements.map((pl, i) => (
                                <span key={pl.surface}>
                                  {/* The divider Kate's spec shows. Without it,
                                      "Walls — Kitchen Ceiling — Kitchen" runs
                                      together and the second surface reads as
                                      another room. */}
                                  {i > 0 && <span aria-hidden className="text-ppp-charcoal-300 mr-1.5">|</span>}
                                  <span className="text-ppp-charcoal-600 font-medium">{pl.surface}</span>
                                  <span className="text-ppp-charcoal-400"> — {pl.rooms.join(", ")}</span>
                                </span>
                              ))}
                            </span>
                          ) : e.rooms.length > 0 ? (
                            e.rooms.join(", ")
                          ) : (
                            "Room not named in Salesforce"
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label={`Decrease ${e.colorName}`}
                          disabled={total <= 0}
                          onClick={() => adjustQuantity(e, -1)}
                          className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:bg-ppp-charcoal-100 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-xl sm:text-base leading-none touch-manipulation"
                        >
                          −
                        </button>
                        <span
                          className={`font-semibold min-w-[5rem] sm:min-w-[6rem] text-right ${
                            isPlaceholder
                              ? "text-ppp-orange-700"
                              : isExcluded
                                ? "text-ppp-charcoal-400 italic font-normal"
                                : "text-ppp-charcoal"
                          }`}
                        >
                          {isPlaceholder ? "⚠️ set qty" : formatOrderQuantity(e)}
                        </span>
                        <button
                          type="button"
                          aria-label={`Increase ${e.colorName}`}
                          disabled={total >= 99}
                          onClick={() => adjustQuantity(e, +1)}
                          className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:bg-ppp-charcoal-100 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-xl sm:text-base leading-none touch-manipulation"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 flex items-center justify-end gap-3 flex-wrap">
                      {/* Kate round-3 #27: gallons or quarts, per line. */}
                      <div className="inline-flex rounded-lg border border-ppp-charcoal-100 overflow-hidden" role="group" aria-label={`Unit for ${e.colorName}`}>
                        {(["gal", "qt"] as PaintUnit[]).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setUnit(e, u)}
                            aria-pressed={unit === u}
                            className={`px-3 py-1 text-[11px] font-medium min-h-[44px] sm:min-h-[32px] touch-manipulation transition-colors ${
                              unit === u
                                ? "bg-ppp-blue-600 text-white"
                                : "bg-white text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                            }`}
                          >
                            {u === "gal" ? "Gallon" : "Quart"}
                          </button>
                        ))}
                      </div>
                      {override && (
                        <button
                          type="button"
                          onClick={() => resetQuantity(e)}
                          className="text-[10px] text-ppp-blue-700 hover:underline px-1 py-1"
                        >
                          reset to estimate
                        </button>
                      )}
                      <div className="flex items-center gap-1.5">
                        <label className="text-[10px] text-ppp-charcoal-500 shrink-0" htmlFor={`mt-${key}`}>
                          Product line:
                        </label>
                        <div className="max-w-[190px]">
                          <MaterialTypePicker
                            id={`mt-${key}`}
                            value={payload.materialTypeOverrides[key] ?? ""}
                            onChange={(v) => setLineFor(e, v)}
                            placeholder="— use default —"
                            compact
                            allowClear
                            availableValues={lineMaterialValues}
                          />
                        </div>
                      </div>
                    </div>

                    {e.needsMeasurement && !isPlaceholder && (
                      <p className="text-[10px] text-ppp-orange-700 mt-1 text-right">
                        ⚠ a room is unmeasured — this may be low
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ── Custom colour item (#28) ──────────────────────────────────── */}
          <CustomColorItems
            items={payload.customColorItems}
            onChange={(customColorItems) => patch({ customColorItems })}
          />

          {/* ── Color Notes (#16) ─────────────────────────────────────────── */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
            <label className="text-sm font-semibold text-ppp-charcoal block mb-1" htmlFor="order-color-notes">
              Color Notes
            </label>
            <p className="text-[11px] text-ppp-charcoal-500 mb-2">
              Colours and finishes for surfaces that don&apos;t map to a standard field, non-BM/SW
              colors, and anything the customer said. For the estimator — this
              does NOT go to the vendor. If something in here needs buying, add
              it as a custom color item above.
            </p>
            <textarea
              id="order-color-notes"
              value={payload.colorNotes ?? currentDraft?.colorNotesDefault ?? ""}
              onChange={(ev) => patch({ colorNotes: ev.target.value })}
              rows={4}
              placeholder="e.g. Deck: Gray Minwax · Not painting: Living Room · Trim"
              className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue resize-y"
            />
          </section>

          {/* ── Extras + primers + custom sundry ──────────────────────────── */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
            <h2 className="text-sm font-semibold text-ppp-charcoal mb-2">
              Extras {selectedExtras.length > 0 && (
                <span className="font-normal text-ppp-charcoal-500">({selectedExtras.length} selected)</span>
              )}
            </h2>

            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-ppp-charcoal-500 mb-1.5">
                Primer <span className="font-normal normal-case text-ppp-charcoal-400">— add if the job needs it</span>
              </div>
              {/* R4.16: quantity lives next to the primer at the point it's
                  added. It used to be settable only once you reached the email,
                  which made it easy to tick a primer, forget, and send the
                  default single gallon for a whole house. Same ± control the
                  sundries list below already uses. */}
              <div className="flex flex-wrap gap-1.5">
                {PRIMER_MATERIAL_TYPES.map((p) => {
                  const id = `primer-${p.value.toLowerCase().replace(/\s+/g, "-")}`;
                  const sel = selectedExtras.find((e) => e.extraId === id);
                  return (
                    <div
                      key={p.value}
                      className={`inline-flex items-center rounded-lg border transition-colors ${
                        sel ? "bg-ppp-blue-50 border-ppp-blue-200" : "bg-white border-ppp-charcoal-200"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => togglePrimer(p.value)}
                        aria-pressed={!!sel}
                        className={`text-[11px] px-2.5 py-1.5 rounded-l-lg min-h-[36px] touch-manipulation transition-colors ${
                          sel ? "text-ppp-blue-800 font-semibold" : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 rounded-r-lg"
                        }`}
                      >
                        {sel ? "✓ " : "+ "}{p.value}
                      </button>
                      {sel && (
                        <span className="flex items-center gap-0.5 pr-1 pl-0.5 border-l border-ppp-blue-200">
                          <button
                            type="button"
                            aria-label={`Decrease ${p.value}`}
                            disabled={sel.qty <= 1}
                            onClick={() => setExtraQty(id, sel.qty - 1)}
                            className="h-9 w-9 sm:h-7 sm:w-7 rounded text-ppp-charcoal hover:bg-white disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
                          >
                            −
                          </button>
                          <span className="font-mono font-semibold text-[11px] min-w-[2.5rem] text-center text-ppp-charcoal">
                            {sel.qty} gal
                          </span>
                          <button
                            type="button"
                            aria-label={`Increase ${p.value}`}
                            disabled={sel.qty >= 99}
                            onClick={() => setExtraQty(id, sel.qty + 1)}
                            className="h-9 w-9 sm:h-7 sm:w-7 rounded text-ppp-charcoal hover:bg-white disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
                          >
                            +
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <input
              type="search"
              value={extrasSearch}
              onChange={(ev) => setExtrasSearch(ev.target.value)}
              placeholder="Search tape / caulk / rollers / …"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue mb-3"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-64 overflow-y-auto">
              {filteredCatalog.map((c) => {
                const sel = selectedExtras.find((e) => e.extraId === c.id);
                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs transition-colors ${
                      sel ? "bg-ppp-blue-50 border-ppp-blue-100" : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                      <input type="checkbox" checked={!!sel} onChange={() => toggleExtra(c)} className="shrink-0" />
                      <span className="flex-1 truncate">{c.name}</span>
                    </label>
                    {sel ? (
                      <div className="shrink-0 flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Decrease ${c.name}`}
                          disabled={sel.qty <= 1}
                          onClick={() => setExtraQty(c.id, sel.qty - 1)}
                          className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-blue-100 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
                        >
                          −
                        </button>
                        <span className="font-mono font-semibold text-xs min-w-[2.5rem] text-center text-ppp-charcoal">
                          {sel.qty}
                        </span>
                        <button
                          type="button"
                          aria-label={`Increase ${c.name}`}
                          disabled={sel.qty >= 99}
                          onClick={() => setExtraQty(c.id, sel.qty + 1)}
                          className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-blue-100 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-ppp-charcoal-500 shrink-0">
                        ×{c.default_qty} {c.unit}
                      </span>
                    )}
                  </div>
                );
              })}
              {filteredCatalog.length === 0 && (
                <div className="col-span-full text-xs text-ppp-charcoal-500 italic py-3 text-center">No matches.</div>
              )}
            </div>

            {selectedExtras.filter((e) => e.extraId.startsWith("custom-")).length > 0 && (
              <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">
                <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-2">
                  Custom sundry items added
                </div>
                <ul className="space-y-1.5">
                  {selectedExtras
                    .filter((e) => e.extraId.startsWith("custom-"))
                    .map((e) => (
                      <li key={e.extraId} className="flex items-center gap-2 text-xs bg-ppp-blue-50/40 border border-ppp-blue-100 rounded px-2.5 py-2">
                        <span className="flex-1 truncate text-ppp-charcoal">{e.name}</span>
                        <span className="text-[10px] text-ppp-charcoal-500 shrink-0">
                          ×{e.qty} {e.unit !== "each" ? e.unit : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeExtra(e.extraId)}
                          className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-800 px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
                          aria-label={`Remove ${e.name}`}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            <CustomSundryItem
              onAdd={(name, qty, unit) =>
                setPayload((cur) => ({
                  ...cur,
                  extras: [
                    ...cur.extras,
                    {
                      extraId: `custom-${name.toLowerCase().replace(/\s+/g, "-")}-${cur.extras.length}-${name.length}`,
                      name,
                      unit,
                      qty,
                    },
                  ],
                }))
              }
            />
          </section>
        </>
      )}

      {/* Reference panels — Salesforce line items (#14) + the draft preview
          (#15). Rendered OUTSIDE the vendor gate on purpose: the work-order
          page's "Preview Materials Order" button links to #preview, and while
          this lived inside {supplier && …} that anchor simply didn't exist in
          the DOM until a vendor was picked — the link scrolled nowhere and
          dropped the user on a vendor picker instead. Looking at the colours
          is a read-only act; it shouldn't require choosing a store first. */}
          {/* R4.17: the "Supplier → color → where it goes" panel was removed —
              it restated the buy-list above with a different grouping, and the
              two disagreed whenever the buy-list changed. */}
          <section id="preview" className="scroll-mt-4">
            {/* R4.18: collapsed by default. This is reference data an estimator
                opens to check a number, not something they read on every order —
                expanded it pushed the actual buy-list off the first screen. */}
            <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden group">
              <summary className="px-4 py-2.5 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] cursor-pointer list-none flex items-center justify-between gap-2 min-h-[44px] touch-manipulation">
                <span>
                  <span className="block text-[10px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
                    Source data (Salesforce)
                  </span>
                  <span className="block text-sm font-semibold text-ppp-charcoal">
                    Line items on this WO
                    <span className="ml-1.5 font-normal text-ppp-charcoal-500">({sourceLines.length})</span>
                  </span>
                </span>
                <span aria-hidden className="shrink-0 text-ppp-charcoal-400 transition-transform group-open:rotate-180">▾</span>
              </summary>
              <ul className="divide-y divide-ppp-charcoal-100">
                {sourceLines.map((l) => (
                  <li key={l.id} className="px-4 py-2.5 text-xs">
                    {/* Kate round-3 #14: room AND surface identify the line. */}
                    <div className="font-semibold text-ppp-charcoal">{l.room}</div>
                    {l.surfaces.length > 0 && (
                      <div className="text-[11px] text-ppp-blue-700 mt-0.5">{l.surfaces.join(" · ")}</div>
                    )}
                    <div className="text-ppp-charcoal-500 mt-0.5">
                      {l.detail}
                      {l.sqft > 0 ? `${l.detail ? " · " : ""}${l.sqft.toLocaleString()} sq ft` : ""}
                    </div>
                  </li>
                ))}
                {sourceLines.length === 0 && (
                  <li className="px-4 py-4 text-xs text-ppp-charcoal-500 italic">No line items on this work order.</li>
                )}
              </ul>
            </details>

          </section>

      {/* Sticky advance bar */}
      {supplier && (
        <div
          // STICKY, not fixed. The desktop sidebar is a normal flex child of the
          // shell, so a viewport-width fixed bar sits on top of it. Sticky keeps
          // the bar pinned to the bottom of the scroll area while staying inside
          // the content column, which is right on both desktop and mobile.
          className="sticky bottom-0 z-30 -mx-4 sm:-mx-6 lg:-mx-8 bg-white border-t border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[11px] text-ppp-charcoal-500 min-w-0">
              {saveError ? (
                <span className="text-ppp-orange-700">Couldn&apos;t save: {saveError}</span>
              ) : notPersisted ? (
                <span className="text-ppp-orange-700">
                  Not being saved — quantities and extras won&apos;t reach the next step. Finish in one go, or ask Karan to apply migration 144.
                </span>
              ) : needQty.length > 0 ? (
                <span className="text-ppp-orange-700">
                  {needQty.length === 1 ? "1 color still needs" : `${needQty.length} colors still need`} a quantity — you can set them on the next step too.
                </span>
              ) : (
                <>Order saved. Fulfilment is next: required-by date, delivery or pickup, and the email.</>
              )}
            </div>
            <button
              type="button"
              onClick={handleAdvance}
              disabled={advancing}
              className="px-4 py-2 min-h-[44px] rounded-lg bg-ppp-green-600 text-white text-sm font-semibold hover:bg-ppp-green-700 transition-colors disabled:opacity-60 shadow-sm shadow-ppp-green/30 touch-manipulation"
            >
              {advancing ? "Saving…" : "Continue to fulfilment →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Kate round-3 #28 — the COLOUR half of "Add custom item".
 *
 * Deliberately one free-text field rather than a colour picker plus a finish
 * dropdown: it has to cover stain, venetian plaster and specialty coatings as
 * well as paint, and Kate asked for the prompt to live in the field itself.
 * Sits between the buy-list and Color Notes so someone reading down the notes
 * can add a line as they go.
 */
function CustomColorItems({
  items,
  onChange,
}: {
  items: Array<{ id: string; label: string; qty: number; unit: string }>;
  onChange: (items: Array<{ id: string; label: string; qty: number; unit: string }>) => void;
}) {
  const [label, setLabel] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState<PaintUnit>("gal");

  const add = () => {
    const l = label.trim();
    if (!l) return;
    onChange([
      ...items,
      { id: `cc-${items.length}-${l.length}-${l.slice(0, 8).toLowerCase().replace(/\s+/g, "-")}`, label: l, qty: Math.max(1, Math.floor(Number(qty) || 1)), unit },
    ]);
    setLabel("");
    setQty("1");
    setUnit("gal");
  };

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
      <h2 className="text-sm font-semibold text-ppp-charcoal">Add a custom color item</h2>
      <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 mb-2">
        Anything that isn&apos;t in the catalog — stain, venetian plaster, a color match. It goes on
        the order as a real line.
      </p>

      {items.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2 text-xs bg-ppp-green-50/50 border border-ppp-green-100 rounded px-2.5 py-2">
              <span className="flex-1 min-w-0 truncate text-ppp-charcoal">{it.label}</span>
              <span className="text-[10px] text-ppp-charcoal-500 shrink-0">×{it.qty} {it.unit}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-800 px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
                aria-label={`Remove ${it.label}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
          }}
          placeholder="Color and finish — e.g. Color Match: Behr 56, eggshell"
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
        <div className="flex gap-2 shrink-0">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Quantity"
            className="w-16 px-2 py-2.5 sm:py-2 text-base sm:text-sm text-right border border-ppp-charcoal-100 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as PaintUnit)}
            aria-label="Unit"
            className="px-2 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
          >
            <option value="gal">gal</option>
            <option value="qt">qt</option>
          </select>
          <button
            type="button"
            onClick={add}
            disabled={!label.trim()}
            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

/** The sundry half of "Add custom item" — unchanged behaviour, now clearly
 *  labelled as sundries so it reads as the pair to the colour item above. */
function CustomSundryItem({ onAdd }: { onAdd: (name: string, qty: number, unit: string) => void }) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("each");

  const add = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(n, Math.max(1, Math.floor(Number(qty) || 1)), unit.trim() || "each");
    setName("");
    setQty("1");
    setUnit("each");
  };

  return (
    <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">
      <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-2">
        Add a custom sundry item (not in catalog)
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); add(); }
          }}
          placeholder="e.g. 2 in cut brush"
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
        <div className="flex gap-2 shrink-0">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Quantity"
            className="w-16 px-2 py-2.5 sm:py-2 text-base sm:text-sm text-right border border-ppp-charcoal-100 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
          />
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            aria-label="Unit"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-20 px-2 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
          />
          <button
            type="button"
            onClick={add}
            disabled={!name.trim()}
            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
