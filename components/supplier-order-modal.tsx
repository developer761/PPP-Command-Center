"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEscClose } from "@/lib/hooks/use-esc-close";
import { formatOrderQuantity, formatBucketsCans, summarizeOrder, type GallonEstimate } from "@/lib/supplier-order/estimate-gallons";
import { isNycAddress } from "@/lib/supplier-order/nyc-zips";
import MaterialTypePicker from "@/components/material-type-picker";

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
  /** Phone-only suppliers (Janovic): modal swaps the Send button for a Call
   *  CTA and the order content stays composed for copy-to-clipboard. */
  phoneOnly?: boolean;
  phoneNumber?: string | null;
  /** When true, modal opens with fulfillment=pickup pre-selected (Katie 2026-
   *  06-10: NYC suppliers don't generally deliver). */
  pickupDefault?: boolean;
  skippedSurfaces?: Array<{ roomLabel: string; surface: string }>;
  /** WO-context-filtered Material Type allowlist. Empty array = no filter
   *  (mixed/unknown WO). Passed to the per-color override picker so an
   *  admin can't pick "Aura Interior" for an exterior WO. */
  allowedMaterialTypeValues?: string[];
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
  // Track whether the admin has manually touched the fulfillment toggle. If
  // they have, we never auto-flip (NYC default or otherwise) — admin's
  // explicit choice wins. Ref instead of state so the auto-flip useEffect
  // doesn't race React's render cycle.
  const adminTouchedFulfillment = useRef(false);
  // Whether the current draft's delivery address falls inside the NYC
  // 5-borough ZIP ranges. Triggers a "pickup recommended" chip + auto-flip
  // the default (only if admin hasn't already touched the toggle).
  const [isNycDelivery, setIsNycDelivery] = useState(false);
  const [pickupLocation, setPickupLocation] = useState("");
  // Manually-typed delivery address — used when SF has no address on file. Flows
  // into the draft (top-priority candidate) → the email's delivery block, the
  // same way extras + special instructions do.
  const [deliveryAddr, setDeliveryAddr] = useState({ street: "", city: "", state: "", postalCode: "" });
  // Katie 2026-06-05: "we don't necessarily want to save every crew's
  // address — leave it as a type-in option." When true, the manual address
  // form expands even though SF has an address on file, and the typed-in
  // address WINS in the email body. Per-order only, never persisted.
  const [useCustomAddress, setUseCustomAddress] = useState(false);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [extras, setExtras] = useState<Map<string, SelectedExtra>>(new Map());
  const [editedBody, setEditedBody] = useState<string | null>(null); // null = use draft.body unchanged
  // Per-color quantity overrides — Katie 2026-06-03 wanted +/- buttons to
  // tweak the recommended gallon count before sending. Keyed by
  // colorId + finish so different finishes of the same color stay separate.
  // When non-empty, replaces the matching line in the email body via a
  // narrow regex (matches by color name + code + finish + surfaces — admin
  // can still edit the body manually). Cleared on draft refetch.
  const [quantityOverrides, setQuantityOverrides] = useState<Map<string, { buckets: number; cans: number }>>(new Map());
  // Per-color Material Type overrides — Katie 2026-06-05: "we will want to be
  // able to adjust per surface in case we mix product lines." Keyed by
  // `${colorId}::${finish ?? ""}` to match the +/- override map shape. Empty
  // string value treated as "no override" (admin picked the default). Cleared
  // on WO/supplier change so different jobs don't carry stale overrides.
  const [materialTypeOverrides, setMaterialTypeOverrides] = useState<Map<string, string>>(new Map());
  const setMaterialTypeForColor = (colorId: string, finish: string | null, value: string) => {
    const key = `${colorId}::${finish ?? ""}`;
    setMaterialTypeOverrides((prev) => {
      const next = new Map(prev);
      if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  };

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
  const [copyError, setCopyError] = useState<string | null>(null);

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
            materialTypeOverrides:
              materialTypeOverrides.size > 0
                ? Object.fromEntries(materialTypeOverrides)
                : undefined,
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
          // Gallon-quantity overrides are tied to the SPECIFIC draft.body
          // string. When the body refreshes (admin toggled an extra), the
          // line is back to the original estimate so the override is stale.
          // Clear the Map so the +/- "edited" badge doesn't lie about the
          // current body state (audit-flagged 2026-06-04).
          setQuantityOverrides(new Map());
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
  }, [workOrderId, supplierAccountId, fulfillment, pickupLocation, deliveryAddr, extras, specialInstructions, manualSupplier, materialTypeOverrides]);

  // Reset the "admin touched fulfillment" guard whenever a different WO
  // becomes the modal's target. Without this, admin manually picking
  // delivery on WO A's modal would leak into WO B's modal — the NYC
  // auto-flip would skip there too (audit-flagged 2026-06-04). Same
  // reasoning for per-color material type overrides — different WO
  // means different colors, the keyed map is now stale.
  useEffect(() => {
    adminTouchedFulfillment.current = false;
    setMaterialTypeOverrides(new Map());
  }, [workOrderId, supplierAccountId]);

  // Pickup default — three sources, descending priority:
  //   1. Supplier-level pickup_default (Katie 2026-06-10: NYC suppliers like
  //      Janovic, Ricciardi default to pickup regardless of delivery address).
  //   2. NYC delivery address (Katie 2026-06-04: 5 boroughs).
  //   3. Admin's manual toggle (always wins once they touch it).
  // Admin's explicit choice always wins; the auto-flip only fires before they
  // touch the toggle.
  useEffect(() => {
    if (!draft) return;
    const nyc = isNycAddress(draft.deliveryAddress);
    setIsNycDelivery(nyc);
    const shouldPickup = draft.pickupDefault || nyc;
    if (shouldPickup && !adminTouchedFulfillment.current && fulfillment !== "pickup") {
      setFulfillment("pickup");
    }
  }, [draft, fulfillment]);

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

  // Custom typed-in extras — Katie 2026-06-05: workers need to add things
  // that aren't in the catalog (one-off items per job). Each gets a synthetic
  // extraId prefixed with "custom-" so the existing toggleExtra / qty paths
  // work unchanged, and the supplier email renders the typed name as-is.
  // Stored alongside catalog extras in the same Map.
  const [customName, setCustomName] = useState("");
  const [customQty, setCustomQty] = useState("1");
  const [customUnit, setCustomUnit] = useState("each");
  const addCustomExtra = () => {
    const name = customName.trim();
    if (!name) return;
    const qty = Math.max(1, Math.floor(Number(customQty) || 1));
    const unit = customUnit.trim() || "each";
    setExtras((prev) => {
      const next = new Map(prev);
      // Stable id from the lowercased name + timestamp so two rapid adds of
      // the same name don't overwrite each other; the timestamp suffix
      // disambiguates without showing up in the user-visible name.
      const id = `custom-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
      next.set(id, { extraId: id, name, unit, qty });
      return next;
    });
    setCustomName("");
    setCustomQty("1");
    setCustomUnit("each");
  };
  const removeExtra = (extraId: string) => {
    setExtras((prev) => {
      const next = new Map(prev);
      next.delete(extraId);
      return next;
    });
  };

  const bodyToSend = editedBody ?? draft?.body ?? "";

  /**
   * Per-color gallon +/- handler. Updates the override Map AND rewrites
   * the matching line in the email body so the supplier sees the new
   * quantity. Triple-guard against silent corruption:
   *
   *   1. Cap final cans at 0..99 — prevents typo-tornado of 999 gallons
   *   2. Find the line by escaping the color name (regex-safe) + matching
   *      the standard prefix the builder emits (`  Xg — ` / `  X bucket — `
   *      / `  ___ — `). If we can't find the line, the body might have been
   *      manually edited — surface a console warning + skip the body
   *      rewrite (override still updates the visible badge).
   *   3. Reset=true clears the override + restores the original line in
   *      the body via the same find-replace.
   */
  function adjustQuantity(
    e: { colorId: string; colorName: string; colorCode: string | null; finish: string | null; surfaces: string[]; buckets: number; cans: number },
    delta: number,
    reset?: boolean,
  ) {
    const key = `${e.colorId}::${e.finish ?? ""}`;
    const cur = quantityOverrides.get(key) ?? { buckets: e.buckets, cans: e.cans };
    const curTotalCans = cur.buckets * 5 + cur.cans;
    let nextTotalCans = reset ? e.buckets * 5 + e.cans : Math.max(0, Math.min(99, curTotalCans + delta));
    const nextBuckets = Math.floor(nextTotalCans / 5);
    const nextCans = nextTotalCans % 5;

    // Build the "old" + "new" quantity prefixes so we can swap them in the
    // email body. Mirrors estimate-gallons.ts formatOrderQuantity().
    const formatPrefix = (buckets: number, cans: number) => {
      if (buckets === 0 && cans === 0) return "___";
      const parts: string[] = [];
      if (buckets > 0) parts.push(`${buckets} bucket${buckets === 1 ? "" : "s"} (×5 gal)`);
      if (cans > 0) parts.push(`${cans} gal`);
      return parts.join(" + ");
    };
    const oldPrefix = formatPrefix(cur.buckets, cur.cans);
    const newPrefix = formatPrefix(nextBuckets, nextCans);

    // Try to update the body line for this color. The format the builder
    // emits per color line is:
    //   `  <qty> — <colorName>[ <colorCode>][ · <finish>][ (<surfaces>)][ (PPP to confirm quantity)]`
    // We match by color name AND (when present) finish + colorCode, so two
    // entries with the same color but different finishes don't collide
    // (audit-flagged 2026-06-04). Escape every regex metacharacter
    // including `/` and backticks. Then capture the trailing rest-of-line
    // (after the name + optional finish) so we can preserve it AND
    // re-attach (or strip) the "(PPP to confirm quantity)" suffix based on
    // whether the new quantity is 0.
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/`]/g, "\\$&");
    const currentBody = editedBody ?? draft?.body ?? "";
    const escapedName = escapeRe(e.colorName);
    const escapedFinish = e.finish ? escapeRe(e.finish) : "";
    // The full "— <discriminator>" suffix that identifies THIS specific line.
    // Includes finish when present to disambiguate same-name-different-finish.
    const discriminator = escapedFinish
      ? `${escapedName}[^\\n]*?·\\s*${escapedFinish}`
      : escapedName;
    const lineRe = new RegExp(
      `^([ \\t]*)(?:[0-9]+\\s+bucket[^—]*|[0-9]+\\s+gal(?:[^—]*?)|___)\\s*—\\s*(${discriminator}[^\\n]*?)(\\s*\\(PPP to confirm quantity\\))?$`,
      "m"
    );
    let bodyUpdated = false;
    const newBody = currentBody.replace(lineRe, (_match, indent: string, restOfLine: string) => {
      bodyUpdated = true;
      // When we drop to zero, re-attach the "(PPP to confirm quantity)"
      // marker so the vendor sees the same prompt the original empty
      // estimate would have produced. When raising back above zero, drop it.
      const isZero = nextBuckets === 0 && nextCans === 0;
      const suffix = isZero ? " (PPP to confirm quantity)" : "";
      return `${indent}${newPrefix} — ${restOfLine}${suffix}`;
    });
    if (!bodyUpdated) {
      console.warn(`[supplier-order-modal] couldn't find body line for "${e.colorName}${e.finish ? ` · ${e.finish}` : ""}" — admin may have manually edited it. Override badge updated, but body text not changed.`);
    }
    setEditedBody(bodyUpdated ? newBody : currentBody);

    // Update override Map. Reset removes the override entirely so the row
    // shows no "edited" badge.
    setQuantityOverrides((prev) => {
      const next = new Map(prev);
      if (reset) {
        next.delete(key);
      } else if (nextBuckets === e.buckets && nextCans === e.cans) {
        // Adjusted back to the original estimate — clear the override too
        next.delete(key);
      } else {
        next.set(key, { buckets: nextBuckets, cans: nextCans });
      }
      return next;
    });
  }

  const handleCopy = async () => {
    setCopyError(null);
    try {
      const subject = draft?.subject ?? "";
      // Include subject as first line so admin can paste into Gmail's compose
      // and easily split it back out.
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${bodyToSend}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      // Show inline (non-blocking) instead of alert() — older browsers
      // and embedded webviews (PPP team uses Safari + iOS quite a bit) can
      // reject clipboard.writeText() outside a secure context. Auto-clears
      // after 5s so the message doesn't sit forever.
      const msg = err instanceof Error ? err.message : String(err);
      setCopyError(`Couldn't copy automatically — select the email body below and Cmd/Ctrl+C. (${msg})`);
      setTimeout(() => setCopyError(null), 5000);
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
          // Per-color Material Type overrides — already baked into bodyToSend
          // at draft time. Forwarded here so the send route's audit row has
          // the structured data alongside the rendered email body (future
          // re-renders / audit replays can reproduce the email).
          materialTypeOverrides:
            materialTypeOverrides.size > 0
              ? Object.fromEntries(materialTypeOverrides)
              : undefined,
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
              {/* PO badge — show as a skeleton placeholder while the draft is
                  loading so the admin sees the slot for the PO and isn't left
                  wondering whether one will appear. Karan walkthrough audit
                  2026-06-08: PO is the thing PPP staff reference verbally on
                  calls with suppliers; surfacing the slot immediately reduces
                  the "is this thing still loading" friction. */}
              {draft ? (
                <> · <span className="font-mono">{draft.poNumber}</span></>
              ) : (
                <> · <span className="font-mono text-ppp-charcoal-300">PO loading…</span></>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="shrink-0 h-11 w-11 sm:h-9 sm:w-9 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors flex items-center justify-center disabled:opacity-50 touch-manipulation"
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
                  {/* The clean "what to buy" shopping list — per color, whole
                      gallons. Mirrors the ORDER section of the email so the
                      worker eyeballs quantities without scanning the body.
                      "Estimate" framing lives in the header (app-only) — the
                      vendor email shows clean numbers with no estimate wording. */}
                  {draft.gallonEstimates.length > 0 && (
                    <div className="bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-semibold text-ppp-charcoal">Order — what to buy</span>
                          <span
                            className="text-[10px] uppercase tracking-wider text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 px-1.5 py-0.5 rounded-full font-medium"
                            title="Gallons are calculated from the square footage in Salesforce. Review the list and adjust the email if a job needs more (heavy texture, dark-over-light, etc.)."
                          >
                            estimated
                          </span>
                        </div>
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
                        {draft.gallonEstimates.map((e, i) => {
                          // Use the override when set, otherwise the estimate.
                          // Key matches what we use in adjustQuantity below.
                          const overrideKey = `${e.colorId}::${e.finish ?? ""}`;
                          const override = quantityOverrides.get(overrideKey);
                          const effective = override ?? { buckets: e.buckets, cans: e.cans };
                          const hasOverride = !!override;
                          const totalCans = effective.buckets * 5 + effective.cans;
                          const displayQty = effective.buckets > 0 || effective.cans > 0
                            ? formatOrderQuantity({ ...e, buckets: effective.buckets, cans: effective.cans })
                            : "___ (PPP to confirm)";

                          return (
                            <li key={`${e.colorId}-${e.finish ?? ""}-${i}`} className="px-4 py-2 text-xs">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <span className="font-medium text-ppp-charcoal">{e.colorName}</span>
                                  {e.colorCode && <span className="text-ppp-charcoal-400 ml-1">{e.colorCode}</span>}
                                  {e.finish && <span className="text-ppp-charcoal-500"> · {e.finish}</span>}
                                  {e.surfaces.length > 0 && (
                                    <span className="text-[10px] text-ppp-charcoal-400 ml-1">({e.surfaces.join(", ")})</span>
                                  )}
                                </div>
                                <div className="shrink-0 flex items-center gap-1.5">
                                  {/* +/- buttons. Katie 2026-06-03 wanted to
                                      tweak the recommended count before sending.
                                      Cap 0-99 cans total (99 = 19 buckets + 4
                                      cans). Below 0 disables minus; at 99
                                      disables plus. */}
                                  <button
                                    type="button"
                                    aria-label={`Decrease ${e.colorName} by one gallon`}
                                    disabled={totalCans <= 0}
                                    onClick={() => adjustQuantity(e, -1)}
                                    className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 disabled:bg-ppp-charcoal-100 disabled:text-ppp-charcoal-300 disabled:border-ppp-charcoal-200 disabled:cursor-not-allowed flex items-center justify-center text-xl sm:text-base leading-none touch-manipulation"
                                  >
                                    −
                                  </button>
                                  <span
                                    className={`font-semibold min-w-[5.5rem] text-right whitespace-nowrap ${(effective.buckets > 0 || effective.cans > 0) ? "text-ppp-charcoal" : "text-ppp-orange-700"}`}
                                  >
                                    {displayQty}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Increase ${e.colorName} by one gallon`}
                                    disabled={totalCans >= 99}
                                    onClick={() => adjustQuantity(e, +1)}
                                    className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-charcoal-100 text-ppp-charcoal hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 disabled:bg-ppp-charcoal-100 disabled:text-ppp-charcoal-300 disabled:border-ppp-charcoal-200 disabled:cursor-not-allowed flex items-center justify-center text-xl sm:text-base leading-none touch-manipulation"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                              {hasOverride && (
                                <div className="flex items-center justify-end gap-2 mt-1">
                                  <span className="text-[10px] text-ppp-blue-700">edited from {formatOrderQuantity(e)}</span>
                                  <button
                                    type="button"
                                    onClick={() => adjustQuantity(e, 0, /* reset */ true)}
                                    className="text-[10px] text-ppp-blue-700 hover:underline"
                                  >
                                    reset
                                  </button>
                                </div>
                              )}
                              {/* Per-color Material Type override — Katie
                                  2026-06-05. Empty value = "use job-level"
                                  (whatever the customer picked or what's on
                                  the WO). Overridden values prefix the
                                  vendor email line with `[Product]` and the
                                  shared "Paint product line:" header drops
                                  when the job is mixed. */}
                              {(() => {
                                const mtKey = `${e.colorId}::${e.finish ?? ""}`;
                                const currentMt = materialTypeOverrides.get(mtKey) ?? "";
                                // Pass the WO-filtered allowlist so admin can't pick
                                // an interior product for an exterior WO (or vice
                                // versa). Empty array = no filtering (mixed/unknown).
                                const allowed: ReadonlySet<string> | undefined =
                                  (draft.allowedMaterialTypeValues ?? []).length > 0
                                    ? new Set<string>(draft.allowedMaterialTypeValues)
                                    : undefined;
                                return (
                                  <div className="flex items-center justify-end gap-2 mt-1.5">
                                    <label className="text-[10px] text-ppp-charcoal-500 shrink-0" htmlFor={`mt-${mtKey}`}>
                                      Product line:
                                    </label>
                                    <div className="max-w-[200px]">
                                      <MaterialTypePicker
                                        id={`mt-${mtKey}`}
                                        value={currentMt}
                                        onChange={(v) => setMaterialTypeForColor(e.colorId, e.finish, v)}
                                        placeholder="— use default —"
                                        compact
                                        allowClear
                                        availableValues={allowed}
                                      />
                                    </div>
                                  </div>
                                );
                              })()}
                              {e.needsMeasurement && (effective.buckets > 0 || effective.cans > 0) && (
                                <span className="block text-[10px] font-normal text-ppp-orange-700 mt-0.5 text-right">⚠ a room is unmeasured — may be low</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* Surface any color we couldn't size. Split into TWO banners
                      so the worker sees the right cause + remediation:
                       - manualOnly: WO has ZERO measurement data on SF (every
                         contributing room is bare). Stronger red banner — the
                         worker MUST set quantities, no auto-estimate possible.
                         Karan 2026-06-09: "no auto-calculation whatsoever".
                       - unsized only: SOME surface (cabinets, accent walls,
                         etc.) can't be sized — milder orange banner. */}
                  {(() => {
                    const manualOnlyEstimates = draft.gallonEstimates.filter((e) => e.manualOnly);
                    const otherZeroEstimates = draft.gallonEstimates.filter(
                      (e) => !e.manualOnly && e.buckets === 0 && e.cans === 0
                    );
                    return (
                      <>
                        {manualOnlyEstimates.length > 0 && (
                          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-700 space-y-1">
                            <div className="font-semibold text-[13px]">🛑 Manual entry required — no measurements on Salesforce</div>
                            <div>
                              {manualOnlyEstimates.length === 1 ? "1 color" : `${manualOnlyEstimates.length} colors`} on this work order have ZERO square footage / wall area / perimeter in SF — we cannot estimate gallons at all. Set the quantity yourself using the +/- buttons above (or fix the WOLI sqft in Salesforce, then re-open this modal).
                            </div>
                          </div>
                        )}
                        {otherZeroEstimates.length > 0 && (
                          <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
                            <strong>⚠ {otherZeroEstimates.length} color{otherZeroEstimates.length === 1 ? "" : "s"} need a manual quantity</strong> — surface{otherZeroEstimates.length === 1 ? "" : "s"} we can&apos;t size from the data (cabinets, accent walls, etc.). Set the gallons in the email body before sending.
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Fulfillment */}
                  <Section title="Fulfillment">
                    {/* NYC-pickup chip — surfaces WHY the default is pickup when
                        the delivery address is in NYC's 5 boroughs (Katie
                        2026-06-04). Admin can still toggle to delivery; the
                        chip just explains the default. Hidden once admin
                        actually picks delivery so they don't get nagged. */}
                    {isNycDelivery && fulfillment === "pickup" && (
                      <div className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ppp-blue-50 border border-ppp-blue-100 text-[11px] font-medium text-ppp-blue-700">
                        <span aria-hidden>🗽</span>
                        NYC address — defaulted to pickup (delivery often unavailable in the city)
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <FulfillmentChoice
                        selected={fulfillment === "delivery"}
                        onSelect={() => {
                          adminTouchedFulfillment.current = true;
                          setFulfillment("delivery");
                        }}
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
                        onSelect={() => {
                          adminTouchedFulfillment.current = true;
                          setFulfillment("pickup");
                        }}
                        title="Pickup at supplier"
                        description="PPP staff will pick up"
                      />
                    </div>
                    {fulfillment === "pickup" && (
                      <PickupLocationPicker
                        locations={draft?.pickupLocations ?? []}
                        value={pickupLocation}
                        onChange={setPickupLocation}
                      />
                    )}
                    {/* "Deliver to a different address" toggle — Katie
                        2026-06-05. When the SF address is fine, admin
                        leaves this off. When the crew wants the supplier
                        to drop off at their location instead, they tap
                        this and the manual form expands. The typed-in
                        address overrides SF in the email body. Per-order
                        only — never saved.
                        Clears deliveryAddr when toggled OFF so a stale
                        crew address doesn't keep the form visible
                        (edge-case audit 2026-06-05). */}
                    {fulfillment === "delivery" && !draft.unresolvedAddress && (
                      <div className="mt-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setUseCustomAddress((v) => {
                              const next = !v;
                              if (!next) {
                                // Toggling OFF — wipe any typed value so the
                                // form actually hides + the draft regenerates
                                // using the SF address.
                                setDeliveryAddr({ street: "", city: "", state: "", postalCode: "" });
                              }
                              return next;
                            });
                          }}
                          className="text-xs text-ppp-blue-700 hover:text-ppp-blue-800 active:text-ppp-blue-900 font-medium underline-offset-2 hover:underline px-2 py-1 -mr-2 touch-manipulation"
                        >
                          {useCustomAddress
                            ? "↺ Use the customer address instead"
                            : "Deliver to a different address (e.g. crew location) →"}
                        </button>
                      </div>
                    )}

                    {/* No address on file → type it here; it flows straight into
                        the email's DELIVERY block (same as extras / special
                        instructions). Stays open while you fill it. Also opens
                        when admin chose "different address" above.
                        Dropped the `deliveryAddr.street.trim() !== ""` clause
                        — it was making the form stick after admin toggled off
                        (edge-case audit 2026-06-05). useCustomAddress is now
                        the single explicit signal for "show the manual form
                        even though SF has an address." */}
                    {fulfillment === "delivery" && (draft.unresolvedAddress || useCustomAddress) && (
                      <div className="mt-3 rounded-lg border border-ppp-orange-100 bg-ppp-orange-50/60 p-3">
                        <div className="text-[11px] font-semibold text-ppp-orange-700 mb-2">
                          {useCustomAddress
                            ? "Manual delivery address — overrides the customer address for this order only."
                            : "No delivery address on file — enter it and it'll drop into the email."}
                        </div>
                        <div className="space-y-2">
                          {/* autoFocus only when SF returned no address — admin
                              has to type something before they can send, so
                              taking focus is appropriate. We don't autofocus
                              when admin TOGGLED useCustomAddress (they may have
                              just been clicking around without intending to
                              type yet). Karan walkthrough audit 2026-06-08. */}
                          <input
                            type="text"
                            value={deliveryAddr.street}
                            onChange={(e) => setDeliveryAddr((a) => ({ ...a, street: e.target.value }))}
                            placeholder="Street address"
                            autoFocus={draft.unresolvedAddress && !useCustomAddress}
                            className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                          />
                          <div className="grid grid-cols-2 sm:grid-cols-[1fr_auto_auto] gap-2">
                            <input
                              type="text"
                              value={deliveryAddr.city}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, city: e.target.value }))}
                              placeholder="City"
                              autoCapitalize="words"
                              className="px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                            <input
                              type="text"
                              value={deliveryAddr.state}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, state: e.target.value }))}
                              placeholder="State"
                              maxLength={4}
                              autoCapitalize="characters"
                              autoCorrect="off"
                              className="w-20 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              value={deliveryAddr.postalCode}
                              onChange={(e) => setDeliveryAddr((a) => ({ ...a, postalCode: e.target.value }))}
                              placeholder="ZIP"
                              maxLength={10}
                              autoCorrect="off"
                              className="w-24 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </Section>

                  {/* Extras dropdown — Katie's 20-item product list seeded via
                      migration 017. Search bar at top, categorized + sorted by
                      sort_order (Tape → Drop Cloths → Caulk → Patching → Trays
                      → Rollers). Each row has explicit +/- buttons (Karan
                      2026-06-10) matching the per-color pattern. */}
                  <Section title={`Extras (${extras.size > 0 ? `${extras.size} selected` : "none selected"})`}>
                    <input
                      type="search"
                      inputMode="search"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={extrasSearch}
                      onChange={(e) => setExtrasSearch(e.target.value)}
                      placeholder="Search tape / caulk / rollers / …"
                      className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue mb-3"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                      {filteredCatalog.map((c) => {
                        const selected = extras.get(c.id);
                        return (
                          <div
                            key={c.id}
                            className={[
                              "flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs transition-colors",
                              selected
                                ? "bg-ppp-blue-50 border-ppp-blue-100"
                                : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50",
                            ].join(" ")}
                          >
                            <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={!!selected}
                                onChange={() => toggleExtra(c)}
                                className="shrink-0"
                              />
                              <span className="flex-1 truncate">{c.name}</span>
                            </label>
                            {selected ? (
                              <div className="shrink-0 flex items-center gap-1">
                                {/* +/- buttons. Mirrors the per-color qty
                                    pattern above. Cap 1-99 (qty=1 sane min,
                                    99 catches typo runaways). 44px mobile
                                    tap target; 28px on desktop. */}
                                <button
                                  type="button"
                                  aria-label={`Decrease ${c.name} by one`}
                                  disabled={selected.qty <= 1}
                                  onClick={() => updateExtraQty(c.id, selected.qty - 1)}
                                  className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-blue-100 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:bg-ppp-charcoal-50 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
                                >
                                  −
                                </button>
                                <span
                                  className="font-mono font-semibold text-xs min-w-[2.5rem] text-center whitespace-nowrap text-ppp-charcoal"
                                  title={`${selected.qty} ${c.unit}`}
                                >
                                  {selected.qty}
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Increase ${c.name} by one`}
                                  disabled={selected.qty >= 99}
                                  onClick={() => updateExtraQty(c.id, selected.qty + 1)}
                                  className="h-11 w-11 sm:h-7 sm:w-7 rounded border border-ppp-blue-100 bg-white text-ppp-charcoal hover:bg-ppp-charcoal-50 disabled:bg-ppp-charcoal-50 disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
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
                        <div className="col-span-full text-xs text-ppp-charcoal-500 italic py-3 text-center">
                          No matches.
                        </div>
                      )}
                    </div>

                    {/* Custom typed-in extras — Katie 2026-06-05: workers
                        need to add one-off items that aren't in the catalog.
                        Selected customs (extraId prefix "custom-") render
                        above with a remove button; the input row below adds
                        a new one. */}
                    {Array.from(extras.values()).filter((e) => e.extraId.startsWith("custom-")).length > 0 && (
                      <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">
                        <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-2">
                          Custom items added
                        </div>
                        <ul className="space-y-1.5">
                          {Array.from(extras.values())
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
                                  className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-800 active:text-ppp-orange-900 px-2 py-1 -my-1 -mr-1 touch-manipulation"
                                  aria-label={`Remove ${e.name}`}
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                        </ul>
                      </div>
                    )}
                    <div className="mt-3 pt-3 border-t border-ppp-charcoal-100">
                      <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500 mb-2">
                        Add custom item (not in catalog)
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addCustomExtra();
                            }
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
                            value={customQty}
                            onChange={(e) => setCustomQty(e.target.value)}
                            placeholder="qty"
                            className="w-16 sm:w-14 px-2 py-2.5 sm:py-2 text-base sm:text-sm text-right border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue font-mono"
                          />
                          <input
                            type="text"
                            value={customUnit}
                            onChange={(e) => setCustomUnit(e.target.value)}
                            placeholder="unit"
                            autoCapitalize="none"
                            autoCorrect="off"
                            className="w-20 sm:w-16 px-2 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
                          />
                          <button
                            type="button"
                            onClick={addCustomExtra}
                            disabled={!customName.trim()}
                            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 active:bg-ppp-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                      <p className="text-[10px] text-ppp-charcoal-500 mt-1.5 leading-snug">
                        Add multiple by entering each one and clicking Add (or pressing Enter).
                        Examples: &ldquo;1 gallon Behr primer&rdquo;, &ldquo;painter&apos;s plastic (12&apos; x 400&apos;)&rdquo;.
                      </p>
                    </div>
                  </Section>

                  {/* Special instructions */}
                  <Section title="Special instructions">
                    <textarea
                      value={specialInstructions}
                      onChange={(e) => setSpecialInstructions(e.target.value)}
                      rows={2}
                      placeholder="e.g. Customer prefers AM delivery. Garage code in scheduling notes."
                      className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
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
                          // text-sm on mobile keeps iOS from auto-zooming when admin
                          // proofreads + the body stays readable on a phone; reverts
                          // to text-xs on sm+ to fit more lines without scrolling.
                          "w-full px-3 py-2 text-sm sm:text-xs font-mono border rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue leading-relaxed transition-opacity",
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
                className="px-4 py-2 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors"
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
                  className="px-3.5 py-2 min-h-[44px] sm:min-h-0 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
                >
                  Cancel
                </button>
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={handleCopy}
                    disabled={!draft || sending}
                    className="px-3.5 py-2 min-h-[44px] sm:min-h-0 rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
                  >
                    {copied ? "✓ Copied" : "Copy to Clipboard"}
                  </button>
                  {copyError && (
                    <span className="text-[11px] text-ppp-orange-700 max-w-xs text-right" role="alert">
                      {copyError}
                    </span>
                  )}
                </div>
              </div>
              {/* Phone-only suppliers (Janovic) — replace Send button with a
                  Call CTA. The order content is still composed (so admin can
                  use Copy to phone the PO over verbally) but no email goes
                  out. */}
              {draft?.phoneOnly ? (
                <div className="flex flex-col items-end gap-1">
                  {draft.phoneNumber ? (
                    <a
                      href={`tel:${draft.phoneNumber.replace(/[^0-9+]/g, "")}`}
                      className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-700 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
                      </svg>
                      Call {draft.phoneNumber}
                    </a>
                  ) : (
                    <span
                      className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-charcoal-100 text-ppp-charcoal-500 text-sm font-semibold cursor-not-allowed"
                      title="Add this supplier's phone number in Settings → Suppliers"
                    >
                      Phone number not set
                    </span>
                  )}
                  <span className="text-[10px] text-ppp-charcoal-500 max-w-xs text-right">
                    {supplierName} takes phone orders only. Use Copy above + read it to them.
                  </span>
                </div>
              ) : (() => {
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
                    className="px-4 py-2 min-h-[44px] sm:min-h-0 rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
        // min-h-[44px] iOS HIG floor on mobile; collapses to natural height
        // on desktop. Delivery/Pickup toggle is a primary action — gets the
        // full thumb-reach surface on phones.
        "text-left px-3 py-2.5 min-h-[44px] sm:min-h-0 rounded-lg border text-xs transition-colors touch-manipulation",
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
        className="mt-3 w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
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
        className="w-full px-3 py-2.5 sm:py-2 min-h-[44px] sm:min-h-0 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
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
          className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 focus:border-ppp-blue"
        />
      )}
    </div>
  );
}
