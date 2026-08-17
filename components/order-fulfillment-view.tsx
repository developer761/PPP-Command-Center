"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { isNycAddress } from "@/lib/supplier-order/nyc-zips";
import type { OrderBuildPayload } from "@/lib/supplier-order/build-state";

/**
 * FULFILMENT — stage two of the Order Materials split (Kate round-3 #18).
 *
 * Deliberately short. It decides HOW the order arrives — required-by date,
 * delivery or pickup, instructions — and sends the email. It reads the
 * committed order payload and never writes it: that one-way flow is what stops
 * a delivery-address edit from resetting the quantities somebody just typed
 * (#22), and it means the paint line can't fall out of the email on the way
 * here (#23).
 */

type DeliveryAddress = {
  name: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  source: "customer_form" | "sf_account" | "manual";
};

type Draft = {
  poNumber: string;
  subject: string;
  body: string;
  lineItems: Array<Record<string, unknown>>;
  unresolvedAddress: boolean;
  deliveryAddress: DeliveryAddress | null;
  requiredByDate: string;
  sentToEmail: string | null;
  pickupLocations: Array<{ name: string; address: string }>;
  phoneOnly?: boolean;
  phoneNumber?: string | null;
  pickupDefault?: boolean;
};

/**
 * Today in PPP's timezone, as yyyy-mm-dd.
 *
 * Eastern, not the viewer's local zone. PPP operates Eastern and the other 29
 * "today" call sites in this codebase all use this exact form — a second
 * convention is how a date ends up meaning two different days in two places.
 * The earlier version here derived the viewer's local day, so a laptop set to
 * Pacific could offer a required-by date that is already yesterday in the
 * office.
 */
function todayEtISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default function OrderFulfillmentView({
  workOrderId,
  workOrderNumber,
  customerName,
  supplierAccountId,
  supplierName,
  build,
  committed,
  persistenceAvailable,
  viewerName,
  viewerPhone,
}: {
  workOrderId: string;
  workOrderNumber: string | null;
  customerName: string | null;
  supplierAccountId: string;
  supplierName: string;
  build: OrderBuildPayload;
  /** False when the worker never advanced through the builder — we let them
   *  send anyway (never hard-reject) but say what's missing. */
  committed: boolean;
  /** False when saved order state is unavailable (migration 144 pending or the
   *  table unreachable). The order payload then arrives EMPTY, so the email
   *  would go out from bare estimates — that has to be said out loud, not
   *  discovered by the supplier. */
  persistenceAvailable: boolean;
  viewerName: string | null;
  viewerPhone: string | null;
}) {
  const woLabel = workOrderNumber ?? workOrderId.slice(-6);
  const today = todayEtISO();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [fulfillment, setFulfillment] = useState<"delivery" | "pickup">("delivery");
  const adminTouchedFulfillment = useRef(false);
  const [pickupLocation, setPickupLocation] = useState("");
  const [deliveryAddr, setDeliveryAddr] = useState({ street: "", city: "", state: "", postalCode: "" });
  const [useCustomAddress, setUseCustomAddress] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [requiredBy, setRequiredBy] = useState("");
  // Kate round-3 #29: defaults to the signed-in user's stored number, editable
  // per order, never written back to their profile.
  const [contactPhone, setContactPhone] = useState(viewerPhone ?? "");
  const [editedBody, setEditedBody] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    null | { ok: true; poNumber: string; sentToEmail: string } | { ok: false; error: string }
  >(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const sendInFlight = useRef(false);

  /* ── Draft ─────────────────────────────────────────────────────────────
   * Rebuilt when a FULFILMENT input changes. The order half of the request is
   * the committed payload, passed through verbatim every time — so a rebuild
   * can no longer lose the worker's quantities.
   *
   * The order half is serialised ONCE and the effect reads that string, never
   * the `build` object. `build` arrives from the server component and its
   * identity is stable in practice — but an object dependency that ever stopped
   * being stable would refetch on every render: an unbounded loop of
   * Salesforce-backed draft builds. A string dependency cannot do that, and it
   * keeps the dependency list honest rather than suppressed.
   */
  const orderPayloadJson = useMemo(
    () =>
      JSON.stringify({
        extras: build.extras,
        materialType: build.mainMaterialType || undefined,
        materialTypeOverrides:
          Object.keys(build.materialTypeOverrides).length > 0 ? build.materialTypeOverrides : undefined,
        quantityOverrides: Object.keys(build.quantities).length > 0 ? build.quantities : undefined,
        customColorItems: build.customColorItems,
        colorNotes: build.colorNotes ?? undefined,
      }),
    [build]
  );
  useEffect(() => {
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
            supplierAccountId,
            manualSupplier: true,
            fulfillmentMethod: fulfillment,
            pickupLocation: fulfillment === "pickup" ? pickupLocation : undefined,
            manualDeliveryAddress:
              fulfillment === "delivery" && deliveryAddr.street.trim() ? deliveryAddr : undefined,
            specialInstructions: instructions.trim() || undefined,
            requiredByDate: requiredBy.trim() || undefined,
            contactName: viewerName ?? undefined,
            contactPhone: contactPhone.trim() || undefined,
            // ── committed order state, read-only from here ──
            ...(JSON.parse(orderPayloadJson) as Record<string, unknown>),
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setDraftError(data.message ?? data.error ?? `HTTP ${res.status}`);
          setDraft(null);
        } else {
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
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [
    workOrderId, supplierAccountId, fulfillment, pickupLocation, deliveryAddr,
    instructions, requiredBy, contactPhone, viewerName, orderPayloadJson,
  ]);

  // Whether this delivery address is in the five boroughs. Derived, not stored
  // — holding it in state meant writing state from an effect on every draft,
  // which cascades a render for a value that is a pure function of the draft.
  const isNycDelivery = useMemo(
    () => (draft ? isNycAddress(draft.deliveryAddress) : false),
    [draft]
  );

  // Pickup default: supplier-level setting, or an NYC delivery address. The
  // worker's own choice always wins once they've touched the toggle.
  useEffect(() => {
    if (!draft) return;
    if ((draft.pickupDefault || isNycDelivery) && !adminTouchedFulfillment.current && fulfillment !== "pickup") {
      setFulfillment("pickup");
    }
  }, [draft, isNycDelivery, fulfillment]);

  // Kate round-3 #32: never offer a required-by date in the past. The computed
  // default can be historic on an old work order, so clamp what we show.
  const requiredByValue = useMemo(() => {
    const raw = requiredBy || (draft?.requiredByDate ?? "").slice(0, 10);
    if (!raw) return "";
    return raw < today ? today : raw;
  }, [requiredBy, draft, today]);

  const bodyToSend = editedBody ?? draft?.body ?? "";

  const handleCopy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(`Subject: ${draft?.subject ?? ""}\n\n${bodyToSend}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setCopyError(
        `Couldn't copy automatically — select the email body and Cmd/Ctrl+C. (${err instanceof Error ? err.message : String(err)})`
      );
      setTimeout(() => setCopyError(null), 5000);
    }
  };

  const handleSend = async () => {
    if (!draft || sending || sendInFlight.current) return;
    if (!draft.sentToEmail) return;
    sendInFlight.current = true;
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
          requiredByDate: requiredByValue || draft.requiredByDate,
          lineItems: draft.lineItems,
          extras: build.extras,
          specialInstructions: instructions.trim() || null,
          materialType: build.mainMaterialType || undefined,
          materialTypeOverrides:
            Object.keys(build.materialTypeOverrides).length > 0 ? build.materialTypeOverrides : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setSendResult({ ok: false, error: data.message ?? data.error ?? `HTTP ${res.status}` });
      } else {
        setSendResult({ ok: true, poNumber: data.poNumber, sentToEmail: data.sentToEmail });
      }
    } catch (err) {
      setSendResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
      sendInFlight.current = false;
    }
  };

  const builderHref = `/dashboard/materials/${encodeURIComponent(workOrderId)}/order`;

  if (sendResult?.ok === true) {
    return (
      <div className="max-w-lg mx-auto text-center py-12">
        <div className="mx-auto h-14 w-14 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-4">
          ✓
        </div>
        <h1 className="text-xl font-bold text-ppp-navy">Order sent</h1>
        <p className="mt-2 text-sm text-ppp-charcoal-500">
          {sendResult.poNumber} delivered to{" "}
          <strong className="text-ppp-charcoal break-all">{sendResult.sentToEmail}</strong>
        </p>
        <Link
          href={`/dashboard/materials/${encodeURIComponent(workOrderId)}`}
          className="mt-6 inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors"
        >
          Back to work order
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-4 max-w-3xl">
      <div>
        <Link
          href={builderHref}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline"
        >
          <span aria-hidden>←</span> Back to the order
        </Link>
        <h1 className="mt-2 text-xl sm:text-2xl font-condensed font-bold text-ppp-navy">Fulfilment</h1>
        <p className="text-xs text-ppp-charcoal-500 mt-1">
          {customerName ?? "(unknown customer)"} · WO {woLabel} · {supplierName}
          {draft && <> · <span className="font-mono">{draft.poNumber}</span></>}
          {" "}· Step 2 of 2
        </p>
      </div>

      {!persistenceAvailable && (
        <div role="alert" className="bg-ppp-orange-50 border border-ppp-orange-200 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
          <strong className="block">This order couldn&apos;t be loaded from saved state.</strong>
          Quantities, paint lines and extras you set on the build step are NOT included below —
          the email would go out from system estimates only. Check the email body carefully before
          sending, or ask Karan to apply migration 144.
        </div>
      )}
      {persistenceAvailable && !committed && (
        <div className="bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-4 py-3 text-xs text-ppp-blue-700">
          You came straight to fulfilment, so this order uses whatever was last saved on the build
          step. <Link href={builderHref} className="underline font-semibold">Check what you&apos;re buying</Link> if
          you haven&apos;t already.
        </div>
      )}

      {draftError && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3 text-xs text-ppp-orange-700">
          Couldn&apos;t build the email: {draftError}
        </div>
      )}
      {sendResult?.ok === false && (
        <div className="bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-3">
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
      {draft && !draft.sentToEmail && (
        <div className="bg-ppp-blue-50 border border-ppp-blue-100 rounded-lg px-4 py-3 text-xs text-ppp-blue-700">
          <strong>Order email not set for {supplierName} yet.</strong> Set it in Settings → Suppliers,
          or copy the email below and paste it into Gmail.
        </div>
      )}

      {/* Required by (#24 / #32) */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ppp-charcoal">Required by</h2>
          <p className="text-[11px] text-ppp-charcoal-500">
            When the vendor needs to fulfil it. Shows on the order email.
          </p>
        </div>
        <input
          type="date"
          value={requiredByValue}
          min={today}
          onChange={(e) => setRequiredBy(e.target.value)}
          aria-label="Required-by date"
          className="ml-auto rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-sm text-ppp-charcoal focus:outline-none focus:ring-2 focus:ring-ppp-blue-400 min-h-[44px]"
        />
      </section>

      {/* Fulfilment method */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
        <h2 className="text-sm font-semibold text-ppp-charcoal mb-2">Delivery or pickup</h2>
        {isNycDelivery && fulfillment === "pickup" && (
          <div className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ppp-blue-50 border border-ppp-blue-100 text-[11px] font-medium text-ppp-blue-700">
            <span aria-hidden>🗽</span>
            NYC address — defaulted to pickup (delivery often unavailable in the city)
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <FulfillmentChoice
            selected={fulfillment === "delivery"}
            onSelect={() => { adminTouchedFulfillment.current = true; setFulfillment("delivery"); }}
            title="Deliver to customer"
            description={
              draft?.deliveryAddress
                ? `${draft.deliveryAddress.street}, ${draft.deliveryAddress.city}${draft.deliveryAddress.state ? ", " + draft.deliveryAddress.state : ""}`
                : "No address on file — add one below"
            }
            sourceLabel={
              draft?.deliveryAddress?.source === "customer_form" ? "From customer form"
                : draft?.deliveryAddress?.source === "sf_account" ? "From SF Account"
                : undefined
            }
          />
          <FulfillmentChoice
            selected={fulfillment === "pickup"}
            onSelect={() => { adminTouchedFulfillment.current = true; setFulfillment("pickup"); }}
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

        {fulfillment === "delivery" && draft && !draft.unresolvedAddress && (
          <div className="mt-2 text-right">
            <button
              type="button"
              onClick={() =>
                setUseCustomAddress((v) => {
                  const next = !v;
                  if (!next) setDeliveryAddr({ street: "", city: "", state: "", postalCode: "" });
                  return next;
                })
              }
              className="text-xs text-ppp-blue-700 hover:text-ppp-blue-800 font-medium hover:underline px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
            >
              {useCustomAddress
                ? "↺ Use the customer address instead"
                : "Deliver to a different address (e.g. crew location) →"}
            </button>
          </div>
        )}

        {fulfillment === "delivery" && draft && (draft.unresolvedAddress || useCustomAddress) && (
          <div className="mt-3 rounded-lg border border-ppp-orange-100 bg-ppp-orange-50/60 p-3">
            <div className="text-[11px] font-semibold text-ppp-orange-700 mb-2">
              {useCustomAddress
                ? "Manual delivery address — overrides the customer address for this order only."
                : "No delivery address on file — enter it and it'll drop into the email."}
            </div>
            <div className="space-y-2">
              <input
                type="text"
                value={deliveryAddr.street}
                onChange={(e) => setDeliveryAddr((a) => ({ ...a, street: e.target.value }))}
                placeholder="Street address"
                className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
              />
              <div className="grid grid-cols-2 sm:grid-cols-[1fr_auto_auto] gap-2">
                <input
                  type="text"
                  value={deliveryAddr.city}
                  onChange={(e) => setDeliveryAddr((a) => ({ ...a, city: e.target.value }))}
                  placeholder="City"
                  autoCapitalize="words"
                  className="px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                />
                <input
                  type="text"
                  value={deliveryAddr.state}
                  onChange={(e) => setDeliveryAddr((a) => ({ ...a, state: e.target.value }))}
                  placeholder="State"
                  maxLength={4}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  className="w-20 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={deliveryAddr.postalCode}
                  onChange={(e) => setDeliveryAddr((a) => ({ ...a, postalCode: e.target.value }))}
                  placeholder="ZIP"
                  maxLength={10}
                  autoCorrect="off"
                  className="w-24 px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Contact (#29) */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ppp-charcoal">Who the supplier should call</h2>
          <p className="text-[11px] text-ppp-charcoal-500">
            {viewerName ? `${viewerName} — ` : ""}
            {viewerPhone
              ? "your saved number. Change it for this order without changing your default."
              : "you haven't saved a number yet — add one in Settings → Access so it fills in next time."}
          </p>
        </div>
        <input
          type="tel"
          inputMode="tel"
          value={contactPhone}
          onChange={(e) => setContactPhone(e.target.value)}
          placeholder="(631) 555-0134"
          aria-label="Contact phone for this order"
          className="ml-auto w-48 rounded-lg border border-ppp-charcoal-200 px-2.5 py-1.5 text-base sm:text-sm min-h-[44px] focus:outline-none focus:ring-2 focus:ring-ppp-blue-400"
        />
      </section>

      {/* Fulfilment instructions */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
        <label htmlFor="fulfilment-instructions" className="text-sm font-semibold text-ppp-charcoal block mb-1">
          Fulfilment instructions
        </label>
        <textarea
          id="fulfilment-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          placeholder="e.g. Customer prefers AM delivery. Garage code in scheduling notes."
          className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
        />
      </section>

      {/* Email body */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <h2 className="text-sm font-semibold text-ppp-charcoal">Email body</h2>
          <span className="text-[11px] text-ppp-charcoal-500 truncate">
            {loadingDraft ? "Updating with your changes…" : draft?.subject ? `Subject: ${draft.subject}` : ""}
          </span>
        </div>
        <div className="relative">
          <textarea
            value={editedBody ?? draft?.body ?? ""}
            onChange={(e) => setEditedBody(e.target.value)}
            rows={16}
            className={`w-full px-3 py-2 text-base sm:text-xs font-mono border rounded-lg leading-relaxed focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 ${
              loadingDraft && editedBody === null ? "border-ppp-blue-100 opacity-70" : "border-ppp-charcoal-100"
            }`}
          />
          {loadingDraft && editedBody === null && (
            <div className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-[10px] text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 px-2 py-0.5 rounded-full">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ppp-blue animate-pulse" />
              Updating
            </div>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-ppp-charcoal-500 gap-2">
          <span>
            {editedBody !== null
              ? "Editing manually — fulfilment changes won't update this body."
              : "Edit any line before sending. Fulfilment changes update this automatically."}
          </span>
          {editedBody !== null && (
            <button
              type="button"
              onClick={() => setEditedBody(null)}
              className="text-ppp-blue hover:text-ppp-blue-700 underline shrink-0"
            >
              Reset to auto-generated
            </button>
          )}
        </div>
      </section>

      {/* Actions */}
      <div
        // STICKY, not fixed — the desktop sidebar is a normal flex child of the
        // shell, so a viewport-width fixed bar sits on top of it.
        className="sticky bottom-0 z-30 -mx-4 sm:-mx-6 lg:-mx-8 bg-white border-t border-ppp-charcoal-100 px-4 sm:px-6 lg:px-8 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Link
              href={builderHref}
              className="px-3.5 py-2 min-h-[44px] inline-flex items-center rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors"
            >
              Back
            </Link>
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={handleCopy}
                disabled={!draft || sending}
                className="px-3.5 py-2 min-h-[44px] rounded-lg border border-ppp-charcoal-100 text-sm font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 transition-colors disabled:opacity-60"
              >
                {copied ? "✓ Copied" : "Copy to Clipboard"}
              </button>
              {copyError && (
                <span className="text-[11px] text-ppp-orange-700 max-w-xs" role="alert">{copyError}</span>
              )}
            </div>
          </div>

          {draft?.phoneOnly ? (
            <div className="flex flex-col items-end gap-1">
              {draft.phoneNumber ? (
                <a
                  href={`tel:${draft.phoneNumber.replace(/[^0-9+]/g, "")}`}
                  className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-700 transition-colors"
                >
                  Call {draft.phoneNumber}
                </a>
              ) : (
                <span className="inline-flex items-center px-4 py-2 min-h-[44px] rounded-lg bg-ppp-charcoal-100 text-ppp-charcoal-500 text-sm font-semibold cursor-not-allowed">
                  Phone number not set
                </span>
              )}
              <span className="text-[10px] text-ppp-charcoal-500 max-w-xs text-right">
                {supplierName} takes phone orders only. Copy the order and read it to them.
              </span>
            </div>
          ) : (() => {
            const blockedForEmail = !draft?.sentToEmail;
            const blockedForAddress = fulfillment === "delivery" && !!draft?.unresolvedAddress;
            const disabled = !draft || sending || blockedForEmail || blockedForAddress;
            return (
              <button
                type="button"
                onClick={handleSend}
                disabled={disabled}
                title={
                  blockedForEmail
                    ? `Set ${supplierName}'s order email in Settings → Suppliers first`
                    : blockedForAddress
                      ? "Add a delivery address before sending (or switch to Pickup)"
                      : ""
                }
                className="px-4 py-2 min-h-[44px] max-w-full inline-flex items-center justify-center rounded-lg bg-ppp-blue text-white text-sm font-semibold hover:bg-ppp-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="truncate">
                  {sending ? "Sending…"
                    : blockedForEmail ? "Send (email not set)"
                    : draft?.sentToEmail ? `Send to ${draft.sentToEmail}`
                    : "Send"}
                </span>
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function FulfillmentChoice({
  selected, onSelect, title, description, sourceLabel,
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
        "text-left px-3 py-2.5 min-h-[44px] rounded-lg border text-xs transition-colors touch-manipulation",
        selected ? "bg-ppp-blue-50 border-ppp-blue ring-2 ring-ppp-blue/20" : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50",
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
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 pl-4 truncate">{description}</div>
    </button>
  );
}

function PickupLocationPicker({
  locations, value, onChange,
}: {
  locations: Array<{ name: string; address: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  const OTHER = "__other__";
  const formatted = (loc: { name: string; address: string }) =>
    loc.address ? `${loc.name} · ${loc.address}` : loc.name;

  useEffect(() => {
    if (locations.length === 1 && !value) onChange(formatted(locations[0]));
  }, [locations, value, onChange]);

  if (locations.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. BM Smithtown · 123 Main St"
        className="mt-3 w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
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
        aria-label="Pickup location"
        className="w-full px-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
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
          className="w-full px-3 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
        />
      )}
    </div>
  );
}
