import { describe, it, expect, vi } from "vitest";

// No database in this suite: without a stub `nextPoNumber` falls to its
// offline "-t<timestamp>" branch and the PO can never be asserted. An empty
// table is also the honest fixture — this work order has no prior orders.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  }),
}));
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * Jason's notes from testing the paint tool with Adler and Ido, forwarded by
 * Alex → Katie (2026-09-24). Everything here asserts on the RENDERED EMAIL,
 * which is the thing he was reading when he wrote them down.
 *
 *   · "loose the wording fulfilment"
 *   · "please add clients last name as part of the po number"
 *   · "we do not need the work order (po number) listed twice"
 *
 * (The fourth — room dimensions instead of the surface-area calculation — is
 *  on the build screen, not in the email; see room-dimensions.test.ts.)
 */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000318847", workOrderNumber: "00318847", workTypeName: "Interior Painting",
      accountName: "John Smith", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
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
    customerSubmittedPayload: {
      lineItems: [],
      deliveryAddress: { street: "825 East Gate Blvd Suite 200", city: "Garden City", state: "NY", postalCode: "11530" },
    } as unknown as BuildSupplierOrderInput["customerSubmittedPayload"],
    extras: [], includeAllColors: true, materialType: "Ultra Spec Interior",
    ...over,
  } as BuildSupplierOrderInput;
}

describe("the word 'Fulfillment'", () => {
  it("is gone from the email", async () => {
    const { body } = await buildSupplierOrderDraft(input());
    expect(body).not.toMatch(/fulfilment|fulfillment/i);
  });

  it("but the vendor is still told what to do with the order", async () => {
    // Losing the label must not lose the instruction — that would be a worse
    // answer to the note than leaving it alone.
    const delivery = await buildSupplierOrderDraft(input());
    expect(delivery.body).toMatch(/DELIVERY to:/);
    expect(delivery.body).toContain("825 East Gate Blvd");

    const pickup = await buildSupplierOrderDraft(
      input({ fulfillmentMethod: "pickup", pickupLocation: "Aboffs Huntington" })
    );
    expect(pickup.body).toMatch(/PICKUP at Aboffs Huntington/);
  });
});

describe("the PO number", () => {
  it("carries the client's last name", async () => {
    const { body, poNumber } = await buildSupplierOrderDraft(input());
    expect(poNumber).toBe("00318847 Smith");
    expect(body).toContain("PO Number: 00318847 Smith");
  });

  it("takes the name from the ACCOUNT when one resolved", async () => {
    const { poNumber } = await buildSupplierOrderDraft(
      input({ customerAccount: { id: "001C", name: "Mary Anne Delgado" } as SnapshotAccount })
    );
    expect(poNumber).toBe("00318847 Delgado");
  });

  it("and is just the work order number when there is no name to use", async () => {
    const { poNumber } = await buildSupplierOrderDraft(
      input({ workOrder: { id: "0WO000000318847", workOrderNumber: "00318847", accountName: null } as unknown as SnapshotWorkOrder })
    );
    expect(poNumber).toBe("00318847");
  });
});

describe("the work order number", () => {
  it("appears once, not twice", async () => {
    // It read "PO Number: 00318847" and then, three lines down in the ship-to,
    // "Precision Painting Plus — WO #00318847".
    const { body } = await buildSupplierOrderDraft(
      input({ workOrder: { id: "0WO000000318847", workOrderNumber: "00318847", accountName: null } as unknown as SnapshotWorkOrder })
    );
    const hits = body.match(/00318847/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(body).not.toMatch(/WO #00318847/);
  });

  it("and the delivery still has somebody to address the pallet to", async () => {
    // Dropping the duplicate must not leave the ship-to block headless.
    const { body } = await buildSupplierOrderDraft(
      input({ workOrder: { id: "0WO000000318847", workOrderNumber: "00318847", accountName: null } as unknown as SnapshotWorkOrder })
    );
    const shipTo = body.slice(body.indexOf("DELIVERY to:"));
    expect(shipTo).toContain("Precision Painting Plus");
    expect(shipTo).toContain("825 East Gate Blvd");
  });

  it("a real customer's name is what the pallet is addressed to", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({ customerAccount: { id: "001C", name: "John Smith" } as SnapshotAccount })
    );
    const shipTo = body.slice(body.indexOf("DELIVERY to:"));
    expect(shipTo).toContain("John Smith");
  });
});

/* ── the screen said "Other", the vendor was sent [NOT SET] ──────────────── */

describe("a bare 'Other' product line", () => {
  // Found while verifying Jason's notes on WO 00318014 (2026-09-29): the buy
  // list showed "Product line: Other" on the bathroom's walls and the email
  // printed "[NOT SET]" for the same line.
  //
  // The EMAIL is right — Katie item 11: a paint counter cannot fill an order
  // for "Other", so a bare Other resolves to nothing and the line says so.
  // What was wrong is that the closed picker looked answered, so nobody could
  // tell. These pin the email half; the screen now carries a note beside the
  // picker saying what the vendor will see.
  const KEY = "a02COLOR0000001::Eggshell";
  const OTHER_COLOR: SnapshotPaintColor = { ...COLOR, id: "a02COLOR0000002", name: "Super White", shortName: "Super White", code: null };
  const OTHER_KEY = "a02COLOR0000002::Flat";

  /** Two colors, because a bare Other only prints "[NOT SET]" when SOMETHING
   *  else on the order has a product — otherwise the segment is omitted from
   *  every line rather than stamping [NOT SET] down the page. That is the
   *  shape of a real order, and of WO 00318014 where this was found. */
  const twoColors = (overrides: Record<string, string>) =>
    input({
      materialType: "",
      materialTypeOverrides: overrides,
      paintColorsById: new Map([[COLOR.id, COLOR], [OTHER_COLOR.id, OTHER_COLOR]]),
      woliRows: [
        ...input().woliRows,
        { ...input().woliRows[0], id: "wl-2", areaLabel: "Bedroom", surfaces: "Ceiling",
          colorWallId: null, colorCeilingId: OTHER_COLOR.id, finishWall: null, finishCeiling: "Flat" } as SnapshotWoli,
      ],
    });

  it("reaches the vendor as [NOT SET], not as the word Other", async () => {
    const { body } = await buildSupplierOrderDraft(
      twoColors({ [KEY]: "Other", [OTHER_KEY]: "Ultra Spec Interior" })
    );
    expect(body).toContain("[NOT SET]");
    expect(body).not.toMatch(/—\s*Other\s*—/);
  });

  it("but an Other with the product typed in reaches them as that product", async () => {
    const { body } = await buildSupplierOrderDraft(
      twoColors({ [KEY]: "Other: Behr Premium Plus", [OTHER_KEY]: "Ultra Spec Interior" })
    );
    expect(body).toContain("Behr Premium Plus");
    expect(body).not.toContain("[NOT SET]");
    // The "Other: " prefix is PPP's bookkeeping and is not the vendor's business.
    expect(body).not.toContain("Other: Behr");
  });
});
