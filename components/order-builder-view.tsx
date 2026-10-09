"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LineItemNotes from "@/components/line-item-notes";
import { inBuyList, isOfferOnOrder, nextCustomColorId, offerIdentity, orderableQty } from "@/lib/supplier-order/color-note-items";
import type { ColorNoteOffer } from "@/lib/supplier-order/color-note-parse";
import { formatRoomDimensions } from "@/lib/supplier-order/room-dimensions";
import { groupExtras } from "@/lib/supplier-order/extras-groups";
import MaterialTypePicker from "@/components/material-type-picker";
import SupplierPickList, { type ActiveSupplier } from "@/components/supplier-pick-list";
import {
  claimedPlainKeys,
  readProductOverride,
  formatOrderQuantity,
  formatBucketsCans,
  containerCount,
  stepContainers,
  classifySurface,
  formatOrderTotal,
  summarizeOrder,
  addCustomItemsToTotal,
  quantityKey,
  convertUnit,
  unitCanHold,
  conversionShortfallGal,
  type GallonEstimate,
  type PaintUnit,
} from "@/lib/supplier-order/estimate-gallons";
import { PRIMER_MATERIAL_TYPES, PRIMER_MATERIAL_VALUES, PAINT_LINE_VALUES, materialTypeForVendor } from "@/lib/customer-form/material-types";
import { emptyBuildPayload, mergeBuildPayloads, pruneToLiveKeys, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import { draftDelayMs } from "@/lib/supplier-order/draft-timing";

/**
 * ORDER BUILDING — stage one of the Order Materials split (Kate round-3 #18).
 *
 * Everything that decides WHAT TO BUY lives here: the vendor, the paint line,
 * quantities, color notes, extras and worker-typed color lines. When the
 * worker advances, the payload is committed to `supplier_order_builds` and the
 * fulfillment page reads it back — it has no way to change any of it.
 *
 * That separation is the fix for a whole class of bugs Kate reported. In the
 * old single modal, every input change re-fetched the draft and the refetch
 * cleared the typed quantities, so adding an extra silently reverted the
 * numbers (#22), a per-color paint line arrived with "(PPP to confirm
 * quantities)" (#23), and the per-line row and the total disagreed about
 * whether a color still needed a manual quantity (#26).
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
  /** Floor area — Sq_Footage__c, i.e. width x length. */
  sqft: number;
  /** PAINTABLE wall area — Wall_Surface_Area__c when the rep measured it,
   *  else 0. Katie item 13 asked for both on the line: the floor area is
   *  what Salesforce holds, but the WALL area is what the gallons are
   *  computed from, and one figure alone leaves nothing to check. */
  wallSqft: number;
  /** Perimeter in linear feet — the measure that matters for TRIM, the way
   *  wall area matters for walls and floor area for a ceiling. 0 when the
   *  rep never captured it, and the estimator then derives 4x root(floor). */
  perimeterLf: number;
  /** Room height, feet — 0 when Salesforce never captured it. Shown only when
   *  real: the gallon maths defaults a missing height to 8, and printing that
   *  as a measurement claims knowledge we do not have. */
  heightFt?: number;
  /** SF `Description` — the rep's scope notes on the quote line. PPP's field
   *  team adds ONE line item and lists the real rooms here, so without it this
   *  panel can read "1 line item" for a six-room job (Kate 2026-09-04). */
  notes?: string | null;
  /** SF `ColorNotes__c`, free text only. The per-surface COLORS — on a
   *  work order where a rep puts the whole house on one line, Description
   *  says "see notes for colors" and this is those notes (Katie item 23). */
  colorNotes?: string | null;
  /** Each color written in ColorNotes__c, one per entry, offered to the
   *  custom-item form — color notes never reach the vendor email (R4.14). */
  /** Offers parsed from Color Notes, each carrying the room heading it sat
   *  under and any trailing "(…)" instruction (Katie 2026-10-01). */
  colorNoteOffers?: ColorNoteOffer[];
  /** What the customer said that is not a thing to buy. */
  colorNoteRemarks?: string[];
};

export type PreviewColor = {
  id: string;
  name: string;
  code: string | null;
  hex: string | null;
  /** Where this color goes — room + surface, not a generic "Area" (#15). */
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
  /** R5.3 — the paint lines the EMAIL will carry, so this screen shows the same
   *  thing it is previewing rather than its own empty payload. Optional: an
   *  older cached draft response won't have them. */
  resolvedMaterialType?: string | null;
  resolvedMaterialTypeOverrides?: Record<string, string>;
  exteriorMaterialType?: string | null;
  /** Surfaces where Salesforce and the customer's submission name different
   *  colors. The order buys the customer's; Rooms & Colors shows Salesforce's.
   *  Optional: an older cached draft response won't carry them. */
  colorConflicts?: Array<{ roomLabel: string; surface: string; orderingName: string; salesforceName: string }>;
  /** Order-line key → paint manufacturer name. */
  colorBrands?: Record<string, string>;
  noColorsPicked: boolean;
};

/**
 * How long to wait after the payload settles before rebuilding the draft.
 *
 * Karan 2026-09-09: "when I add like a gallon there's a small delay to it."
 * Every +/- click lands in that effect's dependency list, and the request
 * behind it rebuilds the whole vendor email off a Salesforce snapshot. At
 * 150ms, someone stepping a quantity fires one of those between each press.
 *
 * The NUMBER has always been instant — it reads local payload state. What lags
 * is `estimates`, which comes back from this response, so the list re-renders
 * underneath the click. Waiting longer means one rebuild after the stepping
 * stops rather than a queue of them.
 */
// Debounce policy lives in lib/supplier-order/draft-timing.ts so it is
// testable by behavior rather than by grepping this file.

type ExtraCatalogItem = {
  id: string;
  name: string;
  unit: string;
  default_qty: number;
  sort_order: number;
};

const UNIT_PLURAL: Record<string, string> = { gal: "gallons", qt: "quarts", bucket: "buckets" };

export default function OrderBuilderView({
  workOrderId,
  workOrderNumber,
  customerName,
  sourceLines,
  initialPayload,
  initialSupplierId,
  persistenceAvailable,
  priorOrders = [],
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
  /** Orders already sent to a vendor for this work order. */
  priorOrders?: Array<{ poNumber: string | null; supplierAccountId: string; supplierName: string | null; sentAt: string | null }>;
}) {
  const router = useRouter();
  const woLabel = workOrderNumber ?? workOrderId.slice(-6);

  const [supplier, setSupplier] = useState<{ accountId: string; name: string } | null>(
    initialSupplierId ? { accountId: initialSupplierId, name: "" } : null
  );
  const [payload, setPayload] = useState<OrderBuildPayload>(initialPayload ?? emptyBuildPayload());
  /**
   * Set when Continue was refused for a missing product line (Katie 2026-10-01).
   *
   * Never cleared by answering ONE row. The banner and the red markers are
   * gated on `needProductLine` as well, so they shrink as each picker is
   * answered and vanish on their own when the last one is — which is the point
   * of marking twelve rows red. Clearing the flag on the first pick made the
   * other eleven markers disappear with it, taking away the only thing showing
   * which rows were still outstanding.
   */
  const [productLineError, setProductLineError] = useState(false);
  /** Bumped on every refusal, so the scroll-to-the-problem effect fires again
   *  when they press Continue a second time without fixing anything. */
  const [productLineNudge, setProductLineNudge] = useState(0);
  const buyListRef = useRef<HTMLDivElement | null>(null);
  // The draft is stamped with the supplier it was built FOR. Without that, the
  // moment you switch vendors you keep seeing the previous vendor's colors and
  // quantities until the refetch lands — briefly on a fast connection, visibly
  // on a slow one, and it looks like the vendor change didn't take.
  const [draft, setDraft] = useState<{ forSupplierId: string; data: Draft } | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  /** Which vendor we have already fetched a first draft for — see the effect. */
  const firstDraftDone = useRef<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [extrasError, setExtrasError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ExtraCatalogItem[]>([]);
  const [extrasSearch, setExtrasSearch] = useState("");
  const [advancing, setAdvancing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Kate 2026-10-07, mobile round: "Line items on this WO" collapsed by default.
   *
   * PHONE ONLY. Katie asked for the opposite on 2026-09-08 — all the way at the
   * top and not a dropdown — because the office checks the buy-list AGAINST the
   * source data. Both are right about their own screen: on a laptop the two sit
   * side by side in the eye, on a phone the source data is a wall you scroll
   * past to reach the numbers. So this state drives the phone only, and every
   * `lg:` below holds the desktop layout Katie asked for exactly as it was.
   */
  const [sourceLinesOpen, setSourceLinesOpen] = useState(false);
  // The server accepted the write but isn't keeping it (saved-order table
  // missing). Distinct from an error — nothing failed, it just won't survive,
  // and the next step will read an empty order.
  const [notPersisted, setNotPersisted] = useState(false);
  /** Which vendor the in-memory payload was loaded for. */
  const [loadedFor, setLoadedFor] = useState<string | null>(initialSupplierId);
  /** Just the id, so effects can depend on it without re-running when the
   *  vendor's NAME resolves a moment later. */
  const supplierId = supplier?.accountId ?? null;

  /* ── Persist ─────────────────────────────────────────────────────────────
   * Autosave is debounced and fire-and-forget; the commit on "Continue" is
   * awaited, because that one has to land before fulfillment reads it.
   *
   * The payload and supplier are passed IN rather than read from refs — refs
   * written during render are a cascading-render trap, and there's no need for
   * them here: every caller already has the current values in scope.
   */
  /** Monotonic save id. A slow save A and a fast save B can land out of
   *  order: B writes the row, then A writes the OLDER payload over it and its
   *  `.then` reports success. The debounce coalesces saves it has not sent
   *  yet; it does nothing about two in flight. */
  const saveSeq = useRef(0);

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

  /**
   * The payload as last WRITTEN (or as loaded, before anything was written).
   *
   * Merely OPENING the builder used to write the row 600ms later, and
   * `loadLatestBuildForWorkOrder` resumes by `updated_at` — so on a two-vendor
   * job, opening vendor A pinned A as "latest" and vendor B's half-built order
   * became unreachable by resume.
   *
   * It has to track every SAVE, not just the mount: baselined once, pressing
   * "+" then "−" returns the payload to a string identical to the baseline
   * while the row already holds the "+" — and the save that would put it back
   * is skipped. The screen then shows 4 gal over a row holding 5, and
   * fulfillment emails the 5.
   *
   * It also resets with the vendor, or vendor B is compared against A's
   * payload and written on open — the very thing this prevents.
   */
  const savedPayloadJson = useRef<string | null>(null);
  /** Same question as the ref, asked by the RENDER. A ref read while
   *  rendering is not a value React can be trusted to have re-rendered for —
   *  eslint flags it, and under a concurrent re-render the banner can disagree
   *  with what was actually written. State, set at the two moments the answer
   *  changes: a row came back from the server, or a save succeeded. */
  const [orderSaved, setOrderSaved] = useState(false);
  /** Why a unit toggle did nothing, on the line it was pressed on. */
  const [unitNote, setUnitNote] = useState<{ key: string; text: string } | null>(null);
  const payloadJson = JSON.stringify(payload);

  // Debounced autosave. Skipped until a supplier is chosen (the row is keyed by
  // work order + supplier).
  useEffect(() => {
    if (!supplier) return;
    // Don't write until the payload in memory is THIS vendor's.
    if (loadedFor !== supplier.accountId) return;
    const accountId = supplier.accountId;
    const snapshot = payload;
    // Identical to what the row already holds — do not write it again.
    if (savedPayloadJson.current !== null && savedPayloadJson.current === payloadJson) return;
    const t = setTimeout(() => {
      const seq = ++saveSeq.current;
      const written = JSON.stringify(snapshot);
      void save(accountId, snapshot, false).then((r) => {
        // A response from a save that has since been superseded says nothing
        // about the row's current state — neither its success nor its failure.
        if (seq !== saveSeq.current) return;
        if (!r.ok) { setSaveError(r.error); setNotPersisted(false); return; }
        // The row now holds THIS payload — that is the baseline from here.
        savedPayloadJson.current = written;
        setOrderSaved(true);
        setSaveError(null);
        setNotPersisted(!r.persisted);
      });
    }, 600);
    return () => clearTimeout(t);
  }, [payload, payloadJson, supplier, save, loadedFor]);

  /**
   * The save the debounce has not fired yet, when the page is going away.
   *
   * Stepping a quantity and clicking "← Back to work order" inside those 600ms
   * lost the edit silently — the symptom that started this batch ("sometimes I
   * add like gallons and stuff and it didn't like save").
   *
   * It MUST NOT be the autosave effect's own cleanup, which is what it was
   * first written as. That effect re-runs on every keystroke, so its cleanup
   * fired on every keystroke too — writing the payload as it stood BEFORE the
   * change. Press "+" then "−" inside one debounce and the vendor was sent the
   * "+" the estimator had just undone, because that stale write landed last
   * and left the baseline equal to the payload, so nothing wrote again.
   *
   * Keyed on the vendor alone, it runs only when the vendor changes or the
   * page unmounts, and reads the payload as it stands at that moment.
   */
  const flushState = useRef({ payload, payloadJson, loadedFor, save });
  useEffect(() => {
    flushState.current = { payload, payloadJson, loadedFor, save };
  });
  /** The same flush, but for "Change vendor": that handler clears the payload
   *  and the vendor together, so by the time the effect below tears down there
   *  is nothing left to write. Called BEFORE the reset, it saves vendor A's
   *  last 600ms instead of dropping them. */
  const flushNow = useCallback(() => {
    const st = flushState.current;
    if (!supplier || st.loadedFor !== supplier.accountId) return;
    if (savedPayloadJson.current === st.payloadJson) return;
    const seq = ++saveSeq.current;
    const written = st.payloadJson;
    void st.save(supplier.accountId, st.payload, false).then((r) => {
      if (seq === saveSeq.current && r.ok) savedPayloadJson.current = written;
    });
  }, [supplier]);

  const accountIdForFlush = supplier?.accountId;
  useEffect(() => {
    if (!accountIdForFlush) return;
    return () => {
      const st = flushState.current;
      // The payload in memory must still be THIS vendor's, and must differ
      // from what the row already holds.
      if (st.loadedFor !== accountIdForFlush) return;
      if (savedPayloadJson.current === st.payloadJson) return;
      const seq = ++saveSeq.current;
      const written = st.payloadJson;
      void st.save(accountIdForFlush, st.payload, false).then((r) => {
        if (seq === saveSeq.current && r.ok) {
          savedPayloadJson.current = written;
          setOrderSaved(true);
        }
      });
    };
  }, [accountIdForFlush]);


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
        // A 500/502/401 resolves normally — it does not throw — so the catch
        // below never saw the likeliest kind of failure, and the autosave was
        // armed anyway: 600ms later it PUT the payload this page had just
        // cleared over that vendor's saved order.
        if (!res.ok || data.ok === false) {
          throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
        }
        if (data.payload) {
          const saved = {
            ...(data.payload as OrderBuildPayload),
            // Keep the work order's paint line as the fallback for a vendor
            // that has no saved order yet (#24).
            mainMaterialType:
              (data.payload as OrderBuildPayload).mainMaterialType || initialPayload.mainMaterialType || "",
          };
          // MERGE, never replace: the buy-list rows come from a different
          // request, so the estimator can already have typed quantities into
          // them while this fetch was in flight. Replacing threw those away —
          // and on a new order the saved payload is empty, so they vanished
          // with no trace at all.
          setPayload((cur) => mergeBuildPayloads(saved, cur));
          setOrderSaved(true);
          // The baseline is what the ROW holds — the saved payload alone, not
          // the merge above. Recording the merge is what made the merge
          // pointless: a quantity typed while this fetch was in flight was
          // preserved on screen and then declared already-saved, so the
          // autosave never wrote it and navigating away lost it. That is the
          // symptom this whole batch started from ("sometimes I add like
          // gallons and stuff and it didn't like save to the email").
          //
          // Left NULL when the vendor has no saved order at all, so the first
          // autosave writes whatever is in memory — including custom color
          // items typed before a vendor was even picked.
          savedPayloadJson.current = JSON.stringify(mergeBuildPayloads(saved, emptyBuildPayload()));
        }
        if (!cancelled) setLoadedFor(supplier.accountId);
      } catch (err) {
        // Do NOT arm the autosave on a failed load. Picking a vendor clears the
        // payload, so arming it here meant a blip on this one fetch let the
        // 600ms autosave PUT an EMPTY payload over that vendor's saved order —
        // quantities, extras and custom lines gone, with only a console
        // warning. Leaving `loadedFor` unset keeps the autosave shut until a
        // load succeeds, and the retry is a page refresh.
        console.warn("[order-builder] couldn't load this vendor's saved order:", err);
        if (!cancelled) {
          setSaveError(
            "Couldn't load this vendor's saved order, so nothing is being saved yet. Refresh the page before building it."
          );
        }
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
        const res = await fetch("/api/suppliers/active", { cache: "no-store" });
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

  /* ── Extras catalog ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      // A vendor's catalog is that vendor's. Leaving the previous one on
      // screen while the new one loads (or fails) let A-only sundries be
      // ticked onto B's order.
      setCatalog([]);
      setExtrasError(null);
      try {
        const res = await fetch(
          `/api/admin/supplier-order/extras?supplierAccountId=${encodeURIComponent(supplierId)}`
        );
        const data = await res.json();
        if (cancelled) return;
        // The route answers 500 with `{ok:false, extras: []}`, and checking
        // only "is it an array" turned that into an empty catalog: the panel
        // read "No matches." and a worker would conclude PPP stocks nothing.
        if (!res.ok || data?.ok === false) {
          setExtrasError(data?.message ?? data?.error ?? `HTTP ${res.status}`);
          return;
        }
        setExtrasError(null);
        if (Array.isArray(data?.extras)) setCatalog(data.extras);
      } catch (err) {
        console.warn("[order-builder] extras fetch failed:", err);
        // A THROWN fetch — offline, DNS, a dropped connection, the ordinary
        // case on a phone — used to leave the panel reading "No matches.",
        // which is the very thing the ok===false branch above was added to
        // stop. Both paths say the same thing now.
        if (!cancelled) setExtrasError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

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
    // The ID, not the object: the resume effect replaces `supplier` with an
    // identical-id object once the vendor's NAME arrives, and depending on the
    // object cancelled the 0ms first draft and paid for a second full
    // Salesforce-backed rebuild — undoing the delay fix draft-timing.ts exists
    // for. Nothing in here needs the name.
    const accountId = supplierId;
    if (!accountId) return;
    let cancelled = false;
    // The debounce exists to coalesce typing, but it was also charged to the
    // FIRST load — so opening the builder sat on an empty panel for 600ms
    // before the request even left the browser, on top of the round trip.
    // Karan 2026-09-09: "to pop up the build your order when getting onto this
    // page… takes like 5 seconds." Nothing to coalesce on the first draft for
    // a vendor, so fire it immediately and debounce only the edits after it.
    const isFirstForSupplier = firstDraftDone.current !== accountId;
    const t = setTimeout(async () => {
      firstDraftDone.current = accountId;
      setLoadingDraft(true);
      setDraftError(null);
      try {
        const res = await fetch("/api/admin/supplier-order/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workOrderId,
            supplierAccountId: accountId,
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
          const built = data.draft as Draft;
          setDraft({ forSupplierId: accountId, data: built });
          // Retire keys no line claims any more, now that this vendor's real
          // line-up is known. Without it the pre-split fallback stops being a
          // migration and becomes a trap: the hall's color changes, its saved
          // 4 gal is orphaned but never removed, nothing claims the plain key
          // — and the BATHROOM starts reading it, quantity and product both.
          setPayload((cur) =>
            pruneToLiveKeys(
              cur,
              built.gallonEstimates.map((e) => ({
                key: quantityKey(e.colorId, e.finish, e.isBathroom),
                legacyKey: e.isBathroom ? quantityKey(e.colorId, e.finish) : null,
              }))
            )
          );
        }
      } catch (err) {
        if (!cancelled) {
          setDraftError(err instanceof Error ? err.message : String(err));
          setDraft(null);
        }
      } finally {
        if (!cancelled) setLoadingDraft(false);
      }
    }, draftDelayMs(isFirstForSupplier));
    return () => { cancelled = true; clearTimeout(t); };
  }, [
    workOrderId,
    supplierId,
    payload.extras,
    payload.mainMaterialType,
    payload.materialTypeOverrides,
    payload.quantities,
    payload.customColorItems,
    payload.colorNotes,
  ]);

  // Only ever the draft built for the CURRENTLY selected vendor.
  const currentDraft = supplier && draft?.forSupplierId === supplier.accountId ? draft.data : null;
  // Memoised: `?? []` is a NEW array every render, which churns every memo and
  // effect that depends on it.
  const rawEstimates = useMemo(() => currentDraft?.gallonEstimates ?? [], [currentDraft]);

  /**
   * The buy-list in an order a person can follow.
   *
   * Karan 2026-09-09: "living room walls and accent walls should always be
   * close to each other… try using logic to always organize this page." The
   * list came out in whatever order the estimator's color map happened to
   * produce, so the Living Room's walls sat at the top and its accent wall
   * nine rows down — the two lines you most need to read together.
   *
   * Sorted by ROOM in the order Salesforce lists them (so the buy-list walks
   * the job the same way the source panel above it does), then by surface in
   * the order a room is actually painted. No headings: Karan asked for order,
   * not more chrome, and a heading per room would repeat the room name that is
   * already on every line.
   *
   * A color spanning rooms (trim across the living room and bathroom) sorts by
   * its FIRST room, so it sits with that room rather than floating.
   */
  const estimates = useMemo(() => {
    const roomRank = new Map(sourceLines.map((l, i) => [l.room, i]));
    const SURFACE_ORDER = ["walls", "accent", "ceiling", "trim", "door", "cabinet", "closet", "floor"];
    const surfaceRank = (label: string) => {
      const l = label.toLowerCase();
      const i = SURFACE_ORDER.findIndex((k) => l.includes(k));
      return i === -1 ? SURFACE_ORDER.length : i;
    };
    const firstRoom = (e: GallonEstimate) => {
      const rooms = e.placements?.length ? e.placements.flatMap((pl) => pl.rooms) : e.rooms;
      const ranks = rooms.map((r) => roomRank.get(r) ?? Number.MAX_SAFE_INTEGER);
      return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
    };
    const firstSurface = (e: GallonEstimate) => {
      const s = e.placements?.length ? e.placements.map((pl) => pl.surface) : e.surfaces;
      return s.length ? Math.min(...s.map(surfaceRank)) : SURFACE_ORDER.length;
    };
    return [...rawEstimates].sort(
      (a, b) =>
        firstRoom(a) - firstRoom(b) ||
        firstSurface(a) - firstSurface(b) ||
        a.colorName.localeCompare(b.colorName)
    );
  }, [rawEstimates, sourceLines]);

  /**
   * More than one paint brand on this job.
   *
   * A hand-picked store order includes EVERY color whatever the brand, which
   * is right — PPP buys Benjamin Moore and Sherwin-Williams from the same
   * counter. But on a job that really does span two brands, ordering from two
   * vendors gives each of them the whole list, and the job's paint is bought
   * twice unless the estimator zeroes the other brand's lines by hand. They
   * can only do that if they can see which is which.
   */
  const brandsOnJob = useMemo(() => {
    const names = new Set(Object.values(currentDraft?.colorBrands ?? {}));
    return names.size > 1 ? names : new Set<string>();
  }, [currentDraft]);

  // Plain keys a non-bathroom line owns on THIS job — see readForEstimate.
  // Derived from the same estimates the rows render from, so the UI and the
  // server (claimedPlainKeys in estimate-gallons) answer identically.
  const claimedPlain = useMemo(() => claimedPlainKeys(rawEstimates), [rawEstimates]);

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
  // A color added straight from a line's Color Notes. Functional update: two
  // quick taps on different rows must not drop the first one.
  // `extra` carries the sheen the note already named and where the color goes
  // (Kate 2026-10-06). The sundry adder below passes none, which is right —
  // a hand-typed line has no note to read them from.
  const addCustomColorItem = (
    label: string,
    qty: number,
    unit: string,
    extra?: { finish?: string | null; scope?: string | null }
  ) =>
    setPayload((cur) => ({
      ...cur,
      customColorItems: [
        ...cur.customColorItems,
        {
          id: nextCustomColorId(cur.customColorItems, label),
          label,
          qty,
          unit,
          // Only set when the note actually said so — an empty string here
          // would read as "the estimator cleared it" rather than "unknown".
          ...(extra?.finish ? { finish: extra.finish } : {}),
          ...(extra?.scope ? { scope: extra.scope } : {}),
        },
      ],
    }));

  /**
   * Read a per-color map for this line, tolerating a draft saved BEFORE the
   * bathroom split (2026-09-17), when a bathroom line was keyed like any other.
   * Without it the estimator's saved quantity — including a deliberate zero,
   * which means "do not buy this" — silently reverted to the estimate.
   *
   * The fallback is refused when ANOTHER line on this job owns that plain key.
   * On a job with the hall and the bathroom in one color — the shape the split
   * was built for — that key is the hall's own live key, and reading it here
   * had the bathroom show and order the hall's gallons.
   */
  function readForEstimate<T>(rec: Record<string, T>, e: GallonEstimate): T | undefined {
    const exact = rec[quantityKey(e.colorId, e.finish, e.isBathroom)];
    if (exact !== undefined) return exact;
    if (!e.isBathroom) return undefined;
    const plain = quantityKey(e.colorId, e.finish);
    return claimedPlain.has(plain) ? undefined : rec[plain];
  }

  /** Writing the new key retires the old one, so the row stops being read from
   *  two places — unless another line still owns it, in which case deleting it
   *  would wipe THAT line's saved quantity. */
  function withoutLegacyKey<T>(rec: Record<string, T>, e: GallonEstimate): Record<string, T> {
    if (!e.isBathroom) return rec;
    const legacy = quantityKey(e.colorId, e.finish);
    if (!(legacy in rec) || claimedPlain.has(legacy)) return rec;
    const next = { ...rec };
    delete next[legacy];
    return next;
  }

  const adjustQuantity = (e: GallonEstimate, delta: number) => {
    const key = quantityKey(e.colorId, e.finish, e.isBathroom);
    setPayload((cur) => {
      const existing = readForEstimate(cur.quantities, e);
      const unit: PaintUnit = existing?.unit ?? e.unit ?? "gal";
      const currentTotal = existing
        ? containerCount(existing)
        : (e.manualOnly ? 0 : containerCount({ buckets: e.buckets, cans: e.cans, unit }));
      // Steps CONTAINERS, not gallons: one more pail, one fewer quart. Going
      // through packageForUnit stepped a pail line by a gallon and the pail
      // rounding put it straight back, so "−" did nothing at all — on a button
      // that rendered enabled, forever.
      return {
        ...cur,
        quantities: {
          ...withoutLegacyKey(cur.quantities, e),
          [key]: stepContainers({ buckets: 0, cans: currentTotal, unit }, delta),
        },
      };
    });
  };

  const setUnit = (e: GallonEstimate, unit: PaintUnit) => {
    const key = quantityKey(e.colorId, e.finish, e.isBathroom);
    // Decided OUT HERE, not inside the setPayload updater: an updater must be
    // pure — React is free to run it twice — and this one has to set a note.
    const existing = readForEstimate(payload.quantities, e);
    const current = existing
      ?? (e.manualOnly
            ? { buckets: 0, cans: 0, unit }
            : { buckets: e.buckets, cans: e.cans, unit: e.unit ?? "gal" });
    // A unit that cannot hold this much paint would clamp at 99 containers and
    // send the vendor a short order without saying so — 40 gallons is 160
    // quarts. Leave the line alone and say why, rather than quietly change the
    // number. (Karan's rule: warn, never reject outright — the line still
    // orders exactly what it ordered, in the unit it already had.)
    if (!unitCanHold(current, unit)) {
      setUnitNote({ key, text: `That is more paint than 99 ${UNIT_PLURAL[unit]} — left in ${UNIT_PLURAL[current.unit ?? "gal"]}.` });
      return;
    }
    // Pails round DOWN (Karan 2026-09-18), so say what the change left behind
    // rather than letting two gallons vanish between one press and the vendor.
    const short = conversionShortfallGal(current, unit);
    setUnitNote(
      short > 0
        ? { key, text: `${convertUnit(current, unit).cans} ${UNIT_PLURAL[unit]} — ${short} gal short of the estimate, from stock. Press + for another.` }
        : (cur) => (cur && cur.key === key ? null : cur)
    );
    setPayload((cur) => ({
      ...cur,
      // The toggle converts VOLUME — 2 pails is 10 gallons — where the +/-
      // stepper steps containers. Conflating the two made "−" dead on a pail
      // line one week and turned 10 gallons into 2 the next.
      quantities: { ...withoutLegacyKey(cur.quantities, e), [key]: convertUnit(current, unit) },
    }));
  };

  const resetQuantity = (e: GallonEstimate) => {
    const key = quantityKey(e.colorId, e.finish, e.isBathroom);
    setPayload((cur) => {
      const next = { ...withoutLegacyKey(cur.quantities, e) };
      delete next[key];
      return { ...cur, quantities: next };
    });
  };

  const setLineFor = (e: GallonEstimate, value: string) => {
    const key = quantityKey(e.colorId, e.finish, e.isBathroom);
    setPayload((cur) => {
      const next = { ...withoutLegacyKey(cur.materialTypeOverrides, e) };
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

  /**
   * Karan, materials meeting: "caulk — we'll order individual tubes or a whole
   * case." A case is a different SKU at the counter, not a quantity of tubes,
   * so it is the UNIT that changes rather than the number. The persisted extra
   * already carries its own unit, so nothing downstream needs to learn a new
   * shape: the vendor email prints "2 case — DAP Alex Plus" instead of
   * "2 tube".
   */
  const setExtraUnit = (extraId: string, unit: string) => {
    setPayload((cur) => ({
      ...cur,
      extras: cur.extras.map((e) => (e.extraId === extraId ? { ...e, unit } : e)),
    }));
  };

  const removeExtra = (extraId: string) =>
    setPayload((cur) => ({ ...cur, extras: cur.extras.filter((e) => e.extraId !== extraId) }));

  const togglePrimer = (value: string) => {
    const id = `primer-${value.toLowerCase().replace(/\s+/g, "-")}`;
    toggleExtra({ id, name: value, unit: "gal", default_qty: 1 });
  };

  /**
   * The job's own product line — what a line falls back to when nobody picked
   * one for it, and what the EMAIL falls back to (builder.ts: `?? materialType`).
   *
   * Resolved upstream in priority order: the estimator's pick on this screen,
   * then the AM's or customer's pick on the entry form, then Salesforce's
   * Product_Lines__c on the work order. Empty means the job genuinely has none
   * and every line has to be answered individually.
   */
  const jobMaterialType = (currentDraft?.resolvedMaterialType ?? "").trim();

  /* ── Advance ───────────────────────────────────────────────────────────── */
  /**
   * Colors that would reach the vendor as "[NOT SET]".
   *
   * Katie, 2026-10-01: "Make product line selection required before they can
   * click 'Continue to sending'". Her email showed three lines reading
   * "[NOT SET]" — a vendor cannot fill those, so the order goes out needing a
   * phone call.
   *
   * Resolved the same way the EMAIL resolves it, not just "did they touch the
   * picker": an explicit pick, else the job default the picker shows as
   * "(from the job)". A line already covered by the default is answered.
   * Excluded colors are not being bought, so they are not asked about.
   */
  const needProductLine = estimates.filter((e) => {
    if (e.excluded) return false;
    // Resolve EXACTLY as builder.ts does for the email:
    //     readProductOverride(...) ?? materialType
    // It did not, and that is Kate's 2026-10-06 report. The email falls back to
    // the JOB's product line — the one resolved from the estimator's pick, then
    // the entry form, then Salesforce's Product_Lines__c — while this gate only
    // looked at the per-color overrides. So on any job carrying a product line,
    // every line the estimator hadn't touched individually would have emailed
    // correctly and was still refused with "Product line required".
    //
    // Which is also why "— Use default (no override) —" looked broken: it
    // cleared the override so the job default would apply, which is right, and
    // then this fired anyway. The option was fine; the gate was wrong.
    const picked = readProductOverride(payload.materialTypeOverrides, e) ?? "";
    const resolved =
      picked ||
      readForEstimate(currentDraft?.resolvedMaterialTypeOverrides ?? {}, e) ||
      jobMaterialType ||
      "";
    // A bare "Other" with nothing typed is the one that LOOKS answered and
    // prints "[NOT SET]" anyway — the trap Katie item 11 already named.
    return !materialTypeForVendor(resolved).trim();
  });

  /**
   * Custom color items heading for the vendor as "[NOT SET]".
   *
   * The gate above only ever looked at `estimates`, so a hand-typed line — or
   * one added from the color notes — sailed past it and printed [NOT SET] in
   * the email anyway. That is the line in Kate's 2026-10-06 screenshot, and it
   * is the exact outcome Katie's "make product line required" was asked to
   * prevent; the rule was just never applied to this half of the order.
   *
   * No job default to fall back on here: a hand-typed line has no work-order
   * scope to read one from.
   */
  const customNeedProductLine = (payload.customColorItems ?? []).filter(
    (c) => c.label.trim() && !materialTypeForVendor(c.materialType).trim()
  );
  const totalNeedProductLine = needProductLine.length + customNeedProductLine.length;

  // Scrolling from inside the click handler did not move the page: the button
  // sits in a sticky footer inside the dashboard's own scroll container, and
  // the call ran before React had committed the banner. An effect keyed on the
  // nudge counter runs after the commit, with the layout settled.
  useEffect(() => {
    if (productLineNudge === 0) return;
    // A beat, deliberately. Clicking the footer button makes the browser bring
    // the button itself back into view, and that scroll lands AFTER a
    // same-tick call — measured: the banner ended up 1,925px above the
    // viewport. Letting the focus scroll finish first and then moving is the
    // difference between the reader seeing the problem and seeing the button
    // that refused.
    const id = window.setTimeout(() => {
      // AUTO, not smooth. A smooth scroll animates for a few hundred ms and
      // the browser cancels it the moment anything else scrolls — which is
      // exactly what the footer button's own focus does. Measured both ways:
      // smooth left the banner 2,177px above the viewport, instant puts it at
      // the top of the screen.
      buyListRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    }, 80);
    return () => window.clearTimeout(id);
  }, [productLineNudge]);

  const handleAdvance = async () => {
    if (!supplier || advancing) return;
    // Katie 2026-10-01 — refuse, say why, and put them back where the problem
    // is. A message at the bottom of a long page about a control at the top is
    // a message nobody can act on, so this scrolls to the buy-list and turns
    // the offending pickers red.
    if (totalNeedProductLine > 0) {
      setProductLineError(true);
      // The button lives in a STICKY FOOTER. Left focused, the browser scrolls
      // it back into view and lands the reader at the bottom of the page —
      // which is where they already were, and the opposite of the point.
      // Blur it, then scroll on the next frame so the banner React is about to
      // insert is already measured. Instant, not smooth: a smooth scroll here
      // was still animating when the footer's own scroll undid it.
      (document.activeElement as HTMLElement | null)?.blur?.();
      setProductLineNudge((n) => n + 1);
      return;
    }
    // The load effect leaves `loadedFor` unset when the GET failed, precisely
    // so the autosave cannot write over a row we could not read. Continue used
    // the same payload through the door next to it — and stamped it committed.
    if (loadedFor !== supplier.accountId) {
      setSaveError(
        "This vendor's saved order hasn't loaded, so continuing would overwrite it. Refresh the page first."
      );
      return;
    }
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

  // Matches the vendor email exactly — custom color lines included (#28).
  const totals = addCustomItemsToTotal(summarizeOrder(estimates), payload.customColorItems);
  // A line still needs a human number when the estimator couldn't size it AND
  // the worker hasn't typed one. Because the server already folded the typed
  // quantities in, this is simply "what's left" — no second calculation to
  // disagree with the rows (#26).
  const needQty = estimates.filter(
    // A color the worker zeroed out on purpose is answered, not outstanding.
    (e) => !e.excluded && (e.manualOnly || (e.buckets === 0 && e.cans === 0))
  );


  /*
   * Kate 2026-10-07: vendor first on a phone.
   *
   * Desktop keeps `space-y-5` on a block container — the layout Katie signed
   * off, untouched. The phone gets a flex column with the same 20px gap, which
   * is what makes `order-*` mean anything; `gap-5` and `space-y-5` render
   * identically for block-level children, so this is a no-op above lg.
   *
   * Reordering is two `max-lg:order-first` marks rather than an order on every
   * child: flex items with equal order keep DOM order, so the header and the
   * vendor section tie at -9999 and resolve header-then-vendor, and everything
   * else stays at 0 in the order it is written. Add a section anywhere below
   * and it lands after the vendor on both screens, with nothing to remember.
   */
  return (
    <div className="pb-4 lg:space-y-5 max-lg:flex max-lg:flex-col max-lg:gap-5">
      {/* Header */}
      <div className="max-lg:order-first">
        <Link
          href={`/dashboard/materials/${encodeURIComponent(workOrderId)}`}
          className="inline-flex items-center gap-1.5 min-h-[44px] py-2 -my-2 text-xs font-medium text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline touch-manipulation"
        >
          <span aria-hidden>←</span> Back to work order
        </Link>
        <h1 className="mt-2 text-xl sm:text-2xl font-condensed font-bold text-ppp-navy">
          Build the order
        </h1>
        <p className="text-xs text-ppp-charcoal-500 mt-1">
          {customerName ?? "(unknown customer)"} · WO {woLabel} · Step 1 of 2 — decide what to buy, then continue to sending.
        </p>
        {/* An order for this work order has ALREADY gone to a vendor. Said
            plainly, because everything else on this page looks like a fresh
            order: the vendor is pre-selected and every quantity, extra and
            custom line is still filled in, so "Continue → Send" emails the
            whole thing a second time and the vendor ships the job twice.
            A warning, not a block — a second order is a real thing PPP does
            (a missed color, a change order), and it is their call. */}
        {priorOrders.length > 0 && (
          <div className="mt-2 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
            <strong className="font-semibold">
              {priorOrders.length === 1 ? "An order has already been sent for this work order." : `${priorOrders.length} orders have already been sent for this work order.`}
            </strong>{" "}
            {priorOrders.slice(0, 3).map((o, i) => (
              <span key={`${o.poNumber ?? o.supplierAccountId}-${i}`}>
                {i > 0 ? " · " : ""}
                {o.supplierName ?? "a vendor"}
                {o.poNumber ? ` (PO ${o.poNumber})` : ""}
                {o.sentAt ? ` on ${new Date(o.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}` : ""}
              </span>
            ))}
            {priorOrders.length > 3 ? ` · and ${priorOrders.length - 3} more` : ""}
            . Anything you send from here is an ADDITIONAL order — it does not
            replace what the vendor already has.
          </div>
        )}
        {!persistenceAvailable && (
          <p className="mt-2 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-3 py-2">
            Saved order state isn&apos;t switched on yet, so this order won&apos;t survive a page reload.
            Everything else works — finish the order in one go, or ask Karan to apply migration 144.
          </p>
        )}
      </div>

          <section id="preview" className="scroll-mt-4">
            {/* Katie item 9, 2026-09-08: "line items should be all the way at the
                top for material ordering and don't have it as a dropdown."
            
                This REVERSES R4.18, which collapsed the panel and put it last, on
                the grounds that an expanded copy of the source data pushed the
                buy-list off the first screen. The office's answer is that the
                source data is what they check the buy-list AGAINST, so it has to
                be visible before the numbers rather than after them.

                KATE 2026-10-07 ASKED FOR IT COLLAPSED AGAIN — and on a phone she
                is describing R4.18's problem exactly. The panel has now been
                flipped once already, so it is NOT flipped a third time: desktop
                below keeps Katie's always-open panel with no control at all, and
                only the phone collapses. Karan 2026-10-08: "for the phone follow
                kates rules the laptop should stay exactly as is."

                That is why there are two headers. The `hidden lg:block` one is
                the original markup, unchanged to the character, so the laptop
                cannot drift. The `lg:hidden` one is a real button, because a
                thing that opens has to be reachable by keyboard and announce
                whether it is open — which a styled div does not. */}
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="hidden lg:block px-4 py-2.5 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
                <span>
                  <span className="block text-[10px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
                    Source data (Salesforce)
                  </span>
                  <span className="block text-sm font-semibold text-ppp-charcoal">
                    Line items on this WO
                    <span className="ml-1.5 font-normal text-ppp-charcoal-500">({sourceLines.length})</span>
                  </span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSourceLinesOpen((v) => !v)}
                aria-expanded={sourceLinesOpen}
                aria-controls="source-lines-list"
                className="lg:hidden w-full text-left px-4 py-2.5 min-h-[44px] border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-3 touch-manipulation"
              >
                <span>
                  <span className="block text-[10px] uppercase font-condensed font-bold tracking-wider text-ppp-charcoal-500">
                    Source data (Salesforce)
                  </span>
                  <span className="block text-sm font-semibold text-ppp-charcoal">
                    Line items on this WO
                    <span className="ml-1.5 font-normal text-ppp-charcoal-500">({sourceLines.length})</span>
                  </span>
                </span>
                {/* The word, not only the chevron — a chevron alone leaves people
                    guessing which way means open. */}
                <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-ppp-blue-700">
                  {sourceLinesOpen ? "Hide" : "Show"}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={sourceLinesOpen ? "rotate-180 transition-transform" : "transition-transform"}
                    aria-hidden
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </button>
              <ul
                id="source-lines-list"
                className={`divide-y divide-ppp-charcoal-100 ${sourceLinesOpen ? "" : "hidden lg:block"}`}
              >
                {sourceLines.map((l) => (
                  <li key={l.id} className="px-4 py-2.5 text-xs">
                    {/* Kate round-3 #14: room AND surface identify the line. */}
                    <div className="font-semibold text-ppp-charcoal">{l.room}</div>
                    {l.surfaces.length > 0 && (
                      <div className="text-[11px] text-ppp-blue-700 mt-0.5">{l.surfaces.join(" · ")}</div>
                    )}
                    {/* Jason + Alex 2026-09-17: "Put the room dimensions
                        instead of the calculation surface area coverage (that
                        can be on the backend for us)." Salesforce holds floor
                        area and perimeter, so for a rectangular room the
                        dimensions are exact arithmetic — and where they are
                        not derivable the areas stay, rather than a guess. */}
                    <div className="text-ppp-charcoal-500 mt-0.5">
                      {(() => {
                        const dims = formatRoomDimensions(l.sqft, l.perimeterLf, l.heightFt);
                        const bits = [l.detail];
                        if (dims) bits.push(dims);
                        else {
                          if (l.sqft > 0) bits.push(`${l.sqft.toLocaleString()} sq ft floor`);
                          if (l.wallSqft > 0) bits.push(`${l.wallSqft.toLocaleString()} sq ft wall`);
                        }
                        return bits.filter(Boolean).join(" · ");
                      })()}
                    </div>
                    {/* Kate 2026-09-04 — the rooms the rep actually listed. */}
                    <LineItemNotes notes={l.notes} label="Scope" />
                    {/* Katie item 23 — the colors themselves, labelled apart from the
                        scope above so a reader can tell which is which. */}
                    <LineItemNotes notes={l.colorNotes} label="Colors" />
                    <ColorNoteOffers
                      room={l.room}
                      offers={l.colorNoteOffers ?? []}
                      remarks={l.colorNoteRemarks ?? []}
                      items={payload.customColorItems}
                      estimates={estimates}
                      onAdd={addCustomColorItem}
                    />
                  </li>
                ))}
                {sourceLines.length === 0 && (
                  <li className="px-4 py-4 text-xs text-ppp-charcoal-500 italic">No line items on this work order.</li>
                )}
              </ul>
            </div>

          </section>

      {/* ── Step 1: vendor. Inline pick list, not a pop-up (#18/#21). ─────── */}
      {/* max-lg:order-first — Kate's "vendor at the top" on phones only. See the
          comment on the container above for why it is an order and not a move. */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden max-lg:order-first">
        <div className="px-4 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)] flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-ppp-charcoal">Vendor</h2>
            <p className="text-[11px] text-ppp-charcoal-500">Who this order goes to.</p>
          </div>
          {supplier && (
            <button
              type="button"
              onClick={() => {
                // Drop the previous vendor's payload with the vendor. Without
                // this the merge on load would carry Sherwin's quantities onto
                // the Benjamin Moore order — the contamination the
                // load-replaces-payload code was there to prevent.
                // Don't drop the last 600ms of vendor A's order on the way out.
                flushNow();
                setPayload(emptyBuildPayload());
                setLoadedFor(null);
                savedPayloadJson.current = null;
                setOrderSaved(false);
                setSupplier(null);
              }}
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
            onPick={(s: ActiveSupplier) => {
              // Keep the custom color items typed before a vendor existed. The
              // Color Notes "Add" buttons sit in the source panel ABOVE the
              // vendor picker — deliberately, Katie item 9 — so on a fresh work
              // order they are the first thing a person can act on, and picking
              // a vendor then threw their work away without a word.
              setPayload((cur) => ({ ...emptyBuildPayload(), customColorItems: cur.customColorItems }));
              setLoadedFor(null);
              savedPayloadJson.current = null;
              setOrderSaved(false);
              setSupplier({ accountId: s.accountId, name: s.name });
            }}
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
          {/* Katie item 14, 2026-09-08: "get rid of default from the top of the
              form" — the single "Default paint product line" selector is gone.
              Each color carries its own product line below, which is what the
              vendor email prints per line. A job that mixes Ultra Spec and Regal
              had one control claiming to speak for both.
          
              `mainMaterialType` stays in the payload: orders already saved carry
              one, and the builder still honours it as a fallback so a stored
              order does not silently change what it sends. Nothing SETS it now. */}

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
          <div ref={buyListRef} className="scroll-mt-4">
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            {/* Katie 2026-10-01 — the refusal is explained HERE, at the control
                that has to change, because the button that refused is at the
                bottom of a long page. */}
            {productLineError && totalNeedProductLine > 0 && (
              /* Kate, 2026-10-07: "Invert the colors so the alert is the darker
                 red and the text is the lighter red so it stands out more."
                 Checked rather than swapped on sight — orange-50 on orange-700
                 is 5.51:1 in light and 8.02:1 in dark, both past AA. A straight
                 swap of the two tints would not have been: this codebase has
                 shipped a -600-on--50 pairing that failed. */
              <p role="alert" className="px-4 py-3 text-[12px] font-semibold text-ppp-orange-50 bg-ppp-orange-700 border-b border-ppp-orange-700">
                Product line required — {totalNeedProductLine === 1
                  ? "1 color has no product line."
                  : `${totalNeedProductLine} colors have no product line.`}{" "}
                <span className="font-normal opacity-95">
                  Pick one on each row marked in red; the vendor is sent &ldquo;[NOT SET]&rdquo; without it.
                  {customNeedProductLine.length > 0 && (
                    <>
                      {" "}
                      {customNeedProductLine.length === 1
                        ? "One of them is a custom color item"
                        : `${customNeedProductLine.length} of them are custom color items`}{" "}
                      further down the page.
                    </>
                  )}
                </span>
              </p>
            )}
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
            {/* The two surfaces disagree about a color. Rooms & Colors lets
                Salesforce win (deliberately — so a rep's correction is not
                masked); the order buys what the customer submitted. Both are
                defensible and PPP has never been asked which they want, so the
                order says what it is buying and what the other screen shows,
                and leaves the choice to a person. */}
            {/* Two brands on one job. Whoever is being ordered from is getting
                all of it; the other vendor's order will carry the same lines
                again unless they are zeroed here. */}
            {brandsOnJob.size > 1 && (
              <div className="px-4 py-2.5 text-[11px] text-ppp-charcoal-600 bg-[var(--color-surface-muted)] border-b border-ppp-charcoal-100">
                This job uses <strong>{[...brandsOnJob].join(" and ")}</strong>. This order carries every
                color on the work order, whichever brand — set the ones this vendor is not supplying
                to 0 so they are not bought twice.
              </div>
            )}
            {(currentDraft?.colorConflicts?.length ?? 0) > 0 && (
              <div role="alert" className="px-4 py-3 text-[11px] text-ppp-orange-700 bg-ppp-orange-50 border-b border-ppp-orange-100">
                <strong className="font-semibold">Salesforce and the customer&apos;s form disagree about a color.</strong>
                <ul className="mt-1 space-y-0.5">
                  {currentDraft!.colorConflicts!.slice(0, 6).map((c, i) => (
                    <li key={`${c.roomLabel}-${c.surface}-${i}`}>
                      {c.roomLabel} · {c.surface}: ordering <strong>{c.orderingName}</strong>, Salesforce says {c.salesforceName}
                    </li>
                  ))}
                </ul>
                <span className="block mt-1">
                  This order buys the customer&apos;s pick. If a rep corrected it in Salesforce, fix it there
                  and reload, or add the right color as a custom item.
                </span>
              </div>
            )}
            {currentDraft && estimates.length === 0 && (
              <div className="px-4 py-5 text-xs text-ppp-charcoal-500">
                No colors on this work order yet. You can still order extras and custom color items below.
              </div>
            )}

            <ul className="divide-y divide-ppp-charcoal-100">
              {estimates.map((e) => {
                const key = quantityKey(e.colorId, e.finish, e.isBathroom);
                const override = readForEstimate(payload.quantities, e);
                const unit: PaintUnit = override?.unit ?? e.unit ?? "gal";
                // Read the worker's OWN number when they have set one, rather
                // than waiting for the server to echo it back. Karan
                // 2026-09-09: "when I add like a gallon there's a small delay."
                // The click already wrote `override`; the row was still reading
                // `e`, which only updates a debounce + round trip later — so
                // the number visibly lagged the button.
                //
                // This does not fork the maths: `applyQuantityOverrides` folds
                // the very same override server-side, so the value shown now is
                // the value that comes back. The server stays the source of
                // truth for everything derived (totals, packaging, the email).
                const total = override
                  ? containerCount(override)
                  : containerCount({ buckets: e.buckets, cans: e.cans, unit });
                // Two very different zeros. `excluded` is the worker saying
                // "don't buy this one" — a decision, shown neutrally and
                // reversible via "reset to estimate". A placeholder zero is the
                // estimator saying "I couldn't size this" — a gap, shown as a
                // warning. Collapsing them made the deliberate choice look like
                // an unfinished field and still shipped the color to the vendor.
                const isExcluded = !!e.excluded;
                const isPlaceholder = !isExcluded && (e.manualOnly || (e.buckets === 0 && e.cans === 0));
                // Red only AFTER Continue was refused — coloring an untouched
                // form on arrival scolds somebody who has not done anything yet.
                const lineNeedsProduct =
                  productLineError && needProductLine.some((n) => quantityKey(n.colorId, n.finish, n.isBathroom) === key);
                // What this line falls back to when no override is picked —
                // the job's own product line from Salesforce. Read through the
                // same fallback the value uses, or a pre-split draft loses the
                // hint on a bathroom row while the value still shows. Empty
                // means there is NOTHING to fall back to, which is why the
                // clear option is withheld below.
                // Same order the email uses: the per-color default first (the
                // exterior line derived for exterior-only colors), then the
                // job's own. Either is a real thing to fall back to; neither
                // means the clear option would lead nowhere, so it is withheld.
                const jobDefault =
                  readForEstimate(currentDraft?.resolvedMaterialTypeOverrides ?? {}, e) ||
                  jobMaterialType;
                return (
                  <li key={key} className="px-4 py-3 text-xs">
                    {/* basis-full sm:basis-auto makes the name take its own row
                        on a phone. flex-wrap alone never fired here: flex-1 is
                        `flex: 1 1 0%`, so the name's hypothetical size is 0 and
                        the browser keeps both children on one line, handing the
                        name whatever the shrink-0 button cluster leaves — which
                        at 320px is nothing, and the parent's overflow-hidden
                        then clipped the "+" button off the card. */}
                    {/* Katie's four layout notes, 2026-10-01. One row, two
                        columns: everything the line SAYS on the left, every
                        control on the right in a fixed-width stack.

                        It used to be two stacked flex rows with `flex-wrap`,
                        and `sm:basis-auto` beat `sm:flex-1` on the text block —
                        so a line naming six rooms sized itself to its content
                        and shoved the counter onto a second line at the LEFT,
                        while a one-room line kept it at the right. Same list,
                        two different layouts, depending on how many rooms a
                        color happened to cover. */}
                    <div className="sm:flex sm:items-start sm:gap-4">
                      <div className="min-w-0 sm:flex-1 break-words">
                        <div>
                          <span className="font-medium text-ppp-charcoal">{e.colorName}</span>
                          {e.colorCode && <span className="text-ppp-charcoal-400 ml-1">{e.colorCode}</span>}
                          {e.finish && <span className="text-ppp-charcoal-500"> · {e.finish}</span>}
                          {brandsOnJob.size > 0 && currentDraft?.colorBrands?.[key] && (
                            <span className="ml-1.5 align-middle inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-50 border border-ppp-charcoal-100 text-[10px] font-medium text-ppp-charcoal-600">
                              {currentDraft.colorBrands[key]}
                            </span>
                          )}
                        </div>
                        {/* Kate round-3 #25: room(s) AND surface, so a color used
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
                        {/* Karan 2026-09-09: "for each color we should have it here so we
                            don't keep having to scroll up", and then: ceiling square footage,
                            wall surface area, trim linear feet.
                        
                            Each surface gets the measure that actually governs it. Showing floor
                            area against a trim line is noise — trim is priced off the perimeter,
                            and a reader checking the quantity needs the number the maths used.
                            Repeated per room, because a color can span several and one combined
                            figure hides which room is which. */}
                        {(() => {
                          const rows = (e.placements?.length
                            ? e.placements.flatMap((pl) => pl.rooms.map((room) => ({ room, surface: pl.surface })))
                            : e.rooms.map((room) => ({ room, surface: "" }))) ?? [];
                          const measures = rows.map(({ room, surface }) => {
                            const src = sourceLines.find((l) => l.room === room);
                            if (!src) return null;
                            const kind = classifySurface(surface);
                            let measure = "";
                            // Jason + Alex 2026-09-17: the room's dimensions
                            // rather than the coverage area we computed from
                            // them. Falls back to the area when the room is not
                            // a rectangle, which is the only case where length
                            // and width cannot be recovered.
                            const dims = formatRoomDimensions(src.sqft, src.perimeterLf, src.heightFt);
                            if (kind === "ceiling" || kind === "floor") {
                              if (dims) measure = dims;
                              else if (src.sqft > 0) measure = `${src.sqft.toLocaleString()} sq ft`;
                            } else if (kind === "walls") {
                              // Dimensions first here too (Jason, testing with
                              // Adler and Ido 2026-09-24: "instead of listing
                              // the surface area calculation please list the
                              // room dimensions like it's listed above").
                              //
                              // This branch used to lead with the MEASURED wall
                              // area, because that is the number the gallons
                              // were computed from when Salesforce carries
                              // Wall_Surface_Area__c. That is a reason to keep
                              // the figure on the backend, not a reason to show
                              // it to the person reading the room: a estimator
                              // recognizes "16 × 20 × 9 ft" as the room in
                              // front of them and "648 sq ft wall" as arithmetic.
                              if (dims) measure = dims;
                              else if (src.wallSqft > 0) measure = `${src.wallSqft.toLocaleString()} sq ft wall`;
                              else if (src.sqft > 0) measure = `${src.sqft.toLocaleString()} sq ft floor`;
                            } else if (kind === "trim") {
                              // A DOOR is not the room's perimeter. classifySurface
                              // groups doors with trim — right for the gallon maths,
                              // wrong here: "Door — Kitchen · 48 lin ft" reads as a
                              // measurement of the door and is actually the length of
                              // the walls around it. Better to show nothing than a
                              // number that means something else.
                              if (/door|window|cabinet/i.test(surface)) {
                                measure = "";
                              } else if (src.perimeterLf > 0) {
                                // Labelled: the trim is PRICED on the perimeter
                                // plus 25% for door and window molding, so an
                                // unlabelled figure here invites a check
                                // against the quantity that fails by a quarter.
                                measure = `${Math.round(src.perimeterLf).toLocaleString()} lin ft perimeter`;
                              } else if (src.sqft > 0) {
                                measure = `~${Math.round(4 * Math.sqrt(src.sqft))} lin ft perimeter (derived)`;
                              }
                            }
                            return measure ? { room, surface, measure } : null;
                          }).filter(Boolean) as Array<{ room: string; surface: string; measure: string }>;
                          if (measures.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-ppp-charcoal-500">
                              {measures.map((m, i) => (
                                <span key={`${m.room}-${m.surface}-${i}`}>
                                  <span className="text-ppp-charcoal-600">{m.room}</span>
                                  {m.surface ? ` ${m.surface.toLowerCase()}` : ""} {m.measure}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        </div>
                      </div>

                      {/* The control column. Fixed width from `sm` up, so the
                          unit toggle growing a third button at five gallons
                          ("Bucket") no longer widens the line and knocks every
                          other row out of alignment — Katie's yellow note,
                          "keep the widest width no matter the selection so the
                          view is cohesive". */}
                      <div className="mt-2 sm:mt-0 sm:w-[17.5rem] sm:shrink-0 flex flex-col gap-1.5">
                      <div className="flex items-center justify-end gap-1.5">
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
                          {/* The estimator's OWN number the moment they press
                              +/−, not the server's echo of it. `total` was
                              already computed from the local override for
                              exactly this reason, and then only the disabled
                              states used it — so the button reacted instantly
                              while the number beside it sat stale for the
                              600ms debounce plus a Salesforce-backed round
                              trip. Once an override exists the line is no
                              longer a placeholder either: a typed answer is an
                              answer. */}
                          {override && containerCount(override) === 0
                            ? "not ordering"
                            : override
                            ? formatBucketsCans(override.buckets, override.cans, unit)
                            : isPlaceholder
                              ? "⚠️ set qty"
                              : formatOrderQuantity(e)}
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

                      {/* Directly under the counter — Katie's purple note. It
                          undoes the number immediately above it, and sat three
                          controls away from it. */}
                      {override && (
                        <button
                          type="button"
                          onClick={() => resetQuantity(e)}
                          className="text-[10px] text-ppp-blue-700 hover:underline self-end px-1 min-h-[44px] sm:min-h-0 touch-manipulation"
                        >
                          reset to estimate
                        </button>
                      )}

                      {/* Kate round-3 #27: gallons or quarts, per line.
                          Full width of the column with equal-width buttons, so
                          two options and three occupy the same space. */}
                      <div className="flex w-full rounded-lg border border-ppp-charcoal-100 overflow-hidden" role="group" aria-label={`Unit for ${e.colorName}`}>
                        {/* Bucket appears once a line reaches five gallons (Karan 2026-09-09).
                            Offering it below that would let someone order a pail for two
                            gallons of paint; hiding it entirely is what forced the silent
                            auto-conversion this replaces. */}
                        {(["gal", "qt", "bucket"] as PaintUnit[]).map((u) => {
                          // Kate, 2026-10-07: "Make these consistent." Rows
                          // rendered TWO buttons under five gallons and THREE
                          // at or above it, so every row was a different shape
                          // and the same control sat in a different place on
                          // each. All three always render now; Bucket is
                          // DISABLED rather than missing below five gallons,
                          // which keeps Karan's 2026-09-09 rule — nobody
                          // orders a pail for two gallons of paint — while the
                          // row stops changing width under the reader.
                          const bucketAllowed = (unit === "gal" && total >= 5) || unit === "bucket";
                          const disabled = u === "bucket" && !bucketAllowed;
                          return (
                            <button
                              key={u}
                              type="button"
                              disabled={disabled}
                              onClick={() => setUnit(e, u)}
                              aria-pressed={unit === u}
                              title={disabled ? "A bucket is five gallons — this line is under that." : undefined}
                              /* Kate: "Enlarge text on the gallon, quart,
                                 bucket selector." 11px was below what the rest
                                 of this row uses. */
                              className={`flex-1 px-2 py-1 text-[13px] sm:text-[12px] font-medium min-h-[44px] sm:min-h-[32px] touch-manipulation transition-colors ${
                                disabled
                                  ? "bg-ppp-charcoal-50 text-ppp-charcoal-300 cursor-not-allowed"
                                  : unit === u
                                    ? "bg-ppp-blue text-ppp-navy"
                                    : "bg-white text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                              }`}
                            >
                              {u === "gal" ? "Gallon" : u === "qt" ? "Quart" : "Bucket"}
                            </button>
                          );
                        })}
                      </div>
                      {unitNote?.key === quantityKey(e.colorId, e.finish, e.isBathroom) && (
                        <span className={`text-[11px] text-right ${unitNote.text.includes("from stock") ? "text-ppp-charcoal-500" : "text-ppp-orange-700"}`}>
                          {unitNote.text}
                        </span>
                      )}
                      <div className="flex items-center gap-1.5 w-full">
                        <label className={`text-[10px] shrink-0 ${lineNeedsProduct ? "text-ppp-orange-700 font-semibold" : "text-ppp-charcoal-500"}`} htmlFor={`mt-${key}`}>
                          Product line:
                        </label>
                        <div className={`flex-1 min-w-0 rounded-lg ${lineNeedsProduct ? "ring-2 ring-ppp-orange-700 bg-ppp-orange-500/10" : ""}`}>
                          <MaterialTypePicker
                            id={`mt-${key}`}
                            value={readProductOverride(payload.materialTypeOverrides, e) ?? ""}
                            onChange={(v) => setLineFor(e, v)}
                            // R5.3: when the builder has already decided a line
                            // for this color — the exterior answer on a mixed
                            // job — name it, rather than showing an empty box over an
                            // email that already carries an answer.
                            //
                            // The fallback is NOT "use default" any more: item 14 removed
                            // the job-level default selector, so that phrase pointed at a
                            // control that no longer exists.
                            placeholder={jobDefault ? `${jobDefault} (from the job)` : "— pick a product —"}
                            compact
                            // Clearing is only offered when there is something
                            // behind it. Kate 2026-10-06: the option read "Use
                            // default (no override)" on every line, including
                            // the ones with no job default — picking it set the
                            // override to "" and tripped "Product line
                            // required", which looked like the error was broken
                            // when it was the option that was.
                            allowClear={Boolean(jobDefault)}
                            clearLabel={`— Use the job's ${jobDefault} —`}
                            availableValues={lineMaterialValues}
                          />
                        </div>
                      </div>
                      {/* A bare "Other" is not a product a paint counter can
                          fill, so the vendor is sent "[NOT SET]" (Katie item
                          11). The picker closes over the word "Other" and
                          looks answered, which left the screen saying one
                          thing and the email another — seen live on WO
                          00318014, 2026-09-29. Say it where the choice was
                          made. */}
                      {lineNeedsProduct && (
                        <p className="text-[10px] font-semibold text-ppp-orange-700 text-right">
                          Product line required
                        </p>
                      )}
                      {(() => {
                        const v = readProductOverride(payload.materialTypeOverrides, e) ?? "";
                        if (!v.trim() || materialTypeForVendor(v).trim()) return null;
                        return (
                          <p className="text-[10px] text-ppp-orange-700 mt-1 text-right">
                            Open the list and type which product — the vendor is sent &ldquo;[NOT SET]&rdquo;.
                          </p>
                        );
                      })()}
                      </div>
                    </div>

                    {e.needsMeasurement && !isPlaceholder && (
                      <p className="text-[10px] text-ppp-orange-700 mt-1 text-right">
                        ⚠ a room is unmeasured — this may be low
                      </p>
                    )}
                    {/* Katie item 7 — an accent wall is a second color over
                        part of one wall. Nothing in the geometry can see it, so
                        the quantity beside it is a guess. RED, and above the
                        defaulted note: this is the one that needs a person. */}
                    {e.accentWallReview && (
                      /* Kate, 2026-10-07, two asks on one line:
                         · "Add specific room names and 'requested' to verbiage
                           — e.g. 'Accent wall requested in Dining Room, check
                           quantity'". It said "on this line", which on a color
                           spanning six rooms pointed at all of them.
                         · "Make alerts yellow and errors red. This should be
                           yellow." It is a prompt to look, not a refusal —
                           the red is reserved for the product-line error that
                           actually blocks sending.
                         Amber-700 on amber-50, not amber-600: a -600 on a -50
                         tint fails AA, which this codebase has been caught by
                         before. */
                      <p className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-1 mt-1 text-right">
                        ⚠ Accent wall requested
                        {e.accentWallRooms && e.accentWallRooms.length > 0
                          ? ` in ${e.accentWallRooms.join(", ")}`
                          : ""}
                        {" "}— check the quantity
                      </p>
                    )}
                    {/* The kitchen / bathroom / shared-kitchen rules of thumb.
                        These were being computed and never shown, so a worker
                        saw a number with no hint that it was a default. */}
                    {e.defaultedNote && (
                      <p className="text-[10px] text-ppp-charcoal-500 mt-1 text-right leading-snug">
                        {e.defaultedNote}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          </div>

          {/* ── Custom color item (#28) ──────────────────────────────────── */}
          <CustomColorItems
            items={payload.customColorItems}
            onChange={(customColorItems) => patch({ customColorItems })}
            materialValues={lineMaterialValues}
            showMissingProduct={productLineError}
          />

          {/* ── Color Notes (#16) ─────────────────────────────────────────── */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
            <label className="text-sm font-semibold text-ppp-charcoal block mb-1" htmlFor="order-color-notes">
              Color Notes
            </label>
            <p className="text-[11px] text-ppp-charcoal-500 mb-2">
              Colors and finishes for surfaces that don&apos;t map to a standard field, non-BM/SW
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
                        className={`text-[11px] px-2.5 py-1.5 rounded-l-lg min-h-[44px] touch-manipulation transition-colors ${
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
                            className="h-11 w-11 sm:h-9 sm:w-9 sm:h-7 sm:w-7 rounded text-ppp-charcoal hover:bg-white disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
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
                            className="h-11 w-11 sm:h-9 sm:w-9 sm:h-7 sm:w-7 rounded text-ppp-charcoal hover:bg-white disabled:text-ppp-charcoal-300 disabled:cursor-not-allowed flex items-center justify-center text-base leading-none touch-manipulation"
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
              {groupExtras(filteredCatalog).map(({ group, items }) => (
                <div key={group} className="col-span-full">
                  {/* Karan, materials meeting: "extras organize — caulk should be
                      stacked, rolls etc." One flat list put the four caulks apart
                      from each other. */}
                  <p className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mt-2 mb-1 first:mt-0">
                    {group}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {items.map((c) => {
                const sel = selectedExtras.find((e) => e.extraId === c.id);
                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs transition-colors ${
                      sel ? "bg-ppp-blue-50 border-ppp-blue-100" : "bg-white border-ppp-charcoal-100 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    <label className="flex items-center gap-2 flex-1 min-w-0 min-h-[44px] sm:min-h-0 cursor-pointer">
                      <input type="checkbox" checked={!!sel} onChange={() => toggleExtra(c)} className="h-5 w-5 sm:h-4 sm:w-4 shrink-0 accent-ppp-blue cursor-pointer" />
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
                      {/* Caulk is bought loose or by the case, and a case is a different
                          SKU at the counter — not a count of tubes. Only offered where the
                          catalog unit is a tube; nothing else PPP orders comes by the
                          case. Karan, materials meeting. */}
                      {c.unit === "tube" && (
                        <select
                          value={sel.unit}
                          onChange={(ev) => setExtraUnit(c.id, ev.target.value)}
                          aria-label={`Unit for ${c.name}`}
                          className="shrink-0 text-base sm:text-[10px] border border-ppp-blue-100 rounded bg-white px-1 py-1 min-h-[44px] sm:min-h-0 touch-manipulation"
                        >
                          <option value="tube">tube</option>
                          <option value="case">case</option>
                        </select>
                      )}
                      </div>
                    ) : (
                      <span className="text-[10px] text-ppp-charcoal-500 shrink-0">
                        ×{c.default_qty} {c.unit}
                      </span>
                    )}
                  </div>
                );
                    })}
                  </div>
                </div>
              ))}
              {filteredCatalog.length === 0 && (
                <div className="col-span-full text-xs italic py-3 text-center">
                  {extrasError ? (
                    <span className="text-ppp-orange-700 not-italic">
                      Couldn&apos;t load the sundries list ({extrasError}). Refresh — this is not an empty catalog.
                    </span>
                  ) : (
                    <span className="text-ppp-charcoal-500">No matches.</span>
                  )}
                </div>
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
                          className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-700 px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
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
          dropped the user on a vendor picker instead. Looking at the colors
          is a read-only act; it shouldn't require choosing a store first. */}
          {/* R4.17: the "Supplier → color → where it goes" panel was removed —
              it restated the buy-list above with a different grouping, and the
              two disagreed whenever the buy-list changed. */}

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
              ) : !orderSaved ? (
                // "Order saved." was printed whenever nothing was wrong —
                // including before a single save had happened, and while the
                // autosave was not even armed.
                <>Sending is next: required-by date, delivery or pickup, and the email.</>
              ) : (
                <>Order saved. Sending is next: required-by date, delivery or pickup, and the email.</>
              )}
            </div>
            <button
              type="button"
              onClick={handleAdvance}
              disabled={advancing}
              className="px-4 py-2 min-h-[44px] rounded-lg bg-ppp-green text-ppp-navy text-sm font-semibold hover:bg-ppp-green-600 transition-colors disabled:opacity-60 shadow-sm shadow-ppp-green/30 touch-manipulation"
            >
              {advancing ? "Saving…" : "Continue to sending →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Kate round-3 #28 — the COLOR half of "Add custom item".
 *
 * Deliberately one free-text field rather than a color picker plus a finish
 * dropdown: it has to cover stain, venetian plaster and specialty coatings as
 * well as paint, and Kate asked for the prompt to live in the field itself.
 * Sits between the buy-list and Color Notes so someone reading down the notes
 * can add a line as they go.
 */
/**
 * The colors in one Salesforce line's Color Notes, each with its own quantity
 * and an Add button.
 *
 * Color notes never go to the vendor (R4.14), so on a job whose colors live
 * only there (WO 00316248) this is the difference between an order with them
 * and one without.
 *
 * Each row adds ITSELF rather than filling in the form further down the page:
 * that form only exists once a vendor is picked, and this panel is the first
 * thing on the page (Katie item 9), so "fill in the form" was a dead tap on a
 * new order. It also cannot overwrite a custom item somebody is mid-way
 * through typing.
 *
 * The quantity starts blank, and Add stays disabled until it is filled: 1 gal
 * defaulted onto a whole house's siding is a silent under-order.
 */
function ColorNoteOffers({
  room,
  offers,
  remarks,
  items,
  estimates,
  onAdd,
}: {
  room: string;
  offers: ColorNoteOffer[];
  remarks: string[];
  items: Array<{ label: string }>;
  estimates: Array<{ colorName: string; colorCode: string | null }>;
  onAdd: (
    label: string,
    qty: number,
    unit: string,
    extra?: { finish?: string | null; scope?: string | null }
  ) => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [unit, setUnit] = useState<Record<string, PaintUnit>>({});
  if (offers.length === 0 && remarks.length === 0) return null;
  // The room the NOTE named beats the line item's own — when a rep puts seven
  // rooms on one line, the line's name identifies none of them (Katie
  // 2026-10-01). Falls back to the line item for notes with no headings.
  // Kate 2026-10-06: the color, its sheen and where it goes, kept apart —
  // the whole string used to become the color and reached the vendor that way.
  const identityFor = (o: ColorNoteOffer) => offerIdentity(o, room);
  const pending = offers.filter((o) => !isOfferOnOrder(items, identityFor(o))).length;
  return (
    <div className="mt-2 rounded-lg border border-ppp-charcoal-100 px-3 py-2">
      {offers.length > 0 && (
      <p className="text-[11px] text-ppp-charcoal-600">
        {pending === 0
          ? "Every color in these notes is on the order."
          : "Color notes don't go to the vendor. Add anything that needs buying:"}
      </p>
      )}
      <ul className="mt-1 divide-y divide-ppp-charcoal-100">
        {offers.map((offer) => {
          const line = offer.line;
          const id = identityFor(offer);
          const added = isOfferOnOrder(items, id);
          const covered = inBuyList(line, estimates);
          const q = qty[line] ?? "";
          return (
            <li key={line} className="py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* Shaped like a buy row (Kate 2026-10-06): the color and its
                    sheen on top, where it goes underneath — rather than one
                    run-on string that then became the color on the order. */}
                <span className="flex-1 min-w-[8rem] text-[12px] leading-snug text-ppp-charcoal break-words">
                  <span className="font-medium">{id.label}</span>
                  {id.finish && (
                    <span className="text-ppp-charcoal-500"> · {id.finish}</span>
                  )}
                  {id.scope && (
                    <span className="block text-[11px] text-ppp-charcoal-500">{id.scope}</span>
                  )}
                </span>
                {added ? (
                  <span className="shrink-0 text-[11px] font-medium text-ppp-green-700">✓ On order</span>
                ) : covered ? (
                  /* Kate 2026-10-07, p4.1: "remove ability to add quantity in
                     the custom color adder" when the color is already on the
                     order. The quantity box was the thing that produced the
                     duplicate line she is trying to stop — leaving it here and
                     only warning in text meant the warning had to be read and
                     obeyed. The flag below says where to change the number
                     instead. */
                  null
                ) : (
                  <span className="shrink-0 flex items-center gap-1.5">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={q}
                      onChange={(e) => setQty((cur) => ({ ...cur, [line]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && q.trim()) {
                          e.preventDefault();
                          onAdd(id.label, orderableQty(q), unit[line] ?? "gal", { finish: id.finish, scope: id.scope });
                        }
                      }}
                      placeholder="Qty"
                      aria-label={`Quantity for ${line}`}
                      className="w-14 px-2 py-1.5 text-base sm:text-[12px] text-right border border-ppp-charcoal-100 rounded-lg font-mono min-h-[44px] sm:min-h-0 focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                    />
                    <select
                      value={unit[line] ?? "gal"}
                      onChange={(e) => setUnit((cur) => ({ ...cur, [line]: e.target.value as PaintUnit }))}
                      aria-label={`Unit for ${line}`}
                      className="px-1.5 py-1.5 text-base sm:text-[12px] border border-ppp-charcoal-100 rounded-lg bg-white min-h-[44px] sm:min-h-0 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
                    >
                      <option value="gal">gal</option>
                      <option value="qt">qt</option>
                      <option value="bucket">bucket (5 gal)</option>
                    </select>
                    <button
                      type="button"
                      disabled={!q.trim()}
                      onClick={() => onAdd(id.label, orderableQty(q), unit[line] ?? "gal", { finish: id.finish, scope: id.scope })}
                      className="text-[11px] font-semibold text-ppp-blue-700 hover:underline disabled:text-ppp-charcoal-400 disabled:no-underline disabled:cursor-not-allowed px-2 min-h-[44px] sm:min-h-[28px] inline-flex items-center touch-manipulation"
                    >
                      Add
                    </button>
                  </span>
                )}
              </div>
              {/* The rep wrote the color into the notes AND set it on the
                  Salesforce field, so it is already on the buy-list with a
                  computed quantity. Adding it here would order it twice. */}
              {/* "(eggshell for the bathroom ceiling)" — an instruction about
                  WHERE the color goes, which used to be glued onto the end of
                  the product text where it read as part of the color name
                  (Katie 2026-10-01). */}
              {offer.qualifier && (
                <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 mt-0.5 inline-block">
                  {offer.qualifier}
                </p>
              )}
              {!added && covered && (
                /* Kate, 2026-10-07, p4.1 — her words, verbatim: "add a flag
                   stating 'This color already exists on the order. Increase
                   quantity above.'"
                   It replaces "Already in the buy-list above", which named a
                   section that no longer exists under that name (her p4.1a
                   rename) and, worse, told you a fact without telling you what
                   to do about it. Amber because her p18 note is explicit:
                   "Make alerts yellow and errors red." */
                <p
                  role="note"
                  className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1"
                >
                  This color already exists on the order. Increase quantity above.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {/* What the customer SAID. Not offerable — these used to arrive as
          buy-list rows with a quantity box beside them — but not discarded
          either: "I'd like an accent wall in a plum" is the estimator's cue to
          call them (Katie 2026-10-01). */}
      {remarks.length > 0 && (
        <div className="mt-2 pt-2 border-t border-ppp-charcoal-100">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
            Also in the notes — not something to buy
          </p>
          <ul className="mt-1 space-y-1">
            {remarks.map((r) => (
              <li key={r} className="text-[11px] leading-snug text-ppp-charcoal-600">{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * MUST mirror `CustomColorItem` in lib/supplier-order/builder.ts.
 *
 * It is duplicated rather than imported because builder.ts is `server-only`.
 * A second copy is how two shapes drift — and this one already had: `scope`
 * was added to the canonical type and not here, which tsc caught. The
 * order-builder-custom-item test asserts the two field lists match, so the
 * next person who adds a field to one is told about the other.
 */
type CustomItem = {
  id: string;
  label: string;
  qty: number;
  unit: string;
  finish?: string | null;
  materialType?: string | null;
  /** Where it goes — "Ceiling — All rooms". Screen only, never emailed. */
  scope?: string | null;
};

function CustomColorItems({
  items,
  onChange,
  materialValues,
  showMissingProduct = false,
}: {
  items: CustomItem[];
  onChange: (items: CustomItem[]) => void;
  /** The same product list the buy-list rows offer, filtered to this job. */
  materialValues?: ReadonlySet<string>;
  /** The estimator pressed "Continue to sending" and these lines would have
   *  reached the vendor as "[NOT SET]". Marks them the same way the buy rows
   *  are marked, so "the rows marked in red" means something down here too. */
  showMissingProduct?: boolean;
}) {
  const [label, setLabel] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState<PaintUnit>("gal");
  const [finish, setFinish] = useState("");
  const [materialType, setMaterialType] = useState("");

  const add = () => {
    const l = label.trim();
    if (!l) return;
    if (!qty.trim()) return;
    onChange([
      ...items,
      {
        id: nextCustomColorId(items, l),
        label: l,
        qty: orderableQty(qty),
        unit,
        finish: finish.trim() || null,
        materialType: materialType.trim() || null,
      },
    ]);
    setLabel("");
    setQty("1");
    setUnit("gal");
    setFinish("");
    setMaterialType("");
  };

  /** Edit one field on an item already on the order (Katie 2026-10-01: she
   *  could add a quantity but could not "add/edit the finish or product
   *  line"). */
  const patchItem = (id: string, patch: Partial<CustomItem>) =>
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3 scroll-mt-4">
      <h2 className="text-sm font-semibold text-ppp-charcoal">Add a custom color item</h2>
      <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 mb-2">
        Anything that isn&apos;t in the catalog — stain, venetian plaster, a color match. It goes on
        the order as a real line.
      </p>

      {items.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {items.map((it) => (
            <li
              key={it.id}
              className={`text-xs rounded px-2.5 py-2 border ${
                showMissingProduct && !materialTypeForVendor(it.materialType).trim()
                  ? "bg-ppp-orange-50 border-ppp-orange-100"
                  : "bg-ppp-green-50/50 border-ppp-green-100"
              }`}
            >
              <div className="flex items-center gap-2">
                {/* Color on top, where it goes underneath — the buy-row shape
                    (Kate 2026-10-06). `truncate` would clip the scope line, so
                    this wraps instead: a room list is exactly the text that
                    outgrows its track. */}
                <span className="flex-1 min-w-0 text-ppp-charcoal break-words">
                  {it.label}
                  {it.scope && (
                    <span className="block text-[10px] text-ppp-charcoal-500">{it.scope}</span>
                  )}
                </span>
                <span className="text-[10px] text-ppp-charcoal-500 shrink-0">×{it.qty} {it.unit}</span>
                <button
                  type="button"
                  onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                  className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-700 px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
                  aria-label={`Remove ${it.label}`}
                >
                  Remove
                </button>
              </div>
              {/* EDITABLE after the fact — Katie 2026-10-01 added a line, set
                  the gallons, and then had nowhere to say which sheen or which
                  product it was. Both sit on the line itself rather than in the
                  add-form only, because the thing she needed to change was
                  already on the order. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="text-[10px] text-ppp-charcoal-500" htmlFor={`cc-finish-${it.id}`}>
                  Finish
                </label>
                <input
                  id={`cc-finish-${it.id}`}
                  type="text"
                  value={it.finish ?? ""}
                  onChange={(e) => patchItem(it.id, { finish: e.target.value })}
                  placeholder="e.g. Eggshell"
                  className="w-32 px-2 py-1.5 text-base sm:text-[12px] border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 min-h-[44px] sm:min-h-0"
                />
                <label
                  className={`text-[10px] ${
                    showMissingProduct && !materialTypeForVendor(it.materialType).trim()
                      ? "text-ppp-orange-700 font-semibold"
                      : "text-ppp-charcoal-500"
                  }`}
                  htmlFor={`cc-mt-${it.id}`}
                >
                  Product line
                </label>
                <div
                  className={`w-[190px] ${
                    showMissingProduct && !materialTypeForVendor(it.materialType).trim()
                      ? "rounded-lg ring-2 ring-ppp-orange-700"
                      : ""
                  }`}
                >
                  <MaterialTypePicker
                    id={`cc-mt-${it.id}`}
                    value={it.materialType ?? ""}
                    onChange={(v) => patchItem(it.id, { materialType: v })}
                    placeholder="— pick a product —"
                    compact
                    // No clear option: a hand-typed line has no job default
                    // behind it, so clearing sends the vendor "[NOT SET]" —
                    // the line in Kate's 2026-10-06 screenshot. The picker is
                    // the only place this can be answered, so it does not
                    // offer a way to un-answer it.
                    availableValues={materialValues}
                  />
                </div>
              </div>
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
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); add(); }
            }}
            placeholder="Qty"
            aria-label="Quantity"
            className="w-16 px-2 py-2.5 sm:py-2 text-base sm:text-sm text-right border border-ppp-charcoal-100 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-ppp-blue/30"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as PaintUnit)}
            aria-label="Unit"
            className="px-2 py-2.5 sm:py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 min-h-[44px] sm:min-h-0 touch-manipulation"
          >
            <option value="gal">gal</option>
            <option value="qt">qt</option>
            {/* Katie item 8 — a hand-typed color can be a 5-gallon pail. Not
                offered on estimate lines: those already roll into buckets on
                their own, so it would be two ways to say the same thing. */}
            <option value="bucket">bucket (5 gal)</option>
          </select>
          <button
            type="button"
            onClick={add}
            disabled={!label.trim() || !qty.trim()}
            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation min-h-[44px] sm:min-h-0"
          >
            Add
          </button>
        </div>
      </div>

      {/* Finish and product line on the way IN as well, so a line does not have
          to be added and then corrected. Both optional: a color match handed
          over on a chip genuinely has no sheen to give. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-[10px] text-ppp-charcoal-500" htmlFor="cc-new-finish">
          Finish
        </label>
        <input
          id="cc-new-finish"
          type="text"
          value={finish}
          onChange={(e) => setFinish(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="e.g. Eggshell"
          className="w-32 px-2 py-1.5 text-base sm:text-[12px] border border-ppp-charcoal-100 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-ppp-blue/30 min-h-[44px] sm:min-h-0"
        />
        <label className="text-[10px] text-ppp-charcoal-500" htmlFor="cc-new-mt">
          Product line
        </label>
        <div className="w-[190px]">
          <MaterialTypePicker
            id="cc-new-mt"
            value={materialType}
            onChange={setMaterialType}
            placeholder="— pick a product —"
            compact
            allowClear
            availableValues={materialValues}
          />
        </div>
      </div>
    </section>
  );
}

/** The sundry half of "Add custom item" — unchanged behavior, now clearly
 *  labelled as sundries so it reads as the pair to the color item above. */
function CustomSundryItem({ onAdd }: { onAdd: (name: string, qty: number, unit: string) => void }) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("each");

  const add = () => {
    const n = name.trim();
    if (!n) return;
    // Clamped to 99 like setExtraQty and every other quantity path. Without
    // the upper bound a typed 999 showed as "×999 each" on the builder until
    // the page reloaded and the persistence normalize snapped it to 99 — so
    // the screen and the saved order disagreed, which is the shape of the bug
    // rather than the size of it. The vendor email was never affected.
    onAdd(n, Math.max(1, Math.min(99, Math.floor(Number(qty) || 1))), unit.trim() || "each");
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
            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation min-h-[44px] sm:min-h-0"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
