import { describe, it, expect } from "vitest";
import {
  estimateOrderGallons,
  applyQuantityOverrides,
  claimedPlainKeys,
  lookupByKey,
  quantityKey,
  readProductOverride,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";
import { buildSupplierOrderDraft, type BuildSupplierOrderInput } from "@/lib/supplier-order/builder";
import type { SnapshotAccount, SnapshotPaintColor, SnapshotWoli, SnapshotWorkOrder } from "@/lib/salesforce/queries";

/**
 * The shape the split was invented for, and the one its first round of tests
 * never built: ONE color on the hall walls AND the bathroom walls.
 *
 * The pre-split-key fallback added on 2026-09-17 assumed a bathroom line's
 * plain `colorId::finish` key could only be a leftover from before the deploy.
 * On this job it is the HALL's own live key — so the bathroom read the hall's
 * gallons, a typed zero on the hall marked the bathroom "not ordering", the
 * hall's interior product printed on the bathroom's line, and touching the
 * bathroom row deleted the hall's saved quantity outright.
 */

const walls = (colorId: string) => ({
  kind: "walls" as const, surfaceLabel: "Walls", colorId,
  colorName: "White Dove", colorCode: "OC-17", finish: "Eggshell",
});

function room(label: string, w: number, l: number): RoomTakeoff {
  return {
    woliId: `woli-${label}`, roomLabel: label,
    floorAreaSqft: w * l, wallSurfaceAreaSqft: 0, perimeterLf: 2 * (w + l), heightFt: 8,
    doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [walls("white")],
  };
}

const JOB = () => estimateOrderGallons([room("Hallway", 6, 20), room("Bathroom", 5, 8)]);

describe("one color, the hall and the bathroom", () => {
  it("is two lines that each keep their own number", () => {
    const out = JOB();
    const hall = out.find((e) => !e.isBathroom)!;
    const bath = out.find((e) => e.isBathroom)!;
    const typed = new Map([[quantityKey(hall.colorId, hall.finish), { buckets: 0, cans: 6, unit: "gal" as const }]]);
    const applied = applyQuantityOverrides(out, typed);
    expect(applied.find((e) => !e.isBathroom)!.cans).toBe(6);
    // The bathroom must NOT read the hall's 6. Its own estimate stands.
    expect(applied.find((e) => e.isBathroom)!.cans).toBe(bath.cans);
  });

  it("a typed ZERO on the hall does not stop the bathroom being bought", () => {
    const out = JOB();
    const hall = out.find((e) => !e.isBathroom)!;
    const zeroed = new Map([[quantityKey(hall.colorId, hall.finish), { buckets: 0, cans: 0, unit: "gal" as const }]]);
    const applied = applyQuantityOverrides(out, zeroed);
    expect(applied.find((e) => !e.isBathroom)!.excluded).toBe(true);
    expect(applied.find((e) => e.isBathroom)!.excluded ?? false).toBe(false);
  });

  it("the fallback still works when the bathroom is the ONLY line in that color", () => {
    // A genuine pre-deploy draft: nothing else owns the plain key.
    const out = estimateOrderGallons([room("Bathroom", 5, 8)]);
    const legacy = new Map([[quantityKey(out[0].colorId, out[0].finish), { buckets: 0, cans: 4, unit: "gal" as const }]]);
    expect(applyQuantityOverrides(out, legacy)[0].cans).toBe(4);
  });

  it("claimedPlainKeys names exactly the non-bathroom lines", () => {
    const out = JOB();
    const claimed = claimedPlainKeys(out);
    expect(claimed.has(quantityKey("white", "Eggshell"))).toBe(true);
    expect(lookupByKey(new Map([[quantityKey("white", "Eggshell"), "x"]]), out.find((e) => e.isBathroom)!, claimed))
      .toBeUndefined();
  });
});

describe("a product, unlike a number, belongs to the color", () => {
  const bath = { colorId: "c1", finish: "Eggshell", isBathroom: true };
  const hall = { colorId: "c1", finish: "Eggshell", isBathroom: false };

  it("the bathroom reads the color's product when it has none of its own", () => {
    expect(readProductOverride({ "c1::Eggshell": "Aura" }, bath)).toBe("Aura");
    expect(readProductOverride(new Map([["c1::Eggshell", "Aura"]]), bath)).toBe("Aura");
  });

  it("its OWN product wins", () => {
    const rec = { "c1::Eggshell": "Aura", "c1::Eggshell::bath": "Aura Bath & Spa" };
    expect(readProductOverride(rec, bath)).toBe("Aura Bath & Spa");
    expect(readProductOverride(rec, hall)).toBe("Aura");
  });

  it("a non-bathroom line never reads a bathroom key, and nothing reads nothing", () => {
    expect(readProductOverride({ "c1::Eggshell::bath": "Aura Bath & Spa" }, hall)).toBeUndefined();
    expect(readProductOverride(undefined, bath)).toBeUndefined();
    expect(readProductOverride({}, bath)).toBeUndefined();
  });
});

/* ── the same job, all the way to the vendor ─────────────────────────────── */

const COLOR: SnapshotPaintColor = {
  id: "a02COLOR0000001", name: "OC-17 White Dove", shortName: "White Dove", code: "OC-17",
  collection: null, hexValue: null, manufacturerId: "001MANUFACTURER",
};

function woli(id: string, areaLabel: string, w: number, l: number): SnapshotWoli {
  return {
    id, workOrderId: "0WO000000000031", status: "New", areaLabel, surfaces: "Walls",
    sqFootage: w * l, wallSurfaceArea: 0, perimeter: 2 * (w + l), heightFt: 8,
    numCoats: 0, primer: null, prepLevel: null,
    productFamily: "Interior Painting", interiorExterior: "Interior",
    numClosets: 0, numDoors: 0, numWindows: 0, productName: null, totalPrice: 0,
    colorWallId: COLOR.id, colorCeilingId: null, colorTrimId: null, colorOtherId: null, colorFloorId: null,
    finishWall: "Eggshell", finishCeiling: null, finishTrim: null, finishOther: null, finishFloor: null,
    colorNotes: null, description: null, sortOrder: 1, changeOrderRelated: false,
  } as SnapshotWoli;
}

function draftInput(over: Partial<BuildSupplierOrderInput> = {}): BuildSupplierOrderInput {
  return {
    workOrder: {
      id: "0WO000000000031", workOrderNumber: "00300031", workTypeName: "Interior Painting",
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

describe("the vendor's copy of that job", () => {
  it("the bathroom INHERITS the color's product until somebody changes it", () => {
    // Reversed 2026-09-17 after reading a live email: splitting the bathroom
    // ceiling off its parent line meant it lost the product that line carried
    // and printed "[NOT SET]" to the vendor. The split exists so the bathroom
    // CAN take a different product — not so it starts with none.
    //
    // A QUANTITY is still never inherited (see the tests above): a number is
    // per line, a product is per color until someone says otherwise.
    return buildSupplierOrderDraft(
      draftInput({ materialTypeOverrides: { [quantityKey(COLOR.id, "Eggshell")]: "Aura" } })
    ).then(({ body }) => {
      expect(body).not.toContain("[NOT SET]");
      const lines = body.split("\n").filter((l) => l.includes("White Dove"));
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l).toContain("Aura");
    });
  });

  it("the bathroom's own product reaches the vendor", async () => {
    const { body } = await buildSupplierOrderDraft(
      draftInput({
        materialTypeOverrides: { [quantityKey(COLOR.id, "Eggshell", true)]: "Aura Bath & Spa" },
      })
    );
    const bathLine = body.split("\n").find((l) => l.includes("Aura Bath & Spa")) ?? "";
    expect(bathLine).toContain("White Dove");
  });

  it("the hall's typed gallons are not repeated on the bathroom line", async () => {
    const { body } = await buildSupplierOrderDraft(
      draftInput({ quantityOverrides: { [quantityKey(COLOR.id, "Eggshell")]: { buckets: 0, cans: 6, unit: "gal" } } })
    );
    const sixes = body.split("\n").filter((l) => /\b6 gal\b/.test(l));
    expect(sixes).toHaveLength(1);
  });
});
