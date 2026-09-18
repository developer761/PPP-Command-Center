"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LineItemNotes from "@/components/line-item-notes";
import { customItemLabel, inBuyList, isOnOrder, nextCustomColorId, orderableQty } from "@/lib/supplier-order/color-note-items";
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
  type GallonEstimate,
  type PaintUnit,
} from "@/lib/supplier-order/estimate-gallons";
import { PRIMER_MATERIAL_TYPES, PRIMER_MATERIAL_VALUES, PAINT_LINE_VALUES } from "@/lib/customer-form/material-types";
import { emptyBuildPayload, mergeBuildPayloads, pruneToLiveKeys, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import { draftDelayMs } from "@/lib/supplier-order/draft-timing";

/**
 * ORDER BUILDING — stage one of the Order Materials split (Kate round-3 #18).
 *
 * Everything that decides WHAT TO BUY lives here: the vendor, the paint line,
 * quantities, color notes, extras and worker-typed color lines. When the
 * worker advances, the payload is committed to `supplier_order_builds` and the
 * fulfilment page reads it back — it has no way to change any of it.
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
  colorNoteLines?: string[];
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
// testable by behaviour rather than by grepping this file.

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
   * awaited, because that one has to land before fulfilment reads it.
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
   * fulfilment emails the 5.
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

  /* ── Extras catalogue ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      // A vendor's catalogue is that vendor's. Leaving the previous one on
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
        // only "is it an array" turned that into an empty catalogue: the panel
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
  const addCustomColorItem = (label: string, qty: number, unit: string) =>
    setPayload((cur) => ({
      ...cur,
      customColorItems: [
        ...cur.customColorItems,
        { id: nextCustomColorId(cur.customColorItems, label), label, qty, unit },
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
    setUnitNote((cur) => (cur && cur.key === key ? null : cur));
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

  /* ── Advance ───────────────────────────────────────────────────────────── */
  const handleAdvance = async () => {
    if (!supplier || advancing) return;
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

  return (
    <div className="space-y-5 pb-4">
      {/* Header */}
      <div>
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
          {customerName ?? "(unknown customer)"} · WO {woLabel} · Step 1 of 2 — decide what to buy, then continue to fulfilment.
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
                be visible before the numbers rather than after them. */}
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
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
              <ul className="divide-y divide-ppp-charcoal-100">
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
                      lines={l.colorNoteLines ?? []}
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
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
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
                              // A MEASURED wall area is what the gallons used —
                              // the estimator prefers Wall_Surface_Area__c over
                              // the room's shape and ignores the perimeter
                              // entirely. Showing dimensions there would put a
                              // number beside the quantity that did not produce
                              // it. Dimensions only when the walls really were
                              // derived from the room.
                              if (src.wallSqft > 0) measure = `${src.wallSqft.toLocaleString()} sq ft wall`;
                              else if (dims) measure = dims;
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
                    </div>

                    <div className="mt-2 flex items-center justify-end gap-3 flex-wrap">
                      {/* Kate round-3 #27: gallons or quarts, per line. */}
                      <div className="inline-flex rounded-lg border border-ppp-charcoal-100 overflow-hidden" role="group" aria-label={`Unit for ${e.colorName}`}>
                        {/* Bucket appears once a line reaches five gallons (Karan 2026-09-09).
                            Offering it below that would let someone order a pail for two
                            gallons of paint; hiding it entirely is what forced the silent
                            auto-conversion this replaces. */}
                        {(((unit === "gal" && total >= 5) || unit === "bucket"
                           ? ["gal", "qt", "bucket"]
                           : ["gal", "qt"]) as PaintUnit[]).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setUnit(e, u)}
                            aria-pressed={unit === u}
                            className={`px-3 py-1 text-[11px] font-medium min-h-[44px] sm:min-h-[32px] touch-manipulation transition-colors ${
                              unit === u
                                ? "bg-ppp-blue text-ppp-navy"
                                : "bg-white text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                            }`}
                          >
                            {u === "gal" ? "Gallon" : u === "qt" ? "Quart" : "Bucket"}
                          </button>
                        ))}
                      </div>
                      {unitNote?.key === quantityKey(e.colorId, e.finish, e.isBathroom) && (
                        <span className="text-[11px] text-ppp-orange-700 basis-full text-right">{unitNote.text}</span>
                      )}
                      {override && (
                        <button
                          type="button"
                          onClick={() => resetQuantity(e)}
                          className="text-[10px] text-ppp-blue-700 hover:underline px-1 py-1 min-h-[44px] sm:min-h-0 touch-manipulation"
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
                            placeholder={(() => {
                              // Read through the same fallback the value uses,
                              // or a pre-split draft loses the "(from the job)"
                              // hint on a bathroom row while the value shows.
                              const resolved = readForEstimate(currentDraft?.resolvedMaterialTypeOverrides ?? {}, e);
                              return resolved ? `${resolved} (from the job)` : "— pick a product —";
                            })()}
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
                    {/* Katie item 7 — an accent wall is a second color over
                        part of one wall. Nothing in the geometry can see it, so
                        the quantity beside it is a guess. RED, and above the
                        defaulted note: this is the one that needs a person. */}
                    {e.accentWallReview && (
                      <p className="text-[10px] font-semibold text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded px-1.5 py-1 mt-1 text-right">
                        ⚠ accent wall on this line — check the quantity
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

          {/* ── Custom color item (#28) ──────────────────────────────────── */}
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
                          catalogue unit is a tube; nothing else PPP orders comes by the
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
                <>Fulfilment is next: required-by date, delivery or pickup, and the email.</>
              ) : (
                <>Order saved. Fulfilment is next: required-by date, delivery or pickup, and the email.</>
              )}
            </div>
            <button
              type="button"
              onClick={handleAdvance}
              disabled={advancing}
              className="px-4 py-2 min-h-[44px] rounded-lg bg-ppp-green text-ppp-navy text-sm font-semibold hover:bg-ppp-green-600 transition-colors disabled:opacity-60 shadow-sm shadow-ppp-green/30 touch-manipulation"
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
  lines,
  items,
  estimates,
  onAdd,
}: {
  room: string;
  lines: string[];
  items: Array<{ label: string }>;
  estimates: Array<{ colorName: string; colorCode: string | null }>;
  onAdd: (label: string, qty: number, unit: string) => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [unit, setUnit] = useState<Record<string, PaintUnit>>({});
  if (lines.length === 0) return null;
  const pending = lines.filter((line) => !isOnOrder(items, customItemLabel(room, line))).length;
  return (
    <div className="mt-2 rounded-lg border border-ppp-charcoal-100 px-3 py-2">
      <p className="text-[11px] text-ppp-charcoal-600">
        {pending === 0
          ? "Every color in these notes is on the order."
          : "Color notes don't go to the vendor. Add anything that needs buying:"}
      </p>
      <ul className="mt-1 divide-y divide-ppp-charcoal-100">
        {lines.map((line) => {
          const label = customItemLabel(room, line);
          const added = isOnOrder(items, label);
          const covered = inBuyList(line, estimates);
          const q = qty[line] ?? "";
          return (
            <li key={line} className="py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex-1 min-w-[8rem] text-[12px] leading-snug text-ppp-charcoal break-words">
                  {line}
                </span>
                {added ? (
                  <span className="shrink-0 text-[11px] font-medium text-ppp-green-700">✓ On order</span>
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
                          onAdd(label, orderableQty(q), unit[line] ?? "gal");
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
                      onClick={() => onAdd(label, orderableQty(q), unit[line] ?? "gal")}
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
              {!added && covered && (
                <p className="text-[10px] text-ppp-charcoal-500 mt-0.5">Already in the buy-list above.</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
    if (!qty.trim()) return;
    onChange([
      ...items,
      { id: nextCustomColorId(items, l), label: l, qty: orderableQty(qty), unit },
    ]);
    setLabel("");
    setQty("1");
    setUnit("gal");
  };

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
            <li key={it.id} className="flex items-center gap-2 text-xs bg-ppp-green-50/50 border border-ppp-green-100 rounded px-2.5 py-2">
              <span className="flex-1 min-w-0 truncate text-ppp-charcoal">{it.label}</span>
              <span className="text-[10px] text-ppp-charcoal-500 shrink-0">×{it.qty} {it.unit}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                className="shrink-0 text-ppp-orange-700 hover:text-ppp-orange-700 px-3 py-1 min-h-[44px] sm:min-h-0 inline-flex items-center touch-manipulation"
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
    </section>
  );
}

/** The sundry half of "Add custom item" — unchanged behaviour, now clearly
 *  labelled as sundries so it reads as the pair to the color item above. */
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
            className="px-4 py-2.5 sm:py-2 rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors touch-manipulation min-h-[44px] sm:min-h-0"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
