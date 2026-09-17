import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { PAINT_LINE_VALUES, finishOptionsFor, ALL_FINISH_VALUES, toSalesforceMaterialType } from "@/lib/customer-form/material-types";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * Jason + Alex, 2026-09-17: "On paint drop down options — need options of Ultra
 * Spec Interior, Ultra Spec Exterior … And this indication needs to transfer to
 * the material order email."
 *
 * Plus the two bathroom products, which exist so a bathroom sharing the hall's
 * color can be bought as a different product.
 *
 * Asserts the RENDERED email body, because "it's in the picker" is not the ask.
 */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001",
  name: "HC-6 Windham Cream",
  shortName: "Windham Cream",
  code: "HC-6",
  collection: null,
  hexValue: null,
  manufacturerId: "001MANUFACTURER",
};

function input(materialType: string, workTypeName = "Exterior Painting"): BuildSupplierOrderInput {
  const workOrder = {
    id: "0WO000000000001",
    workOrderNumber: "00300001",
    workTypeName,
    accountName: "Test Customer",
    closeDate: null,
    createdDate: "2026-09-01T00:00:00Z",
  } as unknown as SnapshotWorkOrder;
  const woli = {
    id: "1WL000000000001",
    workOrderId: workOrder.id,
    status: "New",
    areaLabel: "Exterior",
    surfaces: "Siding",
    sqFootage: 0,
    wallSurfaceArea: 1200,
    perimeter: 0,
    heightFt: 0,
    numCoats: 2,
    primer: null, prepLevel: null,
    productFamily: workTypeName, interiorExterior: workTypeName.includes("Exterior") ? "Exterior" : "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0,
    productName: null, totalPrice: 0,
    colorWallId: COLOR.id,
    colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Satin",
    finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
  return {
    workOrder,
    woliRows: [woli],
    paintColorsById: new Map([[COLOR.id, COLOR]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    customerSubmittedPayload: null,
    fulfillmentMethod: "pickup",
    extras: [],
    includeAllColors: true,
    materialType,
  };
}

describe("the paint line the estimator picks reaches the vendor", () => {
  it("Ultra Spec Exterior prints on the order line, scope and all", async () => {
    const { body } = await buildSupplierOrderDraft(input("Ultra Spec Exterior"));
    expect(body).toContain("Ultra Spec Exterior");
    expect(body).toContain("Windham Cream");
  });

  it("Ultra Spec Interior does too", async () => {
    const { body } = await buildSupplierOrderDraft(input("Ultra Spec Interior", "Interior Painting"));
    expect(body).toContain("Ultra Spec Interior");
  });

  it("the bathroom products print as themselves, not as their parent line", async () => {
    for (const product of ["Aura Bath & Spa", "Regal Select Kitchen & Bath"]) {
      const { body } = await buildSupplierOrderDraft(input(product, "Interior Painting"));
      expect(body).toContain(product);
    }
  });

  it("no order ever says the line is unspecified when one was picked", async () => {
    const { body } = await buildSupplierOrderDraft(input("Ultra Spec Exterior"));
    expect(body).not.toMatch(/product line not specified/i);
    expect(body).not.toContain("[NOT SET]");
  });
});

describe("the new products are real products, not just strings", () => {
  it("each is in the picker vocabulary", () => {
    for (const v of ["Ultra Spec Interior", "Ultra Spec Exterior", "Aura Bath & Spa", "Regal Select Kitchen & Bath"]) {
      expect(PAINT_LINE_VALUES).toContain(v);
    }
  });

  it("each offers only finishes it is sold in — and every one is server-valid", () => {
    const cases: Array<[string, "interior" | "exterior", string[]]> = [
      ["Ultra Spec Interior", "interior", ["Flat", "Eggshell", "Satin", "Semi-Gloss"]],
      ["Ultra Spec Exterior", "exterior", ["Low Lustre", "Satin", "Soft Gloss"]],
      ["Aura Bath & Spa", "interior", ["Matte"]],
      ["Regal Select Kitchen & Bath", "interior", ["Pearl"]],
    ];
    for (const [product, scope, expected] of cases) {
      const offered = finishOptionsFor([...ALL_FINISH_VALUES], product, scope);
      expect(offered).toEqual(expected);
      // The submit route validates against ALL_FINISH_VALUES; a dropdown option
      // the server rejects is the 400 that told a customer their own valid
      // choice was invalid (2026-09-09).
      for (const f of offered) expect(ALL_FINISH_VALUES.has(f)).toBe(true);
    }
  });

  it("a bathroom product still records as its paint line in Salesforce", () => {
    // The org's picklist has no bathroom value. Skipping the write would have
    // been a silent regression — the legacy "Aura Bath & Spa Matte" value
    // always recorded as Aura Interior.
    const INTERIOR = { workTypeName: "Interior Painting" };
    expect(toSalesforceMaterialType("Aura Bath & Spa", INTERIOR)).toBe("Aura Interior");
    expect(toSalesforceMaterialType("Regal Select Kitchen & Bath", INTERIOR)).toBe("Regal Select Interior");
    expect(toSalesforceMaterialType("Ultra Spec Interior", INTERIOR)).toBe("Ultra Spec Interior");
    expect(toSalesforceMaterialType("Ultra Spec Exterior", { workTypeName: "Exterior Painting" })).toBe("Ultra Spec Exterior");
  });
});
