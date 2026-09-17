import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { quantityKey } from "@/lib/supplier-order/estimate-gallons";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * R4.3, second half — Kate tied the split picker to the round-2 ask that the
 * product line "default to the AM's Internal Entry pick".
 *
 * With TWO picks, carrying only the interior one to the order would put
 * exterior colors on an interior product — the exact failure splitting the
 * picker was meant to prevent. So the exterior pick is applied to the colors
 * actually painted outside, as per-color overrides.
 *
 * This file used to assert on builder.ts SOURCE TEXT — that a particular `if`
 * existed, in that spelling. It went red on a rename that changed no behaviour
 * (2026-09-17) and would have stayed green if the map had stopped reaching the
 * email. It reads the rendered email now.
 */

const INT: SnapshotPaintColor = {
  id: "a02INTERIOR00001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};
const EXT: SnapshotPaintColor = {
  id: "a02EXTERIOR00001", name: "HC-6 Windham Cream", shortName: "Windham Cream", code: "HC-6",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function woli(id: string, productName: string, colorId: string, areaLabel: string): SnapshotWoli {
  return {
    id, workOrderId: "0WO000000000021", status: "New",
    areaLabel, surfaces: "Walls",
    sqFootage: 200, wallSurfaceArea: 0, perimeter: 60, heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: productName, interiorExterior: productName.includes("Exterior") ? "Exterior" : "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName, totalPrice: 0,
    colorWallId: colorId, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Satin", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
}

/** A mixed job: one interior room, one exterior elevation. */
function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000000021", workOrderNumber: "00300021", workTypeName: null,
      accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
    } as unknown as SnapshotWorkOrder,
    woliRows: [
      woli("wl-int", "Interior Painting", INT.id, "Living Room"),
      woli("wl-ext", "Exterior Painting", EXT.id, "Front elevation"),
    ],
    paintColorsById: new Map([[INT.id, INT], [EXT.id, EXT]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: {
      lineItems: [],
      materialType: "Regal Select",
      materialTypeExterior: "Mooreguard Low Lustre",
    },
    fulfillmentMethod: "pickup", extras: [], includeAllColors: true,
    ...over,
  };
}

/** The line a vendor reads for one color. */
function lineFor(body: string, colorName: string): string {
  return body.split("\n").find((l) => l.includes(colorName)) ?? "";
}

describe("the exterior paint line reaches the order", () => {
  it("the exterior color is ordered on the AM's EXTERIOR pick", async () => {
    const { body } = await buildSupplierOrderDraft(input());
    expect(lineFor(body, "Windham Cream")).toContain("Mooreguard Low Lustre");
  });

  it("…and the interior color is not", async () => {
    const { body } = await buildSupplierOrderDraft(input());
    const interior = lineFor(body, "White Dove");
    expect(interior).toContain("Regal Select");
    expect(interior).not.toContain("Mooreguard");
  });

  it("a color used on BOTH scopes keeps the job default", async () => {
    // Ambiguous: guessing is worse than leaving it for the estimator.
    const { body } = await buildSupplierOrderDraft(
      input({
        woliRows: [
          woli("wl-int", "Interior Painting", INT.id, "Living Room"),
          woli("wl-ext", "Exterior Painting", INT.id, "Front elevation"),
        ],
        paintColorsById: new Map([[INT.id, INT]]),
      })
    );
    expect(lineFor(body, "White Dove")).toContain("Regal Select");
  });

  it("never overrides an explicit choice by the estimator", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({
        materialTypeOverrides: { [quantityKey(EXT.id, "Satin")]: "Moorlife Flat" },
      })
    );
    const ext = lineFor(body, "Windham Cream");
    expect(ext).toContain("Moorlife Flat");
    expect(ext).not.toContain("Mooreguard");
  });

  it("the draft reports the same line it emailed", async () => {
    // Two maps would let the screen and the vendor's copy disagree.
    const draft = await buildSupplierOrderDraft(input());
    const key = quantityKey(EXT.id, "Satin");
    expect(draft.resolvedMaterialTypeOverrides[key]).toBe("Mooreguard Low Lustre");
    expect(lineFor(draft.body, "Windham Cream")).toContain("Mooreguard Low Lustre");
  });
});
