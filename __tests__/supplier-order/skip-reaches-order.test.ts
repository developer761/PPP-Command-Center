import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * R4.15 — "On WO 00308360, Kitchen. The Color Notes box on Order Materials is
 * populated — but this line is missing from it: 'Kitchen: Customer selected
 * "Don't paint this surface" on Cabinets.'"
 *
 * Kate's point was that the line reached Salesforce AND Rooms & Colors but not
 * Order Materials. The cause: resolveLineItems walked the five SALESFORCE
 * FIELDS — walls / ceiling / trim / other / floor — so a customer who skipped
 * "Cabinets" was never looked up at all. The field list has no key for it.
 *
 * This used to assert on builder.ts SOURCE TEXT — that the loop existed, in
 * that spelling, in that order. That proves a string is present, goes red on a
 * rename, and would stay green if the value stopped reaching the screen. It now
 * builds the real draft from WO 00308360's payload and reads what comes out.
 */

const DOOR: SnapshotPaintColor = {
  id: "a026g00000XQ79xAAD",
  name: "OC-152 Super White",
  shortName: "Super White",
  code: "OC-152",
  collection: null,
  hexValue: null,
  manufacturerId: "001MANUFACTURER",
};

/** WO 00308360 · Kitchen — Surfaces__c = "Walls;Cabinets;Door". */
const KITCHEN_SURFACES = [
  { surface: "Walls", colorId: "a026g00000XQ5Z4AAL", colorName: null, colorCode: null, finish: "Eggshell", skipped: false },
  { surface: "Cabinets", colorId: null, colorName: null, colorCode: null, finish: null, skipped: true },
  { surface: "Door", colorId: DOOR.id, colorName: DOOR.name, colorCode: DOOR.code, finish: "Satin", skipped: false },
];

function draftInput(): BuildSupplierOrderInput {
  const workOrder = {
    id: "0WO000000308360",
    workOrderNumber: "00308360",
    workTypeName: "Interior Painting",
    accountName: "Test Customer",
    closeDate: null,
    createdDate: "2026-09-01T00:00:00Z",
  } as unknown as SnapshotWorkOrder;
  const woli = {
    id: "1WL000000308360",
    workOrderId: workOrder.id,
    status: "New",
    areaLabel: "Kitchen",
    surfaces: "Walls;Cabinets;Door",
    sqFootage: 120,
    wallSurfaceArea: 400,
    perimeter: 44,
    heightFt: 8,
    numCoats: 2,
    primer: null,
    prepLevel: null,
    productFamily: "Interior Painting",
    interiorExterior: "Interior",
    numClosets: 0,
    numDoors: 1,
    numWindows: 1,
    productName: null,
    totalPrice: 0,
    colorWallId: null,
    colorCeilingId: null,
    colorTrimId: null,
    colorOtherId: null,
    colorFloorId: null,
    finishWall: null,
    finishCeiling: null,
    finishTrim: null,
    finishOther: null,
    finishFloor: null,
    colorNotes: null,
    description: null,
    sortOrder: 1,
    changeOrderRelated: false,
  } as SnapshotWoli;
  return {
    workOrder,
    woliRows: [woli],
    paintColorsById: new Map([[DOOR.id, DOOR]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: {
      lineItems: [{ id: woli.id, surfaces: KITCHEN_SURFACES, notes: "" }],
    },
    fulfillmentMethod: "pickup",
    extras: [],
    includeAllColors: true,
  };
}

describe("a skipped orphan surface reaches the order", () => {
  it("the skip is recorded even though Salesforce has no field for Cabinets", async () => {
    // "Cabinets" is not one of the five field slots the old code walked, so a
    // customer who skipped it was never looked up at all.
    expect(["Walls", "Ceiling", "Trim", "Other", "Floor"]).not.toContain("Cabinets");
    const draft = await buildSupplierOrderDraft(draftInput());
    expect(draft.skippedSurfaces).toEqual([{ roomLabel: "Kitchen", surface: "Cabinets" }]);
  });

  it("…and still recorded when the room's OTHER orphan has a color", async () => {
    // The Kitchen case exactly: Cabinets skipped, Door picked. If the color
    // check ran first, a room with any colored orphan would swallow the skip.
    const draft = await buildSupplierOrderDraft(draftInput());
    expect(draft.skippedSurfaces.map((s) => s.surface)).toContain("Cabinets");
    expect(draft.lineItems.some((li) => li.colorName.includes("Super White"))).toBe(true);
  });

  it("it lands in the order's Color Notes, which is where Kate looked", async () => {
    const draft = await buildSupplierOrderDraft(draftInput());
    expect(draft.colorNotesDefault).toContain("Not painting:");
    expect(draft.colorNotesDefault).toContain("Kitchen");
    expect(draft.colorNotesDefault).toContain("Cabinets");
  });

  it("no skip, no 'Not painting:' heading", async () => {
    // An empty heading reads like something went missing.
    const input = draftInput();
    input.customerSubmittedPayload = {
      lineItems: [{ id: input.woliRows[0].id, surfaces: KITCHEN_SURFACES.filter((s) => !s.skipped), notes: "" }],
    };
    const draft = await buildSupplierOrderDraft(input);
    expect(draft.skippedSurfaces).toEqual([]);
    expect(draft.colorNotesDefault).not.toContain("Not painting:");
  });

  it("and it stays OFF the vendor email — R4.14", async () => {
    const draft = await buildSupplierOrderDraft(draftInput());
    expect(draft.body).not.toContain("Not painting");
    expect(draft.body).not.toMatch(/COLOR NOTES/i);
  });
});
