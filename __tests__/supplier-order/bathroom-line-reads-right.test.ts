import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { quantityKey } from "@/lib/supplier-order/estimate-gallons";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * The bathroom split exists so the bathroom can take a different PRODUCT in
 * the same color. Until the estimator picks one, both lines print the same
 * color, the same finish and the same product — and the vendor's copy carries
 * no room (R4.25), so the order reads as the same line typed twice.
 *
 * Asserts the rendered email.
 */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function woli(id: string, areaLabel: string, w: number, l: number): SnapshotWoli {
  return {
    id, workOrderId: "0WO000000000011", status: "New",
    areaLabel, surfaces: "Walls",
    sqFootage: w * l, wallSurfaceArea: 0, perimeter: 2 * (w + l), heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: "Interior Painting", interiorExterior: "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
    colorWallId: COLOR.id, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
}

function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000000011", workOrderNumber: "00300011", workTypeName: "Interior Painting",
      accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
    } as unknown as SnapshotWorkOrder,
    woliRows: [woli("wl-1", "Hallway", 6, 20), woli("wl-2", "Bathroom", 5, 8)],
    paintColorsById: new Map([[COLOR.id, COLOR]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: null, fulfillmentMethod: "pickup", extras: [],
    includeAllColors: true, materialType: "Regal Select",
    ...over,
  };
}

/** The order lines a vendor reads, without the blank and heading rows. */
function orderLines(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => /^\s{2}\d|^\s{2}TBD/.test(l))
    .map((l) => l.trim());
}

describe("two lines in one color, one of them the bathroom", () => {
  it("are told apart, so the order does not read as a duplicate", async () => {
    const { body } = await buildSupplierOrderDraft(input());
    const lines = orderLines(body);
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(lines.filter((l) => /\(bathroom\)$/.test(l))).toHaveLength(1);
  });

  it("…and the note disappears once the bathroom has its own product", async () => {
    // Then the lines differ by the thing that matters to a vendor, and the
    // room is PPP's business again (R4.25).
    const draft = await buildSupplierOrderDraft(input());
    const bath = draft.gallonEstimates.find((e) => e.isBathroom)!;
    const { body } = await buildSupplierOrderDraft(
      input({
        materialTypeOverrides: {
          [quantityKey(bath.colorId, bath.finish, true)]: "Aura Bath & Spa",
        },
      })
    );
    expect(body).toContain("Aura Bath & Spa");
    expect(body).not.toMatch(/\(bathroom\)/);
  });

  it("an ordinary job never carries the note", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({ woliRows: [woli("wl-1", "Hallway", 6, 20), woli("wl-2", "Bedroom", 10, 12)] })
    );
    expect(body).not.toMatch(/\(bathroom\)/);
    expect(orderLines(body)).toHaveLength(1);
  });

  it("a bathroom in a color used nowhere else is not labelled either", async () => {
    // Nothing to be confused with, so nothing to explain.
    const { body } = await buildSupplierOrderDraft(input({ woliRows: [woli("wl-2", "Bathroom", 5, 8)] }));
    expect(body).not.toMatch(/\(bathroom\)/);
  });
});
