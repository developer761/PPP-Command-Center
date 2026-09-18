import { describe, it, expect } from "vitest";
import {
  emptyBuildPayload,
  mergeBuildPayloads,
  normalizeBuildPayload,
  type OrderBuildPayload,
} from "@/lib/supplier-order/build-state";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { quantityKey, containerCount, overrideTotal, gallonsOfOverride } from "@/lib/supplier-order/estimate-gallons";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * Karan, 2026-09-17: "sometimes I add like gallons and stuff and it didn't
 * like save to the email."
 *
 * The order page loads the vendor's saved payload when the vendor is chosen,
 * and the buy-list rows come from a SEPARATE request. Either can arrive first.
 * When the rows won, every quantity stepped before the saved payload landed
 * was overwritten by it — and on a new order that payload is empty, so the
 * numbers disappeared with nothing to show they had ever been typed. It only
 * happened when the estimator was quick, which is exactly what "sometimes"
 * looks like.
 */

function payload(over: Partial<OrderBuildPayload> = {}): OrderBuildPayload {
  return { ...emptyBuildPayload(), ...over };
}

describe("a quantity typed while the saved order was still loading", () => {
  it("survives an EMPTY saved payload — the new-order case", () => {
    const typed = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 3, unit: "gal" } } });
    const merged = mergeBuildPayloads(emptyBuildPayload(), typed);
    expect(merged.quantities["c1::Eggshell"]).toEqual({ buckets: 0, cans: 3, unit: "gal" });
  });

  it("wins over the saved value for the SAME color", () => {
    const saved = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 1, unit: "gal" } } });
    const typed = payload({ quantities: { "c1::Eggshell": { buckets: 1, cans: 2, unit: "gal" } } });
    expect(mergeBuildPayloads(saved, typed).quantities["c1::Eggshell"]).toEqual({ buckets: 1, cans: 2, unit: "gal" });
  });

  it("does not wipe the saved quantity for a DIFFERENT color", () => {
    const saved = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 4, unit: "gal" } } });
    const typed = payload({ quantities: { "c2::Flat": { buckets: 0, cans: 1, unit: "gal" } } });
    const merged = mergeBuildPayloads(saved, typed);
    expect(Object.keys(merged.quantities).sort()).toEqual(["c1::Eggshell", "c2::Flat"]);
  });

  it("keeps the saved order untouched when nothing was typed", () => {
    const saved = payload({
      quantities: { "c1::Eggshell": { buckets: 0, cans: 4, unit: "gal" } },
      extras: [{ extraId: "x1", name: "Tape", unit: "roll", qty: 2 }],
      customColorItems: [{ id: "cc-0", label: "Deck stain", qty: 1, unit: "gal" }],
      colorNotes: "saved notes",
      mainMaterialType: "Regal Select",
    });
    expect(mergeBuildPayloads(saved, emptyBuildPayload())).toEqual(saved);
  });

  it("keeps the saved extras AND the one added in the race window", () => {
    // Replacing the whole list looked right — "the estimator's list is the
    // answer" — but in the race window the estimator has never SEEN the saved
    // list, so adding one roll of tape dropped everything the order already
    // had. Union is safe here because this merge only ever runs on load: an
    // extra removed later is removed from a list that already holds both.
    const saved = payload({ extras: [{ extraId: "x1", name: "Tape", unit: "roll", qty: 2 }] });
    const typed = payload({ extras: [{ extraId: "x2", name: "Caulk", unit: "tube", qty: 1 }] });
    const merged = mergeBuildPayloads(saved, typed).extras;
    expect(merged.map((e) => e.extraId).sort()).toEqual(["x1", "x2"]);
  });

  it("the typed version of the SAME extra wins", () => {
    const saved = payload({ extras: [{ extraId: "x1", name: "Tape", unit: "roll", qty: 2 }] });
    const typed = payload({ extras: [{ extraId: "x1", name: "Tape", unit: "roll", qty: 9 }] });
    expect(mergeBuildPayloads(saved, typed).extras).toEqual([{ extraId: "x1", name: "Tape", unit: "roll", qty: 9 }]);
  });

  it("custom color items merge the same way", () => {
    const saved = payload({ customColorItems: [{ id: "cc-0", label: "Deck stain", qty: 1, unit: "gal" }] });
    const typed = payload({ customColorItems: [{ id: "cc-1", label: "Shutters", qty: 2, unit: "qt" }] });
    expect(mergeBuildPayloads(saved, typed).customColorItems.map((c) => c.id).sort()).toEqual(["cc-0", "cc-1"]);
  });

  it("an emptied Color Notes box stays empty", () => {
    // "" is an answer; null is "never touched".
    const saved = payload({ colorNotes: "saved notes" });
    expect(mergeBuildPayloads(saved, payload({ colorNotes: "" })).colorNotes).toBe("");
    expect(mergeBuildPayloads(saved, payload({ colorNotes: null })).colorNotes).toBe("saved notes");
  });

  it("survives the round trip through the persistence boundary", () => {
    const typed = payload({ quantities: { "c1::Eggshell": { buckets: 1, cans: 2, unit: "bucket" } } });
    const merged = mergeBuildPayloads(emptyBuildPayload(), typed);
    const stored = normalizeBuildPayload(JSON.parse(JSON.stringify(merged)));
    expect(stored.quantities["c1::Eggshell"]).toEqual({ buckets: 1, cans: 2, unit: "bucket" });
  });
});

/* ── and the seam that actually matters: does it reach the vendor? ───────── */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function draftInput(quantityOverrides: Record<string, { buckets: number; cans: number; unit?: "gal" | "qt" | "bucket" }>, roomLabel = "Bedroom"): BuildSupplierOrderInput {
  const workOrder = {
    id: "0WO000000000009", workOrderNumber: "00300009", workTypeName: "Interior Painting",
    accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
  } as unknown as SnapshotWorkOrder;
  const woli = {
    id: "1WL000000000009", workOrderId: workOrder.id, status: "New",
    areaLabel: roomLabel, surfaces: "Walls",
    sqFootage: 180, wallSurfaceArea: 0, perimeter: 54, heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: "Interior Painting", interiorExterior: "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
    colorWallId: COLOR.id, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
  return {
    workOrder, woliRows: [woli], paintColorsById: new Map([[COLOR.id, COLOR]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: null, fulfillmentMethod: "pickup", extras: [],
    includeAllColors: true, quantityOverrides,
  };
}

describe("the typed quantity reaches the vendor email", () => {
  it("an ordinary room", async () => {
    const key = quantityKey(COLOR.id, "Eggshell");
    const { body } = await buildSupplierOrderDraft(draftInput({ [key]: { buckets: 0, cans: 7, unit: "gal" } }));
    expect(body).toContain("7 gal");
  });

  it("a BATHROOM line, whose key carries the split", async () => {
    // The bathroom split (2026-09-17) changed this line's key. Every place that
    // writes or reads it has to agree, or the estimator types 4 and the vendor
    // is sent the estimate.
    const key = quantityKey(COLOR.id, "Eggshell", true);
    const { body } = await buildSupplierOrderDraft(draftInput({ [key]: { buckets: 0, cans: 4, unit: "gal" } }, "Bathroom"));
    expect(body).toContain("4 gal");
  });

  it("a bucket is five gallons, not one", async () => {
    const key = quantityKey(COLOR.id, "Eggshell");
    const { body } = await buildSupplierOrderDraft(draftInput({ [key]: { buckets: 0, cans: 2, unit: "bucket" } }));
    expect(body).toMatch(/2 bucket/i);
  });

  it("zero means don't buy it — the color leaves the order", async () => {
    const key = quantityKey(COLOR.id, "Eggshell");
    const { body } = await buildSupplierOrderDraft(draftInput({ [key]: { buckets: 0, cans: 0, unit: "gal" } }));
    expect(body).not.toContain("White Dove");
  });
});

/* ── a stored pail line that read as nothing ─────────────────────────────── */

describe("three pails stored the old way", () => {
  // Found by mutation testing, 2026-09-17: a pail line keeps its COUNT in
  // `cans`, but a row written with the count in `buckets` — which
  // normalizeBuildPayload happily loaded — was read as zero by containerCount,
  // overrideTotal and summarizeOrder alike. Fifteen gallons, on the screen,
  // in the totals and in the vendor's email, worth nothing.
  const legacy = { buckets: 3, cans: 0, unit: "bucket" as const };

  it("is three pails, not nothing, once loaded", () => {
    const loaded = normalizeBuildPayload({ quantities: { "c1::Eggshell": legacy } });
    expect(loaded.quantities["c1::Eggshell"]).toEqual({ buckets: 0, cans: 3, unit: "bucket" });
  });

  it("and reads as three pails even if it reaches the maths unloaded", () => {
    expect(containerCount(legacy)).toBe(3);
    expect(overrideTotal(legacy)).toBe(15);
    expect(gallonsOfOverride(legacy)).toBe(15);
  });

  it("a row with both fields set is left exactly as it was", () => {
    // Genuinely ambiguous, and it already reads as something. Guessing here
    // would change orders that are currently right.
    const both = { buckets: 1, cans: 2, unit: "bucket" as const };
    const loaded = normalizeBuildPayload({ quantities: { k: both } });
    expect(loaded.quantities.k).toEqual(both);
    expect(containerCount(both)).toBe(2);
  });
});
