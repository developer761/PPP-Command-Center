import { describe, it, expect } from "vitest";
import { agentPerformance, humanPerformance } from "@/lib/messaging/metrics";

const conv = (o: Partial<Parameters<typeof agentPerformance>[0][number]>) => ({
  workspace_name: "NY LI Meta", state: "ended", outcome: "success",
  qualification_stage: 4, takeover_reason: null,
  created_at: "2026-09-01T10:00:00Z", ended_at: "2026-09-01T11:00:00Z",
  first_outbound_at: null, first_inbound_at: null,
  ...o,
});

describe("the agent table", () => {
  it("counts running conversations as active, not as failures", () => {
    const [row] = agentPerformance([
      conv({ state: "ai_active", outcome: null }),
      conv({ state: "awaiting_customer", outcome: null }),
      conv({ state: "ended", outcome: "success" }),
    ]);
    expect(row.active).toBe(2);
    expect(row.completed).toBe(1);
    // The one completed conversation succeeded. A busy workspace must not
    // score worse than a dead one just for having work in flight.
    expect(row.successPct).toBe(100);
  });

  it("counts phone pricing as a success, because it is one", () => {
    const [row] = agentPerformance([conv({ outcome: "phone_pricing" })]);
    expect(row.successPct).toBe(100);
    expect(row.dropOffPct).toBe(0);
  });

  it("separates drop-off from take-over", () => {
    const [row] = agentPerformance([
      conv({ outcome: "lost" }),
      conv({ outcome: "success", takeover_reason: "low_confidence" }),
    ]);
    expect(row.dropOffPct).toBe(50);
    expect(row.takeOverPct).toBe(50);
  });

  it("treats a conversation a person is still holding as a take-over", () => {
    const [row] = agentPerformance([conv({ state: "human_active", outcome: null })]);
    expect(row.takeOverPct).toBe(100);
    expect(row.active).toBe(1);
  });

  it("splits by workspace, so one bad region does not hide in the total", () => {
    const rows = agentPerformance([
      conv({ workspace_name: "NY LI Meta", outcome: "success" }),
      conv({ workspace_name: "CO Denver Leads", outcome: "lost" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.workspace === "CO Denver Leads")!.dropOffPct).toBe(100);
  });

  it("does not divide by zero when nothing has completed", () => {
    const [row] = agentPerformance([conv({ state: "ai_active", outcome: null })]);
    expect(row.successPct).toBe(0);
    expect(Number.isNaN(row.successPct)).toBe(false);
  });
});

describe("the people table", () => {
  const h = (o: Partial<Parameters<typeof humanPerformance>[0][number]>) => ({
    name: "Matt", outcome: "success", state: "ended",
    createdAt: "2026-09-01T10:00:00Z", endedAt: "2026-09-01T10:10:00Z",
    responseSeconds: 60, ...o,
  });

  it("uses the median so one weekend-long thread does not eat the number", () => {
    const [row] = humanPerformance([
      h({ responseSeconds: 60 }), h({ responseSeconds: 120 }),
      h({ responseSeconds: 400000 }),
    ]);
    expect(row.medianResponseSeconds).toBe(120);
  });

  it("ranks by volume", () => {
    const rows = humanPerformance([
      h({ name: "Rachel" }), h({ name: "Matt" }), h({ name: "Matt" }),
    ]);
    expect(rows[0].name).toBe("Matt");
    expect(rows[0].conversations).toBe(2);
  });

  it("survives a person with no completed conversations", () => {
    const [row] = humanPerformance([h({ state: "human_active", endedAt: null, responseSeconds: null })]);
    expect(row.successPct).toBe(0);
    expect(row.medianHandleSeconds).toBeNull();
    expect(row.medianResponseSeconds).toBeNull();
  });
});
