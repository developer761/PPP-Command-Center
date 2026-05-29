"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEscClose } from "@/lib/hooks/use-esc-close";
import { formatOrderQuantity, formatBucketsCans, summarizeOrder, type GallonEstimate } from "@/lib/supplier-order/estimate-gallons";

/**
 * Supplier Order Modal — the full draft → review → send experience for one
 * (WO, supplier) order. Opens from the Draft Materials Order modal on the
 * materials page; can also open directly from a per-supplier "Order from X"
 * affordance on each WO card.
 *
 * Flow:
 *   1. Mount → POST /api/admin/supplier-order/draft → render preview
 *   2. Admin tweaks: extras (multi-select), fulfillment method (delivery /
 *      pickup), special instructions, raw email body textarea
 *   3. Re-build draft on extras / fulfillment / instructions changes
 *   4. Send via /api/admin/supplier-order/send → row written to supplier_orders
 *
 * If supplier_settings.order_email isn't configured for this supplier, the
 * Send button is disabled with a hint. Copy-to-Clipboard always works so
 * admin can paste into Gmail manually until Katie sets the supplier emails.
 */

type ExtraCatalogItem = {
  id: string;
  name: string;
  unit: string;
  default_qty: number;
  preferred_supplier_id: string | null;
  sort_order: number;
};

type DeliveryAddress = {
  name: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  source: "customer_form" | "sf_account" | "manual";
};

type SupplierOrderLineItem = {
  surface: string;
  colorId: string;
  colorName: string;
  colorCode: string | null;
  manufacturerName: string | null;
  finish: string | null;
  sqft: number;
  coats: number;
  sourceWoliId: string;
  roomLabel: string;
};

type Draft = {
  poNumber: string;
  subject: string;
  body: string;
  lineItems: SupplierOrderLineItem[];
  gallonEstimates: GallonEstimate[];
  noColorsPicked: boolean;
  unresolvedAddress: boolean;
  deliveryAddress: DeliveryAddress | null;
  requiredByDate: string;
  sentToEmail: string | null;
  pppAccountNumber: string | null;
  pickupLocations: Array<{ name: string; address: string }>;
  skippedSurfaces?: Array<{ roomLabel: string; surface: string }>;
};

type SelectedExtra = {
  extraId: string;
  name: string;
  unit: string;
  qty: number;
};

export default function SupplierOrderModal({
  workOrderId,
  workOrderNumber,
  supplierAccountId,
  supplierName,
  customerName,
  manualSupplier = false,
  onClose,
}: {
  workOrderId: string;
  workOrderNumber: string | null;
  supplierAccountId: string;
  supplierName: string;
  customerName: string | null;
  /** True when the worker chose this supplier via the manual picker (vs an
   *  auto-detected supplier). Tells the draft builder to attribute the WO's
   *  unattributed colors to this supplier instead of dropping them. */
  manualSupplier?: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Worker inputs
  const [fulfillment, setFulfillment] = useState<"delivery" | "pickup">("delivery");
  const [pickupLocation, setPickupLocation] = useState("");
  // Manually-typed delivery address — used when SF has no address on file. Flows
  // into the draft (top-priority candidate) → the email's delivery block, the
  // same way extras + special instructions do.
  const [deliveryAddr, setDeliveryAddr] = useState({ street: "", city: "", state: "", postalCode: "" });
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [extras, setExtras] = useState<Map<string, SelectedExtra>>(new Map());
  const [editedBody, setEditedBody] = useState<string | null>(null); // null = use draft.body unchanged

  // Extras catalog
  const [catalog, setCatalog] = useState<ExtraCatalogItem[]>([]);
  const [extrasSearch, setExtrasSearch] = useState("");

  // Send state
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    | null
    | { ok: true; supplierOrderId: string; poNumber: string; sentToEmail: string }
    | { ok: false; error: string }
  >(null);
  const [copied, setCopied] = useState(false);

  // Esc to close — but NOT while a send is in flight (admin shouldn't be
  // able to accidentally cancel an order mid-Resend-roundtrip).
  useEscClose(onClose, { allowDuring: !sending });

  // Scroll the email body into view as soon as the first draft loads, so
  // admin lands on the most-edited section instead of having to scroll past
  // warnings + fulfillment + extras + special-instructions. Once the body
  // is visible, the user scrolls UP to change settings if needed.
  const emailBodyRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  // Synchronous double-send guard. The `sending` state check alone races:
  // React batches setSending, so two rapid clicks (or Enter+click) can both
  // pass `if (sending) return` before the first commits — firing TWO
  // /supplier-order/send POSTs = a duplicate PO emailed to the vendor. The ref
  // flips synchronously, catching the second call immediately. (Same pattern as
  // the customer-form sends.)
  const sendInFlightRef = useRef(false);

  // Triggered when `draft` becomes available — that's when the email body
  // ref is finally attached to the DOM.

  // Fetch extras catalog ONCE on mount — small (~20 rows) so no pagination.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/supplier-order/extras?supplierAccountId=${encodeURIComponent(supplierAccountId)}`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.extras)) {
          setCatalog(data.extras);
        }
      } catch (err) {
        console.warn("[supplier-order-modal] extras fetch failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [supplierAccountId]);

  // Re-fetch the draft whenever the worker inputs change (extras / fulfillment
  // / pickup / instructions). Debounced lightly so rapid extra toggles don't
  // hammer the API.
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setLoadingDraft(true);
      setDraftError(null);
      try {
        const res = await fetch("/api/admin/supplier-order/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderId,
            supplierAccountId,
            fulfillmentMethod: fulfillment,
            pickupLocation: fulfillment === "pickup" ? pickupLocation : undefined,
            manualDeliveryAddress:
              fulfillment === "delivery" && deliveryAddr.street.trim()
                ? deliveryAddr
                : undefined,
            extras: Array.from(extras.values()),
            specialInstructions: specialInstructions.trim() || undefined,
            manualSupplier,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setDraftError(data.message ?? data.error ?? `HTTP ${res.status}`);
          setDraft(null);
        } else {
          // setDraft alone is enough — the textarea's `editedBody ?? draft.body`
          // fallback means an un-edited textarea (editedBody=null) automatically
          // shows the fresh body with new extras. Previously we ALSO called
          // setEditedBody(null) which destroyed any in-progress manual edits
          // when the user toggled extras — that's what made it feel like
          // "the email doesn't update with my extras." Now manual edits are
          // preserved, and the "Editing manually — extras won't update this
          // body" hint + Reset button lets the user pull in fresh extras
          // when they're ready.
          setDraft(data.draft as Draft);
        }
      } catch (err) {
        if (!cancelled) {
          setDraftError(err instanceof Error ? err.message : String(err));
          setDraft(null);
        }
      } finally {
        if (!cancelled) setLoadingDraft(false);
      }
    }, 120); // Was 250ms — reduced to 120ms so extras-toggle feels snappy.
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [workOrderId, supplierAccountId, fulfillment, pickupLocation, deliveryAddr, extras, specialInstructions, manualSupplier]);

  // Scroll the email body into view on first draft load. Re-builds from
  // extras/fulfillment toggles don't re-scroll (ref guard).
  useEffect(() => {
    if (draft && !didInitialScrollRef.current && emailBodyRef.current) {
      didInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        emailBodyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [draft]);

  const filteredCatalog = useMemo(() => {
    const q = extrasSearch.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((c) => c.name.toLowerCase().includes(q));
  }, [catalog, extrasSearch]);

  const toggleExtra = (item: ExtraCatalogItem) => {
    setExtras((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.set(item.id, {
          extraId: item.id,
          name: item.name,
          unit: item.unit,
          qty: item.default_qty,
        });
      }
      return next;
    });
  };

  const updateExtraQty = (extraId: string, qty: number) => {
    setExtras((prev) => {
      const next = new Map(prev);
      const existing = next.get(extraId);
      if (!existing) return prev;
      next.set(extraId, { ...existing, qty: Math.max(1, Math.floor(qty || 1)) });
      return next;
    });
  };

  const bodyToSend = editedBody ?? draft?.body ?? "";

  const handleCopy = async () => {
    try {
      const subject = draft?.subject ?? "";
      // Include subject as first line so admin can paste into Gmail's compose
      // and easily split it back out.
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${bodyToSend}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      alert(`Couldn't copy: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSend = async () => {
    if (!draft || sending || sendInFlightRef.current) return;
    if (!draft.sentToEmail) return; // Send button should be disabled
    sendInFlightRef.current = true;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/admin/supplier-order/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workOrderId,
          workOrderNumber,
          supplierAccountId,
          supplierName,
          poNumber: draft.poNumber,
          subject: draft.subject,
          body: bodyToSend,
          sentToEmail: draft.sentToEmail,
          fulfillmentMethod: fulfillment,
          deliveryAddress: fulfillment === "delivery" ? draft.deliveryAddress : null,
          pickupLocation: fulfillment === "pickup" ? pickupLocation : null,
          requiredByDate: draft.requiredByDate,
          lineItems: draft.lineItems,
          extras: Array.from(extras.values()),
          specialInstructions: specialInstructions.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setSendResult({ ok: false, error: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setSendResult({
          ok: true,
          supplierOrderId: data.supplierOrderId,
          poNumber: data.poNumber,
          sentToEmail: data.sentToEmail,
        });
      }
    } catch (err) {
      setSendResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
      sendInFlightRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-ppp-navy/40 backdrop-blur-sm animate-fade-in"
        onClick={() => !sending && onClose()}
        aria-hidden
      />
      <div className="relative z-10 w-full sm:max-w-4xl max-h-[94vh] bg-white border border-ppp-charcoal-100 rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-ppp-charcoal/20 overflow-hidden flex flex-col animate-fade-up">
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ppp-navy truncate">
              Order materials from {supplierName}
            </h3>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
              {customerName ?? "(unknown customer)"} · WO {workOrderNumber ?? workOrderId.slice(-6)}
              {draft && (
                <> · <span className="font-mono">{draft.poNumber}</span></>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="shrink-0 h-9 w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 transition-colors flex items-center justify-center disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {/* Success state */}
          {sendResult?.ok === true && (
            <div className="p-6 sm:p-8 text-center">
              <div className="mx-auto h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-4">
                ✓
              </div>
              <h2 className="text-xl font-bold text-ppp-navy">Order sent</h2>
              <p className="mt-2 text-sm text-ppp-charcoal-500">
                {sendResult.poNumber} delivered to <strong className="text-ppp-charcoal">{sendResult.sentToEmail}</strong>
              </p>
              <p className="mt-3 text-[11px] text-ppp-charcoal-500 max-w-md mx-auto italic">
                Reply tracking is in the works — {supplierName}&apos;s response will land in the
                Command Center inbox (when Resend inbound webhook is configured). For now,
                check the orders@ Gmail inbox.
              </p>
            </div>
          )}

          {/* Error state */}
          {sendResult?.ok === false && (
            <div className="px-5 sm:px-6 py-4 bg-ppp-orange-50 border-b border-ppp-orange-100">
              <div className="font-semibold text-ppp-orange-700 text-sm">Couldn&apos;t send.</div>
              <div className="text-xs text-ppp-orange-700 mt-1 break-words">{sendResult.error}</div>
              <button
                type="button"
                onClick={() => setSendResult(null)}
                className="mt-2 text-xs text-ppp-orange-700 underline hover:text-ppp-orange-900"
              >
                Dismiss + try again
              </button>
            </div>
          )}

          {/* Editor — hidden after successful send */}
          {sendResult?.ok !== true && (
            <div className="p-5 sm:p-6 space-y-5">
              {/* Loading / error */}
              {loadingDraft && !draft && (
                <div className="text-sm text-ppp-charcoal-500 italic">Building draft…</div>
              )}
              {draftError && (
                <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2 text-xs text-ppp-orange-700">
                  Couldn&apos;t build draft: {draftError}
                </div>
              )}

              {draft && (
                <>
                  {/* Warnings — surfaced ABOVE the form so they can't be missed */}
                  {draft.noColorsPicked && (
                    <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
                      <strong>⚠ Customer hasn&apos;t picked colors yet.</strong> The COLORS block below is empty.
                      Send the Color Form first, or proceed without colors if PPP is ordering generic stock.
                    </div>
                  )}
                  {fulfillment === "delivery" && draft.unresolvedAddress && (
                    <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
                      <strong>⚠ No delivery address on file.</strong> Edit the email body manually to add
                      the customer&apos;s delivery address before sending, or switch to Pickup.
                    </div>
                  )}
                  {!draft.sentToEmail && (
                    <div className="bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-4 py-3 text-xs text-ppp-blue-700">
                      <strong>Order email not set for {supplierName} yet.</strong> Set it in
                      Settings → Suppliers, or use Copy-to-Clipboard below and paste into Gmail.
                    </div>
                  )}
                  {/* Paint quantities are SYSTEM ESTIMATES (derived from the
                      floor-area measurement in Salesforce). App-only banner —
                      the vendor email shows clean numbers with no "estimate"
                      wording. The worker reviews the buy-list before sending. */}
                  {draft.gallonEstimates.length > 0 && (
                    <div className="bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-4 py-3 text-xs text-ppp-blue-700">
                      <strong>Paint quantities are estimates.</strong> Gallons are calculated from the
                      square footage in Salesforce — review the buy-list below and adjust the email if a
                      job needs more (heavy texture, dark-over-light, etc.) before sending.
                    </div>
                  )}

                  {/* The clean "what to buy" shopping list — per color, whole
                      gallons. Mirrors the ORDER section of the email so the
                      worker eyeballs quantities without scanning the body. */}
                  {draft.gallonEstimates.length > 0 && (
                    <div className="bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden">
                      <div className="px-4 py-2 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-ppp-charcoal">Order — what to buy</span>
                        {(() => {
                          const t = summarizeOrder(draft.gallonEstimates);
                          if (t.buckets === 0 && t.cans === 0) return null;
                          return (
                            <span className="text-[11px] text-ppp-charcoal-500">
                              Total: <strong className="text-ppp-charcoal">{formatBucketsCans(t.buckets, t.cans)}</strong>
                              {t.reviewColors > 0 && <span className="text-ppp-orange-700"> · {t.reviewColors} to confirm</span>}
                            </span>
                          );
                        })()}
                      </div>
                      <ul className="divide-y divide-ppp-charcoal-100">
                        {draft.gallonEstimates.map((e, i) => (
                          <li key={`${e.colorId}-${e.finish ?? ""}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                            <div className="min-w-0">
                              <span className="font-medium text-ppp-charcoal">{e.colorName}</span>
                              {e.colorCode && <span className="text-ppp-charcoal-400 ml-1">{e.colorCode}</span>}
                              {e.finish && <span className="text-ppp-charcoal-500"> · {e.finish}</span>}
                              {e.surfaces.length > 0 && (
                                <span className="text-[10px] text-ppp-charcoal-400 ml-1">({e.surfaces.join(", ")})</span>
                              )}
                            </div>
                            <span className="shrink-0 text-right whitespace-nowrap">
                              <span className={`font-semibold ${(e.buckets > 0 || e.cans > 0) ? "text-ppp-charcoal" : "text-ppp-orange-700"}`}>
                                {formatOrderQuantity(e)}
                              </span>
                              {/* Partially measured: has a quantity but a room
                                  had no sqft, so this is an UNDER-count. Flag it
                                  so the worker tops it up before sending. */}
                              {e.needsMeasurement && (e.buckets > 0 || e.cans > 0) && (
                                <span className="block text-[10px] font-normal text-ppp-orange-700">⚠ a room is unmeasured — may be low</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Surface any color we couldn't size (missing sqft / unsized
                      surface like cabinets) so the worker sets a quantity in the
                      email instead of the vendor receiving a blank line. */}
                  {(() => {
                    const unsized = draft.gallonEstimates.filter((e) => e.buckets === 0 && e.cans === 0);
                    if (unsized.length === 0) return null;
                    return (
                      <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
                        <strong>⚠ {unsized.length} color{unsized.length === 1 ? "" : "s"} need a manual quantity</strong> — Salesforce has no square footage for {unsized.length === 1 ? "it" : "them"} (or it&apos;s a surface we can&apos;t size, like cabinets). Set the gallons in the email body before sending, or fix the WOLI sqft in SF.
                      </div>
                    );
                  })()}

                  {/* Fulfillment */}
                  <Section title="Fulfillment">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <FulfillmentChoice
                        selected={fulfillment === "delivery"}
                        onSelect={() => setFulfillment("delivery")}
                        title="Deliver to customer"
                        description={
                          draft.deliveryAddress
                            ? `${draft.deliveryAddress.street}, ${draft.deliveryAddress.city}${draft.deliveryAddress.state ? ", " + draft.deliveryAddress.state : ""}`
                            : "No address on file — edit body manually before send"
                        }
                        sourceLabel={
                          draft.deliveryAddress?.source === "customer_form" ? "From customer form" :
                          draft.deliveryAddress?.source === "sf_account"     ? "From SF Account" :
                          undefined
                        }
                      />
                      <FulfillmentChoice
                        selected={fulfillment === "pickup"}
                        onSelect={() => setFulfillment("pickup")}
                        title="Pickup at supplier"
                        description="PPP staff will pick up — uncommon"
                      />
                    </div>
                    {fulfillment === "pickup" && (
                      <PickupLocationPicker
                        locations={draft?.pickupLocations ?? []}
                        value={pickupLocation}
                        onChange={setPickupLocation}
                      />
                    )}
                    {/* No address on file → type it here; it flows straight into
                        the email's DELIVERY block (same as extras / special
                        instructions). Stays open while you fill it. */}
                    {fulfillment === "delivery" && (draft.unresolvedAddress || deliveryAddr.street.trim() !== "") && (
                      <div className="mt-3 rounded-lg border border-ppp-orange-100 bg-ppp-orange-50/60 p-3">
                        <div className="text-[11px] font-semibold text-ppp-orange-700 mb-2">
                          No delivery address on file — enter it and it&apos;ll drop into the email.
                        </div>
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={deliveryAddr.street}
                            onChange={(e) => setDeliveryAddr((a) => ({ ...a, street: e.target.value }))}
                            placeholder="Street address"
                            className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                          />
                          <div className="grid grid-cols-2 sm:grid-cols-[1fr_auto_auto] gap-2">
                            <input
                              type="text"
                              value={deliveryAddr.city}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, city: e.target.value }))}
                              placeholder="City"
                              className="px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                            <input
                              type="text"
                              value={deliveryAddr.state}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, state: e.target.value }))}
                              placeholder="State"
                              maxLength={4}
                              className="w-20 px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              value={deliveryAddr.postalCode}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, postalCode: e.target.value }))}
                              placeholder="ZIP"
                              maxLength={10}
                              className="w-24 px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </Section>

                  {/* Extras dropdown */}
                  <Section title={`Extras (${extras.size} selected)`}>
                    <input
                      type="text"
                      value={extrasSearch}
                      onChange={(e) => setExtrasSearch(e.target.value)}
                      placeholder="Search rollers / brushes / tape / …"
                      className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue mb-3"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                      {filteredCatalog.map((c) => {
                        const selected = extras.get(c.id);
                        return (
                          <label
                            key={c.id}
                            className={[
                              "flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer transition-colors",
                              selected
                                ? "bg-ppp-blue-50 border-ppp-blue-100"
                                : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50",
                            ].join(" ")}
                          >
                            <input
                              type="checkbox"
                              checked={!!selected}
                              onChange={() => toggleExtra(c)}
                              className="shrink-0"
                            />
                            <span className="flex-1 truncate">{c.name}</span>
                            {selected ? (
                              <input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={selected.qty}
                                onChange={(e) => updateExtraQty(c.id, Number(e.target.value))}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                                // text-base on mobile to avoid iOS zoom-on-focus.
                                className="w-16 shrink-0 px-2 py-1 sm:py-0.5 text-base sm:text-xs text-right border border-ppp-blue-100 rounded font-mono"
                              />
                            ) : (
                              <span className="text-[10px] text-ppp-charcoal-500 shrink-0">
                                ×{c.default_qty} {c.unit}
                              </span>
                            )}
                          </label>
                        );
                      })}
                      {filteredCatalog.length === 0 && (
                        <div className="col-span-full text-xs text-ppp-charcoal-500 italic py-3 text-center">
                          No matches.
                        </div>
                      )}
                    </div>
                  </Section>

                  {/* Special instructions */}
                  <Section title="Special instructions">
                    <textarea
                      value={specialInstructions}
                      onChange={(e) => setSpecialInstructions(e.target.value)}
                      rows={2}
                      placeholder="e.g. Customer prefers AM delivery. Garage code in scheduling notes."
                      className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                    />
                  </Section>

                  {/* Email preview / editor — scrolled into view on first
                      draft load via the parent ref + useEffect below.
                      A subtle "updating…" pulse on the section header when
                      a re-fetch is in flight gives instant feedback after
                      extras / fulfillment toggles, so the worker knows the
                      email IS regenerating with their changes (without it
                      the ~300ms latency reads as "the email didn't update"). */}
                  <div ref={emailBodyRef}>
                  <Section
                    title="Email body"
                    subtitle={
                      loadingDraft
                        ? "Updating with your changes…"
                        : draft.subject ? `Subject: ${draft.subject}` : undefined
                    }
                  >
                    <div className="relative">
                      <textarea
                        value={editedBody ?? draft.body}
                        onChange={(e) => setEditedBody(e.target.value)}
                        rows={16}
                        className={[
                          "w-full px-3 py-2 text-xs font-mono border rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue leading-relaxed transition-opacity",
                          loadingDraft && editedBody === null ? "border-ppp-blue-100 opacity-70" : "border-ppp-charcoal-100",
                        ].join(" ")}
                      />
                      {loadingDraft && editedBody === null && (
                        <div className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-[10px] text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 px-2 py-0.5 rounded-full">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ppp-blue animate-pulse" />
                          Updating
                        </div>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-ppp-charcoal-500">
                      <span>
                        {editedBody !== null
                          ? "Editing manually — extras changes won't update this body."
                          : "Edit any line before sending. Toggling extras updates this automatically."}
                      </span>
                      {editedBody !== null && (
                        <button
                          type="button"
                          onClick={() => setEditedBody(null)}
                          className="text-ppp-blue hover:text-ppp-blue-700 underline"
                        >
                          Reset to auto-generated
                        </button>
                      )}
                    </div>
                  </Section>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer — actions */}
        <div className="shrink-0 px-5 sm:px-6 py-3.5 border-t border-ppp-charcoal-100 bg-white flex items-center justify-between gap-3 flex-wrap">
          {sendResult?.ok === true ? (
            <>
              <span className="text-xs text-ppp-green-700 font-semibold">Order recorded.</span>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={sending}
                  className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!draft || sending}
                  className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
                >
                  {copied ? "✓ Copied" : "Copy to Clipboard"}
                </button>
              </div>
              {(() => {
                // Send is blocked when there's literally nothing to order:
                // zero paint colors AND zero extras (and not a special-
                // instructions-only general supplies note). Catches the
                // "customer hasn't submitted form + worker forgot to tick
                // an extra" footgun that would email the supplier an empty
                // shopping list.
                const isGeneral = supplierAccountId === "__general__";
                const hasAnything =
                  (draft && draft.lineItems.length > 0) ||
                  extras.size > 0 ||
                  (isGeneral && specialInstructions.trim().length > 0);
                const emptyOrder = !!draft && !hasAnything;
                const blockedForAddress = fulfillment === "delivery" && !!draft?.unresolvedAddress;
                const blockedForEmail = !draft?.sentToEmail;
                const disabled = !draft || sending || blockedForEmail || blockedForAddress || emptyOrder;
                const title = blockedForEmail
                  ? `Set ${supplierName}'s order email in Settings → Suppliers first`
                  : blockedForAddress
                    ? "Add a delivery address before sending (or switch to Pickup)"
                    : emptyOrder
                      ? "Nothing to order — pick at least one paint color (via customer form) or tick an extra"
                      : "";
                return (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={disabled}
                    title={title}
                    className="px-4 py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sending ? "Sending…"
                      : blockedForEmail ? "Send (email not set)"
                      : emptyOrder ? "Nothing to order yet"
                      : draft?.sentToEmail ? `Send to ${draft.sentToEmail}`
                      : "Send"}
                  </button>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ─── */

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h4 className="text-[11px] font-condensed font-bold uppercase tracking-wider text-ppp-charcoal-500">
          {title}
        </h4>
        {subtitle && <span className="text-[11px] text-ppp-charcoal-500 truncate">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function FulfillmentChoice({
  selected,
  onSelect,
  title,
  description,
  sourceLabel,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  sourceLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "text-left px-3 py-2.5 rounded-lg border text-xs transition-colors",
        selected
          ? "bg-ppp-blue-50 border-ppp-blue ring-2 ring-ppp-blue/20"
          : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={selected ? "text-ppp-blue-700 font-bold" : "text-ppp-charcoal-500"}>
          {selected ? "●" : "○"}
        </span>
        <span className="font-semibold text-ppp-charcoal">{title}</span>
        {sourceLabel && (
          <span className="ml-auto text-[9px] uppercase tracking-wide font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-50 px-1.5 py-0.5 rounded">
            {sourceLabel}
          </span>
        )}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 pl-4 truncate">
        {description}
      </div>
    </button>
  );
}

/* ─── Pickup location picker ─── */

/**
 * Pickup-location input that becomes a SELECT dropdown when the supplier
 * has pickup_locations configured in /dashboard/settings/suppliers. Falls
 * back to a free-text input when nothing is curated yet. Per the one-click
 * + autofill rule — workers should pick from a known list, not retype
 * "BM Smithtown · 123 Main St" every time.
 *
 * - 0 configured: text input (admin hasn't set anything up; legacy path)
 * - 1 configured: pre-selected, single radio (no decision needed)
 * - 2+ configured: dropdown with each location + an "Other" option that
 *   reveals a text input for one-off pickup addresses
 */
function PickupLocationPicker({
  locations,
  value,
  onChange,
}: {
  locations: Array<{ name: string; address: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  const OTHER = "__other__";
  const formatted = (loc: { name: string; address: string }) =>
    loc.address ? `${loc.name} · ${loc.address}` : loc.name;

  useEffect(() => {
    if (locations.length === 1 && !value) {
      onChange(formatted(locations[0]));
    }
  }, [locations, value, onChange]);

  if (locations.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. BM Smithtown · 123 Main St"
        className="mt-3 w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
      />
    );
  }

  const knownMatch = locations.find((loc) => formatted(loc) === value);
  const isOther = !!value && !knownMatch;
  const selectValue = knownMatch ? formatted(knownMatch) : isOther ? OTHER : "";

  return (
    <div className="mt-3 space-y-2">
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) onChange(value && !knownMatch ? value : " ");
          else onChange(v);
        }}
        className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
      >
        {locations.length > 1 && <option value="">Pick a location…</option>}
        {locations.map((loc) => (
          <option key={`${loc.name}__${loc.address}`} value={formatted(loc)}>
            {formatted(loc)}
          </option>
        ))}
        <option value={OTHER}>Other (type below)…</option>
      </select>
      {isOther && (
        <input
          type="text"
          autoFocus
          value={value.trim()}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. BM Smithtown · 123 Main St"
          className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
      )}
    </div>
  );
}
