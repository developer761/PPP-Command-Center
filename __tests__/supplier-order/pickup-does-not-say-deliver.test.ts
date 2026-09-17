import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { render, DEFAULT_SUPPLIER_TEMPLATE } from "@/lib/supplier-order/templates";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * A pickup order printed "Deliver on: Sat, Sep 20, by 8AM" directly above
 * "Fulfillment: PICKUP at 325 E Gate Blvd" — telling the vendor to deliver and
 * then telling them not to. Unconditional since the template was written.
 */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function input(fulfillmentMethod: "delivery" | "pickup"): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000000041", workOrderNumber: "00300041", workTypeName: "Interior Painting",
      accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
    } as unknown as SnapshotWorkOrder,
    woliRows: [{
      id: "wl-1", workOrderId: "0WO000000000041", status: "New", areaLabel: "Bedroom", surfaces: "Walls",
      sqFootage: 180, wallSurfaceArea: 0, perimeter: 54, heightFt: 8,
      numCoats: 0, primer: null, prepLevel: null,
      productFamily: "Interior Painting", interiorExterior: "Interior",
      numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
      colorWallId: COLOR.id, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
      finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
      colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
    } as SnapshotWoli],
    paintColorsById: new Map([[COLOR.id, COLOR]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs", billingStreet: "325 E Gate Blvd", billingCity: "Garden City" } as SnapshotAccount,
    customerSubmittedPayload: null,
    fulfillmentMethod,
    pickupLocation: fulfillmentMethod === "pickup" ? "Primary" : undefined,
    extras: [], includeAllColors: true, materialType: "Regal Select",
  };
}

describe("what the vendor is asked to do", () => {
  it("a PICKUP order never says deliver", async () => {
    const { body } = await buildSupplierOrderDraft(input("pickup"));
    expect(body).toMatch(/PICKUP/);
    expect(body).not.toMatch(/Deliver on:/i);
    // …and still carries the date, in words that fit a pickup.
    expect(body).toMatch(/Needed by: \w/);
  });

  it("a DELIVERY order still says deliver, with the time", async () => {
    const { body } = await buildSupplierOrderDraft(input("delivery"));
    expect(body).toMatch(/Deliver on: .+, by \w/);
    expect(body).not.toMatch(/Needed by:/);
  });
});

describe("the renderer's inverted section", () => {
  it("renders the block when the variable is empty, and not when it is set", () => {
    const t = "{{#flag}}ON{{/flag}}{{^flag}}OFF{{/flag}}";
    expect(render(t, { flag: "yes" })).toBe("ON");
    expect(render(t, { flag: "" })).toBe("OFF");
    expect(render(t, { flag: null })).toBe("OFF");
    expect(render(t, {})).toBe("OFF");
    // Whitespace-only is empty — the same rule the positive section uses.
    expect(render(t, { flag: "   " })).toBe("OFF");
  });

  it("leaves the default template's other sections alone", () => {
    const out = render(DEFAULT_SUPPLIER_TEMPLATE.intro, {
      ppp_brand: "Precision Painting Plus", po_number: "00300041",
      required_by_date: "Sat, Sep 20", delivery_time: "8AM",
      fulfillment_block: "PICKUP at Primary", customer_name: "Jane Doe",
      ppp_account_number: "", is_delivery: "",
    });
    expect(out).toContain("This order is for Jane Doe.");
    expect(out).not.toContain("account )");
    expect(out).not.toMatch(/\{\{/);
  });
});
