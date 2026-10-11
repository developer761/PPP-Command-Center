/**
 * The vendor order's delivery address, and the candidate that was missing.
 *
 * Until 2026-10-09 the order resolved an address from two sources only: what
 * the customer typed on their form, and the Account's BILLING address. The
 * work order's own SERVICE address — the house being painted — was not a
 * candidate, so a job with neither of those printed "DELIVERY — address TBD
 * (admin will confirm before send)" on the vendor email and somebody typed
 * it by hand.
 *
 * Measured over 500 work orders created in the last year:
 *
 *     WO address AND account billing : 124
 *     WO address only                : 372   <- no candidate at all
 *     account billing only           :   0
 *     neither                        :   4
 *
 * Found while doing Kate's "display the customer's address" item on the
 * customer form, which had the same wrong source.
 */
import { describe, expect, it } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

const COLOR: SnapshotPaintColor = {
  id: "a0C000000000001", name: "Simply White", code: "OC-117", hex: "#F0EFE8",
} as unknown as SnapshotPaintColor;

const WO_ADDRESS = { street: "24 Deerfield Trail", city: "South Brunswick Township", state: "NJ", postalCode: "08852" };

function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000318847", workOrderNumber: "00318847", workTypeName: "Interior Painting",
      accountName: "John Smith", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
      ...WO_ADDRESS,
    } as unknown as SnapshotWorkOrder,
    woliRows: [{
      id: "wl-1", workOrderId: "0WO000000318847", status: "New", areaLabel: "Living Room", surfaces: "Walls",
      sqFootage: 320, wallSurfaceArea: 0, perimeter: 72, heightFt: 9,
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
    fulfillmentMethod: "delivery",
    customerSubmittedPayload: null,
    extras: [], includeAllColors: true, materialType: "Ultra Spec Interior",
    ...over,
  } as BuildSupplierOrderInput;
}

describe("where the materials get delivered", () => {
  it("uses the work order's address when nothing else has one", () => {
    // The 372. Before this there was no candidate and the email said TBD.
    return buildSupplierOrderDraft(input()).then((d) => {
      expect(d.deliveryAddress?.source).toBe("work_order");
      expect(d.deliveryAddress?.street).toBe(WO_ADDRESS.street);
      expect(d.deliveryAddress?.postalCode).toBe(WO_ADDRESS.postalCode);
    });
  });

  it("puts the real address in the vendor email instead of TBD", () => {
    // The artifact, not the object — this is the sentence a store reads.
    return buildSupplierOrderDraft(input()).then((d) => {
      expect(d.body).toContain("24 Deerfield Trail");
      expect(d.body).not.toMatch(/address TBD/i);
    });
  });

  it("still lets the customer's own correction win", () => {
    return buildSupplierOrderDraft(input({
      customerSubmittedPayload: {
        lineItems: [],
        deliveryAddress: { street: "9 Elm St", city: "Garden City", state: "NY", postalCode: "11530" },
      } as unknown as BuildSupplierOrderInput["customerSubmittedPayload"],
    })).then((d) => {
      expect(d.deliveryAddress?.source).toBe("customer_form");
      expect(d.deliveryAddress?.street).toBe("9 Elm St");
    });
  });

  it("still beats the account's BILLING address", () => {
    // Billing is where the invoice goes, not necessarily the property.
    return buildSupplierOrderDraft(input({
      customerAccount: {
        id: "001C", name: "John Smith",
        billingStreet: "PO Box 12", billingCity: "Hicksville", billingState: "NY", billingPostalCode: "11801",
      } as SnapshotAccount,
    })).then((d) => {
      expect(d.deliveryAddress?.source).toBe("work_order");
      expect(d.deliveryAddress?.street).toBe(WO_ADDRESS.street);
    });
  });

  it("falls back to the account when the work order has none", () => {
    // Must not regress the 124 that carry both, nor anything account-only.
    return buildSupplierOrderDraft(input({
      workOrder: {
        id: "0WO1", workOrderNumber: "00318848", workTypeName: "Interior Painting",
        accountName: "John Smith", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
        street: null, city: null, state: null, postalCode: null,
      } as unknown as SnapshotWorkOrder,
      customerAccount: {
        id: "001C", name: "John Smith",
        billingStreet: "PO Box 12", billingCity: "Hicksville", billingState: "NY", billingPostalCode: "11801",
      } as SnapshotAccount,
    })).then((d) => {
      expect(d.deliveryAddress?.source).toBe("sf_account");
    });
  });

  it("refuses a half address rather than shipping to it", () => {
    // street + city + (state or zip), unchanged — a street with no town is
    // worse than admitting we do not know.
    return buildSupplierOrderDraft(input({
      workOrder: {
        id: "0WO2", workOrderNumber: "00318849", workTypeName: "Interior Painting",
        accountName: "John Smith", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
        street: "24 Deerfield Trail", city: null, state: null, postalCode: null,
      } as unknown as SnapshotWorkOrder,
    })).then((d) => {
      expect(d.deliveryAddress).toBeNull();
    });
  });
});
