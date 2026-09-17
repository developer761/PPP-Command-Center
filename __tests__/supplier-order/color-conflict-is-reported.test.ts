import { describe, it, expect } from "vitest";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * Two surfaces, two rules, and nobody was told.
 *
 * Rooms & Colors on the work-order page lets SALESFORCE win for a standard
 * surface — deliberately, so a rep who corrects a color in Salesforce after
 * the customer submitted is not masked. The order and the vendor email take
 * the customer's submitted payload first. So the screen could show Chantilly
 * Lace while the vendor was sent Simply White.
 *
 * Which should win is PPP's call (a failed writeback leaves Salesforce stale,
 * so payload-first is the safer default), so the builder reports the conflict
 * instead of resolving it quietly.
 */

const CUSTOMER_PICK: SnapshotPaintColor = {
  id: "a02CUSTOMER00001", name: "OC-117 Simply White", shortName: "Simply White", code: "OC-117",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};
const REP_CORRECTION: SnapshotPaintColor = {
  id: "a02REPFIXED00001", name: "OC-65 Chantilly Lace", shortName: "Chantilly Lace", code: "OC-65",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function input(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  const woli = {
    id: "wl-1", workOrderId: "0WO000000000051", status: "New", areaLabel: "Living Room", surfaces: "Walls",
    sqFootage: 180, wallSurfaceArea: 0, perimeter: 54, heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: "Interior Painting", interiorExterior: "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
    // What the REP put in Salesforce after the customer submitted.
    colorWallId: REP_CORRECTION.id,
    colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
  return {
    workOrder: {
      id: "0WO000000000051", workOrderNumber: "00300051", workTypeName: "Interior Painting",
      accountName: "Test Customer", closeDate: null, createdDate: "2026-09-01T00:00:00Z",
    } as unknown as SnapshotWorkOrder,
    woliRows: [woli],
    paintColorsById: new Map([[CUSTOMER_PICK.id, CUSTOMER_PICK], [REP_CORRECTION.id, REP_CORRECTION]]),
    customerAccount: null,
    supplierAccountId: "001STORE0000001",
    supplierAccount: { id: "001STORE0000001", name: "Aboffs" } as SnapshotAccount,
    // What the CUSTOMER submitted.
    customerSubmittedPayload: {
      lineItems: [{
        id: "wl-1",
        surfaces: [{ surface: "Walls", colorId: CUSTOMER_PICK.id, colorName: CUSTOMER_PICK.name, colorCode: CUSTOMER_PICK.code, finish: "Eggshell" }],
        notes: "",
      }],
    },
    fulfillmentMethod: "pickup", extras: [], includeAllColors: true, materialType: "Regal Select",
    ...over,
  };
}

describe("when Salesforce and the customer's form disagree", () => {
  it("the conflict is reported, naming both colors and where", async () => {
    const draft = await buildSupplierOrderDraft(input());
    expect(draft.colorConflicts).toHaveLength(1);
    expect(draft.colorConflicts[0]).toMatchObject({
      roomLabel: "Living Room",
      surface: "Walls",
      orderingName: "OC-117 Simply White",
      salesforceName: "OC-65 Chantilly Lace",
    });
  });

  it("the order still buys the customer's pick — the behaviour is unchanged", async () => {
    // Reporting is not resolving. A failed Salesforce writeback leaves the org
    // stale, so flipping the precedence here would be its own bug; this exists
    // so a person can decide.
    const { body } = await buildSupplierOrderDraft(input());
    expect(body).toContain("Simply White");
    expect(body).not.toContain("Chantilly Lace");
  });

  it("says nothing when they agree", async () => {
    const draft = await buildSupplierOrderDraft(
      input({
        customerSubmittedPayload: {
          lineItems: [{
            id: "wl-1",
            surfaces: [{ surface: "Walls", colorId: REP_CORRECTION.id, colorName: REP_CORRECTION.name, colorCode: REP_CORRECTION.code, finish: "Eggshell" }],
            notes: "",
          }],
        },
      })
    );
    expect(draft.colorConflicts).toEqual([]);
  });

  it("says nothing when only ONE side has a color", async () => {
    // Salesforce empty + a customer pick is the normal first submission, not a
    // disagreement; the reverse is an internal-entry job with no form.
    const noSf = await buildSupplierOrderDraft(
      input({ woliRows: [{ ...input().woliRows[0], colorWallId: null } as SnapshotWoli] })
    );
    expect(noSf.colorConflicts).toEqual([]);

    const noPayload = await buildSupplierOrderDraft(input({ customerSubmittedPayload: null }));
    expect(noPayload.colorConflicts).toEqual([]);
  });
});
