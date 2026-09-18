import { describe, it, expect } from "vitest";
import { emptyBuildPayload, pruneToLiveKeys, type OrderBuildPayload } from "@/lib/supplier-order/build-state";
import { estimateOrderGallons, quantityKey, type RoomTakeoff } from "@/lib/supplier-order/estimate-gallons";

/**
 * The pre-split key fallback is a MIGRATION, and a migration that never
 * finishes is a trap.
 *
 * A bathroom line may read the plain `colorId::finish` key when no other line
 * claims it — right for a draft saved before 2026-09-17. But nothing pruned
 * the payload, so: the estimator types 4 gal for the hall's White Dove; the
 * customer later re-picks the hall in another color; the hall's key stops
 * being claimed; and the BATHROOM begins reading that 4 gal — and the hall's
 * product override with it. Screen and email agree, and both are wrong.
 */

const payload = (over: Partial<OrderBuildPayload> = {}): OrderBuildPayload => ({
  ...emptyBuildPayload(),
  ...over,
});

const live = (keys: Array<{ key: string; legacyKey?: string | null }>) =>
  keys.map((k) => ({ key: k.key, legacyKey: k.legacyKey ?? null }));

describe("keys no line claims any more", () => {
  it("are dropped once the draft shows the real line-up", () => {
    const p = payload({
      quantities: {
        "gone::Eggshell": { buckets: 0, cans: 4, unit: "gal" },
        "here::Eggshell": { buckets: 0, cans: 2, unit: "gal" },
      },
      materialTypeOverrides: { "gone::Eggshell": "Aura", "here::Eggshell": "Regal Select" },
    });
    const out = pruneToLiveKeys(p, live([{ key: "here::Eggshell" }]));
    expect(Object.keys(out.quantities)).toEqual(["here::Eggshell"]);
    expect(Object.keys(out.materialTypeOverrides)).toEqual(["here::Eggshell"]);
  });

  it("a bathroom's PRE-SPLIT key is migrated, not dropped", () => {
    // Somebody typed this before the deploy; it is still their answer.
    const p = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 6, unit: "gal" } } });
    const out = pruneToLiveKeys(p, live([{ key: "c1::Eggshell::bath", legacyKey: "c1::Eggshell" }]));
    expect(out.quantities["c1::Eggshell::bath"]).toEqual({ buckets: 0, cans: 6, unit: "gal" });
    expect(out.quantities["c1::Eggshell"]).toBeUndefined();
  });

  it("the bathroom cannot inherit a LIVE line's key", () => {
    // Both lines exist, so the plain key belongs to the hall and must stay
    // with it — and must NOT be copied onto the bathroom.
    //
    // The first version of this test asserted the copy, under this exact
    // title, with a comment saying the copy must not happen. It locked in 4
    // gallons nobody typed, on the wrong product, going to a vendor. A test
    // whose assertion contradicts its own name is worse than no test.
    const p = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 4, unit: "gal" } } });
    const out = pruneToLiveKeys(
      p,
      live([{ key: "c1::Eggshell" }, { key: "c1::Eggshell::bath", legacyKey: "c1::Eggshell" }])
    );
    expect(out.quantities["c1::Eggshell"]).toEqual({ buckets: 0, cans: 4, unit: "gal" });
    expect(out.quantities["c1::Eggshell::bath"]).toBeUndefined();
  });

  it("…nor a live line's PRODUCT", () => {
    const p = payload({ materialTypeOverrides: { "c1::Eggshell": "Regal Select" } });
    const out = pruneToLiveKeys(
      p,
      live([{ key: "c1::Eggshell" }, { key: "c1::Eggshell::bath", legacyKey: "c1::Eggshell" }])
    );
    expect(out.materialTypeOverrides["c1::Eggshell::bath"]).toBeUndefined();
  });

  it("a deliberate ZERO on the hall does not silence the bathroom", () => {
    const p = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 0, unit: "gal" } } });
    const out = pruneToLiveKeys(
      p,
      live([{ key: "c1::Eggshell" }, { key: "c1::Eggshell::bath", legacyKey: "c1::Eggshell" }])
    );
    expect(out.quantities["c1::Eggshell::bath"]).toBeUndefined();
  });

  it("the bathroom's OWN answer beats the pre-split one it could migrate", () => {
    // Both keys hold a value: the estimator typed 2 gal on the split bathroom
    // line, and an older draft had 6 gal under the pre-split key. The newer,
    // more specific answer wins — flipping the precedence would quietly
    // replace it with a number from before the deploy, and no test had both
    // keys populated to notice (mutation testing, 2026-09-17).
    const p = payload({
      quantities: {
        "c1::Eggshell": { buckets: 0, cans: 6, unit: "gal" },
        "c1::Eggshell::bath": { buckets: 0, cans: 2, unit: "gal" },
      },
      materialTypeOverrides: { "c1::Eggshell": "Regal Select", "c1::Eggshell::bath": "Aura Bath & Spa" },
    });
    const out = pruneToLiveKeys(p, live([{ key: "c1::Eggshell::bath", legacyKey: "c1::Eggshell" }]));
    expect(out.quantities["c1::Eggshell::bath"]).toEqual({ buckets: 0, cans: 2, unit: "gal" });
    expect(out.materialTypeOverrides["c1::Eggshell::bath"]).toBe("Aura Bath & Spa");
    // …and the pre-split key is retired either way.
    expect(out.quantities["c1::Eggshell"]).toBeUndefined();
  });

  it("does nothing at all before a draft has arrived", () => {
    // An empty line-up is "we don't know yet", not "nothing is live".
    const p = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 4, unit: "gal" } } });
    expect(pruneToLiveKeys(p, [])).toBe(p);
  });

  it("returns the SAME object when nothing changed", () => {
    // It runs in an effect; a new object every draft would loop.
    const p = payload({ quantities: { "c1::Eggshell": { buckets: 0, cans: 4, unit: "gal" } } });
    expect(pruneToLiveKeys(p, live([{ key: "c1::Eggshell" }]))).toBe(p);
  });

  it("leaves extras, custom items and notes alone", () => {
    const p = payload({
      extras: [{ extraId: "x1", name: "Tape", unit: "roll", qty: 2 }],
      customColorItems: [{ id: "cc-0", label: "Deck stain", qty: 1, unit: "gal" }],
      colorNotes: "keep me",
      mainMaterialType: "Regal Select",
    });
    const out = pruneToLiveKeys(p, live([{ key: "c1::Eggshell" }]));
    expect(out.extras).toEqual(p.extras);
    expect(out.customColorItems).toEqual(p.customColorItems);
    expect(out.colorNotes).toBe("keep me");
    expect(out.mainMaterialType).toBe("Regal Select");
  });
});

describe("against a real line-up", () => {
  const room = (label: string, colorId: string): RoomTakeoff => ({
    woliId: `w-${label}`, roomLabel: label,
    floorAreaSqft: 180, wallSurfaceAreaSqft: 0, perimeterLf: 54, heightFt: 8,
    doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [{ kind: "walls", surfaceLabel: "Walls", colorId, colorName: "White Dove", colorCode: "OC-17", finish: "Eggshell" }],
  });

  it("the hall's orphaned quantity does not migrate onto the bathroom", () => {
    // The job now has only a bathroom in that color — the hall was re-picked.
    const out = estimateOrderGallons([room("Bathroom", "white")]);
    const bath = out[0];
    const p = payload({
      quantities: {
        // the hall's old key, and a color that is no longer on the job at all
        [quantityKey("old-hall-color", "Eggshell")]: { buckets: 0, cans: 9, unit: "gal" },
      },
    });
    const pruned = pruneToLiveKeys(
      p,
      live([{ key: quantityKey(bath.colorId, bath.finish, true), legacyKey: quantityKey(bath.colorId, bath.finish) }])
    );
    expect(Object.keys(pruned.quantities)).toEqual([]);
  });
});
