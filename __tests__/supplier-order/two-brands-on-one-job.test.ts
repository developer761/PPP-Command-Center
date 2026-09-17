import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { quantityKey } from "@/lib/supplier-order/estimate-gallons";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * A hand-picked store order carries EVERY color on the work order, whatever
 * the brand. That is deliberate — PPP buys Benjamin Moore and
 * Sherwin-Williams from the same counter, and filtering by manufacturer would
 * send a store half a job.
 *
 * The cost of it: on a job that genuinely spans two brands, ordering from two
 * vendors gives each of them the whole list, and the paint is bought twice
 * unless the estimator zeroes the other brand's lines. They can only do that
 * if the screen tells them which line is which brand — and it never did.
 */

const BM: SnapshotPaintColor = {
  id: "a02BM00000000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001BENJAMINMOORE",
};
const SW: SnapshotPaintColor = {
  id: "a02SW00000000001", name: "SW6462 Green Trance", shortName: "Green Trance", code: "SW6462",
  collection: null, hexValue: null, manufacturerId: "001SHERWIN000001",
};

function woli(id: string, colorId: string, areaLabel: string): SnapshotWoli {
  return {
    id, workOrderId: "0WO000000000061", status: "New", areaLabel, surfaces: "Walls",
    sqFootage: 180, wallSurfaceArea: 0, perimeter: 54, heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: "Interior Painting", interiorExterior: "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
    colorWallId: colorId, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
}

function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000000061", workOrderNumber: "00300061", workTypeName: "Interior Painting",
      accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
    } as unknown as SnapshotWorkOrder,
    woliRows: [woli("wl-1", BM.id, "Living Room"), woli("wl-2", SW.id, "Study")],
    paintColorsById: new Map([[BM.id, BM], [SW.id, SW]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: null,
    fulfillmentMethod: "pickup", extras: [], includeAllColors: true, materialType: "Regal Select",
    manufacturerNames: { "001BENJAMINMOORE": "Benjamin Moore", "001SHERWIN000001": "Sherwin-Williams" },
    ...over,
  };
}

describe("a job that spans two paint brands", () => {
  it("names the brand of every color line", async () => {
    const draft = await buildSupplierOrderDraft(input());
    expect(draft.colorBrands[quantityKey(BM.id, "Eggshell")]).toBe("Benjamin Moore");
    expect(draft.colorBrands[quantityKey(SW.id, "Eggshell")]).toBe("Sherwin-Williams");
  });

  it("still puts BOTH on the order — the store sells both", async () => {
    // Filtering by manufacturer here would send the store half a job. The fix
    // for double-ordering is telling the estimator, not hiding lines.
    const { body } = await buildSupplierOrderDraft(input());
    expect(body).toContain("White Dove");
    expect(body).toContain("Green Trance");
  });

  it("says nothing about brands when a job has only one", async () => {
    const draft = await buildSupplierOrderDraft(
      input({
        woliRows: [woli("wl-1", BM.id, "Living Room"), woli("wl-2", BM.id, "Study")],
        paintColorsById: new Map([[BM.id, BM]]),
      })
    );
    expect(new Set(Object.values(draft.colorBrands)).size).toBe(1);
  });

  it("copes when the manufacturer has no name on file", async () => {
    const draft = await buildSupplierOrderDraft(input({ manufacturerNames: {} }));
    expect(draft.colorBrands).toEqual({});
  });

  it("keys the brand the same way the row does, bathrooms included", async () => {
    const draft = await buildSupplierOrderDraft(
      input({ woliRows: [woli("wl-1", BM.id, "Bathroom"), woli("wl-2", SW.id, "Study")] })
    );
    // The bathroom line's key carries ::bath — a brand keyed the plain way
    // would simply not show on it.
    expect(draft.colorBrands[quantityKey(BM.id, "Eggshell", true)]).toBe("Benjamin Moore");
  });
});
