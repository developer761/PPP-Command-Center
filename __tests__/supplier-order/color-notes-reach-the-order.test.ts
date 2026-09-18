import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import { extractCustomerFreeText, extractMachineColorLines } from "@/lib/customer-form/notes";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * Color Notes — who they are for.
 *
 * R4.14 (Kate): color notes inform the ESTIMATOR, not the supplier. The order
 * page shows them so the estimator can see what the AM or customer wrote, and
 * when something in there needs buying the estimator adds a custom color item,
 * which reaches the email as a real line.
 *
 * Katie item 23 (2026-09-08) put the rep's free text back into the vendor email
 * for WO 00316248, where a rep wrote "see notes for colors" and put the exterior
 * colors only in Color Notes. Kate, 2026-09-15: "we don't need the color notes
 * in the email." The order page already said "this does NOT go to the vendor",
 * so the screen and the email disagreed. R4.14 stands; Katie's case is handled
 * the way R4.14 intended — the estimator sees the colors, labelled, on the order
 * page and adds them as custom color items.
 *
 * Asserts the RENDERED email body, not builder source text.
 */

/** Verbatim from WO 00316248. */
const REAL = [
  "Customer notes: Siding: HC-6 Windham Cream - Low Lustre",
  "Trim: OC-95 Navajo White - Soft Gloss",
  "Shutters, Doors, and Iron Railings: 447 Holiday Wreath - Satin",
].join("\n");

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001",
  name: "2108-40 Stardust",
  shortName: "Stardust",
  code: "2108-40",
  collection: null,
  hexValue: null,
  manufacturerId: "001MANUFACTURER",
};

function input(over: Partial<SnapshotWoli> = {}, extra: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  const workOrder = {
    id: "0WO000000316248",
    workOrderNumber: "00316248",
    workTypeName: "Exterior Painting",
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
    primer: null,
    prepLevel: null,
    productFamily: "Exterior Painting",
    interiorExterior: "Exterior",
    numClosets: 0,
    numDoors: 0,
    numWindows: 0,
    productName: null,
    totalPrice: 0,
    colorWallId: COLOR.id,
    colorCeilingId: null,
    colorTrimId: null,
    colorOtherId: null,
    colorFloorId: null,
    finishWall: "Low Lustre",
    finishCeiling: null,
    finishTrim: null,
    finishOther: null,
    finishFloor: null,
    colorNotes: REAL,
    description: "see notes for colors",
    sortOrder: 1,
    changeOrderRelated: false,
    ...over,
  } as SnapshotWoli;
  const store = { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount;
  return {
    workOrder,
    woliRows: [woli],
    paintColorsById: new Map([[COLOR.id, COLOR]]),
    customerAccount: null,
    supplierAccountId: store.id,
    supplierAccount: store,
    customerSubmittedPayload: null,
    fulfillmentMethod: "pickup",
    extras: [],
    includeAllColors: true,
    ...extra,
  };
}

describe("why Katie's colors were invisible to the order path", () => {
  it("the machine parser finds nothing in a rep's free text", () => {
    expect(extractMachineColorLines(REAL)).toEqual([]);
  });

  it("the free-text parser finds the colors — which is what the order page shows", () => {
    const t = extractCustomerFreeText(REAL);
    expect(t).toContain("HC-6 Windham Cream");
    expect(t).toContain("447 Holiday Wreath");
  });
});

describe("the vendor email does not carry color notes", () => {
  it("the email is real: the picked color reaches it", async () => {
    // Without this, "the notes are absent" would also pass on an empty body.
    const draft = await buildSupplierOrderDraft(input());
    expect(draft.body).toContain("Stardust");
    expect(draft.body.length).toBeGreaterThan(200);
  });

  it("a rep's free-text colors stay off the email", async () => {
    const { body } = await buildSupplierOrderDraft(input());
    expect(body).not.toMatch(/COLOR NOTES/i);
    expect(body).not.toContain("Windham Cream");
    expect(body).not.toContain("Navajo White");
    expect(body).not.toContain("Holiday Wreath");
  });

  it("an edited Color Notes box on the order page stays off the email too", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({}, { colorNotes: "Deck: Gray Minwax\nNot painting: Living Room · Trim" }),
    );
    expect(body).not.toContain("Minwax");
    expect(body).not.toContain("Not painting");
  });

  it("the estimator still gets the notes on the order page", async () => {
    // colorNotesDefault pre-fills the page's Color Notes box. The customer's
    // notes go there — and, per the previous test, no further.
    const draft = await buildSupplierOrderDraft(
      input({}, {
        customerSubmittedPayload: { lineItems: [], globalNotes: "please match the existing shutters" },
      }),
    );
    expect(draft.colorNotesDefault).toContain("match the existing shutters");
  });

  it("a custom color item the estimator adds DOES reach the vendor", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({}, {
        customColorItems: [{ id: "c1", label: "HC-6 Windham Cream - Low Lustre", qty: 5, unit: "gallon" }],
      }),
    );
    expect(body).toContain("Windham Cream");
    expect(body).toContain("5 gallon");
  });

  it("…and a slipped keystroke on its quantity is capped before the store sees it", async () => {
    // Every other quantity is clamped at three boundaries; this one is
    // hand-typed and goes straight into the email. Its clamp had no test at
    // all (mutation testing, 2026-09-17) — removing it sent a paint store an
    // order for five thousand gallons of stain.
    const { body } = await buildSupplierOrderDraft(
      input({}, { customColorItems: [{ id: "c1", label: "Deck stain", qty: 5000, unit: "gal" }] }),
    );
    expect(body).toContain("99 gal — Deck stain");
    expect(body).not.toContain("5000");
  });

  it("…and a zero or a missing quantity still orders one, not none", async () => {
    const { body } = await buildSupplierOrderDraft(
      input({}, { customColorItems: [{ id: "c1", label: "Deck stain", qty: 0, unit: "gal" }] }),
    );
    expect(body).toContain("1 gal — Deck stain");
  });
});
