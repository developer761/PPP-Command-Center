import { describe, it, expect } from "vitest";
import { deriveDeliverySpine } from "@/lib/commercial/projects/project-attention";

/**
 * The Project-tab delivery SPINE. Each stage's marker reflects its OWN state —
 * done (green ✓) / partial (amber ✓) / todo (grey ○) — so out-of-order work
 * updates only that stage. A separate `current` flag marks the pipeline stage
 * the deal officially sits at.
 */
const base = { wonLabel: "Jul 18", onSite: false, submittals: null, billing: null, closeout: null, money: null };
const stage = (s: ReturnType<typeof deriveDeliverySpine>, key: string) => s.find((x) => x.key === key)!;

describe("deriveDeliverySpine", () => {
  it("won but not started: Won done, NOTHING current, rest todo", () => {
    // Pre-con used to carry the "you are here" ring here, which said
    // pre-construction was underway on a job nobody had touched — and the
    // chevron bar directly above showed the whole ladder ahead, so one screen
    // contradicted itself. Won-but-not-started means no stage is current.
    const s = deriveDeliverySpine({ ...base, status: "pre_sale_closed" });
    expect(stage(s, "won").state).toBe("done");
    expect(stage(s, "precon").state).toBe("todo");
    expect(s.every((st) => !st.current)).toBe(true);
    expect(stage(s, "production").state).toBe("todo");
  });

  it("pre-construction: Pre-con is partial AND current", () => {
    // The ring appears the moment the job actually enters pre-con — the stage
    // it was previously showing on before anything had started.
    const s = deriveDeliverySpine({ ...base, status: "pre_construction" });
    expect(stage(s, "precon").state).toBe("partial");
    expect(stage(s, "precon").current).toBe(true);
  });

  it("in production: Pre-con done, Production partial + current", () => {
    const s = deriveDeliverySpine({ ...base, status: "in_progress", onSite: true });
    expect(stage(s, "precon").state).toBe("done");
    expect(stage(s, "production").state).toBe("partial");
    expect(stage(s, "production").current).toBe(true);
    expect(stage(s, "production").meta).toBe("on site");
  });

  it("billing partially done (money) reads amber PARTIAL, not done — even mid-production", () => {
    const s = deriveDeliverySpine({
      ...base,
      status: "in_progress",
      money: { hasContract: true, contractCents: 500_00, billedCents: 50_00, collectedCents: 50_00 },
    });
    // Only billing updates — the earlier stages are NOT forced complete.
    expect(stage(s, "billing").state).toBe("partial");
    expect(stage(s, "submittals").state).toBe("todo");
    expect(stage(s, "production").state).toBe("partial");
  });

  it("billing fully billed AND collected reads done", () => {
    const s = deriveDeliverySpine({
      ...base,
      status: "billing",
      money: { hasContract: true, contractCents: 500_00, billedCents: 500_00, collectedCents: 500_00 },
    });
    expect(stage(s, "billing").state).toBe("done");
  });

  it("nothing billed reads todo", () => {
    const s = deriveDeliverySpine({
      ...base,
      status: "in_progress",
      money: { hasContract: true, contractCents: 500_00, billedCents: 0, collectedCents: 0 },
    });
    expect(stage(s, "billing").state).toBe("todo");
  });

  it("an in-flight tool reads PARTIAL (amber), not done", () => {
    const s = deriveDeliverySpine({ ...base, status: "pre_construction", submittals: { status: "active", label: "2 out" } });
    expect(stage(s, "submittals").state).toBe("partial");
    expect(stage(s, "submittals").meta).toBe("2 out");
    expect(stage(s, "precon").current).toBe(true);
  });

  it("exactly one stage is current", () => {
    const s = deriveDeliverySpine({ ...base, status: "billing" });
    expect(s.filter((x) => x.current).length).toBe(1);
    expect(stage(s, "billing").current).toBe(true);
  });

  it("billing meta describes the STAGE, not a single invoice's 'paid in full'", () => {
    const fmt = (c: number) => `$${Math.round(c / 100)}`;
    const s = deriveDeliverySpine(
      {
        ...base,
        status: "in_progress",
        billing: { status: "done", label: "$50 paid in full" }, // the invoice's OWN state
        money: { hasContract: true, contractCents: 560_000_00, billedCents: 50_00, collectedCents: 50_00 },
      },
      fmt,
    );
    const billing = stage(s, "billing");
    expect(billing.state).toBe("partial");
    expect(billing.meta).toBe("$50 of $560000 billed");
    expect(billing.meta).not.toContain("paid in full");
  });

  it("always the six stages in order", () => {
    const s = deriveDeliverySpine({ ...base, status: "in_progress" });
    expect(s.map((x) => x.key)).toEqual(["won", "precon", "submittals", "production", "billing", "closeout"]);
  });
});
