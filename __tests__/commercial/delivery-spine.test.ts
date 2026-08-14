import { describe, it, expect } from "vitest";
import { deriveDeliverySpine } from "@/lib/commercial/projects/project-attention";

/**
 * The Project-tab delivery SPINE — where a job is in its lifecycle. Six stages,
 * Won → Close-out. Pipeline status drives the sequential stages; Submittals and
 * Close-out read their own tool state (parallel workstreams).
 */
const base = { wonLabel: "Jul 18", onSite: false, submittals: null, billing: null, closeout: null };
const stateOf = (stages: ReturnType<typeof deriveDeliverySpine>, key: string) => stages.find((s) => s.key === key)?.state;

describe("deriveDeliverySpine", () => {
  it("won but not started: Won done, Pre-con current, rest todo", () => {
    const s = deriveDeliverySpine({ ...base, status: "pre_sale_closed" });
    expect(stateOf(s, "won")).toBe("done");
    expect(stateOf(s, "precon")).toBe("current");
    expect(stateOf(s, "production")).toBe("todo");
    expect(stateOf(s, "billing")).toBe("todo");
  });

  it("in production: Pre-con done, Production current, Billing todo", () => {
    const s = deriveDeliverySpine({ ...base, status: "in_progress", onSite: true });
    expect(stateOf(s, "precon")).toBe("done");
    expect(stateOf(s, "production")).toBe("current");
    expect(stateOf(s, "billing")).toBe("todo");
    expect(s.find((x) => x.key === "production")?.meta).toBe("on site");
  });

  it("billing: Production done, Billing current", () => {
    const s = deriveDeliverySpine({ ...base, status: "billing" });
    expect(stateOf(s, "production")).toBe("done");
    expect(stateOf(s, "billing")).toBe("current");
  });

  it("closed with close-out filed: every stage done", () => {
    const s = deriveDeliverySpine({ ...base, status: "post_sale_closed", closeout: { status: "done", label: "filed" } });
    expect(s.every((x) => x.state === "done")).toBe(true);
  });

  it("submittals are a parallel workstream — current from their own tool even during pre-con", () => {
    const s = deriveDeliverySpine({ ...base, status: "pre_construction", submittals: { status: "active", label: "2 out" } });
    expect(stateOf(s, "submittals")).toBe("current");
    expect(s.find((x) => x.key === "submittals")?.meta).toBe("2 out");
  });

  it("billing tool going active pulls Billing to current before the pipeline reaches it", () => {
    const s = deriveDeliverySpine({ ...base, status: "in_progress", billing: { status: "active", label: "App 1 draft" } });
    expect(stateOf(s, "billing")).toBe("current");
  });

  it("always has the six stages in order", () => {
    const s = deriveDeliverySpine({ ...base, status: "in_progress" });
    expect(s.map((x) => x.key)).toEqual(["won", "precon", "submittals", "production", "billing", "closeout"]);
  });
});
