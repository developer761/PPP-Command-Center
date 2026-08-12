import { describe, it, expect } from "vitest";
import { attentionFor, manualNextStep, type AttentionInput } from "@/lib/commercial/opportunities/attention";

const base: AttentionInput = {
  oppId: "11111111-2222-3333-4444-555555555555",
  status: "qualifying",
  subStatus: "solicitation",
  contractBaseCents: null,
  hasProject: false,
  followUpAt: null,
  proposalCount: 0,
  sentProposalCount: 0,
  hasWorkOrder: false,
  hasBilling: false,
};
const won = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  ...base,
  status: "pre_sale_closed",
  subStatus: "won",
  hasProject: true,
  ...over,
});
const keys = (i: AttentionInput) => attentionFor(i).map((a) => a.key);

/**
 * Salesforce hard-stops the quote when something is missing. We don't — a GC
 * verbally awards a job on Friday and the paperwork lands Tuesday, and a system
 * that refuses the win until Tuesday writes the wrong win date, which is the
 * bug class removed earlier this month. These pin what we say instead.
 */
describe("attentionFor", () => {
  it("flags a won job with no contract value — and does not treat it as $0", () => {
    // The distinction the whole money model rests on: null is "nobody has said",
    // zero is a number someone chose.
    expect(keys(won({ contractBaseCents: null }))).toContain("no_contract_value");
    expect(keys(won({ contractBaseCents: 0 }))).toContain("no_contract_value");
    expect(keys(won({ contractBaseCents: 45_000_00 }))).not.toContain("no_contract_value");
  });

  it("says what the missing thing AFFECTS, not just that it is missing", () => {
    // "Missing contract value" gives nobody a reason to act today.
    const item = attentionFor(won()).find((a) => a.key === "no_contract_value")!;
    expect(item.consequence).toMatch(/margin|bill|total/i);
    expect(item.href).toContain("/commercial/opportunities/");
  });

  it("never nags about delivery on a job we lost", () => {
    // Every item below the fold is about doing work. Warning that a lost bid has
    // no work order is noise, and noise is what teaches people to ignore the row.
    const lost = { ...base, status: "pre_sale_closed", subStatus: "lost", hasProject: false };
    expect(attentionFor(lost)).toHaveLength(0);
  });

  it("flags a won job with no work order — the crew has nothing to work from", () => {
    expect(keys(won())).toContain("no_work_order");
    expect(keys(won({ hasWorkOrder: true }))).not.toContain("no_work_order");
  });

  it("flags a job in Billing that has never been billed", () => {
    const billing = won({ status: "billing", subStatus: "substantial_completion" });
    expect(keys(billing)).toContain("billing_nothing_billed");
    expect(keys({ ...billing, hasBilling: true })).not.toContain("billing_nothing_billed");
  });

  it("does NOT nag about a deal at Proposal with no proposal built", () => {
    // Removed 2026-08-12. The auto-advance engine moves a deal to Proposal
    // BECAUSE one was sent, so the only way to reach this state is a manual
    // drag — and telling the person who just dragged it what they did a second
    // ago is exactly the noise that teaches people to ignore the row.
    const p = { ...base, status: "proposal", subStatus: "sent", proposalCount: 0 };
    expect(keys(p)).not.toContain("proposal_stage_no_proposal");
  });

  it("gives a freshly-won job a grace period before nagging", () => {
    // A work order does not exist five minutes after a GC says yes. Without
    // this, every won job wears a warning from the moment it is awarded, and a
    // row that is always on is wallpaper.
    const fresh = won({ decidedAt: "2026-08-11", todayIso: "2026-08-12" });
    expect(keys(fresh)).not.toContain("no_work_order");
    expect(keys(fresh)).not.toContain("no_contract_value");
    // …and starts once the grace runs out (contract 3 days, work order 7).
    expect(keys(won({ decidedAt: "2026-08-08", todayIso: "2026-08-12" }))).toContain("no_contract_value");
    expect(keys(won({ decidedAt: "2026-08-01", todayIso: "2026-08-12" }))).toContain("no_work_order");
  });

  it("gives NO grace to a job with no recorded win date", () => {
    // We cannot tell whether it was won today or in March, and the safe reading
    // of an unknown is to surface it rather than hide it for a week.
    const undated = won({ decidedAt: null, todayIso: "2026-08-12" });
    expect(keys(undated)).toContain("no_contract_value");
    expect(keys(undated)).toContain("no_work_order");
  });

  it("nudges about a sent proposal with nothing scheduled to chase it", () => {
    const sent = { ...base, status: "proposal", subStatus: "sent", proposalCount: 1, sentProposalCount: 1 };
    expect(keys(sent)).toContain("no_follow_up");
    expect(keys({ ...sent, followUpAt: "2026-09-01" })).not.toContain("no_follow_up");
    // A nudge, not a defect — it must not turn the banner amber on its own.
    expect(attentionFor(sent).find((a) => a.key === "no_follow_up")!.tone).toBe("info");
  });

  it("says nothing about a healthy job", () => {
    expect(attentionFor(won({ contractBaseCents: 45_000_00, hasWorkOrder: true, decidedAt: "2026-01-01", todayIso: "2026-08-12" }))).toHaveLength(0);
  });
});

/**
 * The path bar's CTA is a MANUAL OVERRIDE. Status advances on its own from
 * artifacts, so offering a button at every stage would give a person a second
 * way to fight the engine over the same transition — and the engine wins on the
 * next page load. It appears only where the engine is structurally blind.
 */
describe("manualNextStep", () => {
  it("offers nothing while the engine can act", () => {
    // A drafted proposal advances the deal on send, with no human involved.
    expect(manualNextStep({ ...base, status: "estimating", subStatus: "estimating", proposalCount: 1, sentProposalCount: 0 })).toBeNull();
    // Delivery is entirely engine-driven.
    for (const s of ["pre_construction", "in_progress", "billing", "post_sale_closed"]) {
      expect(manualNextStep({ ...base, status: s }), s).toBeNull();
    }
  });

  it("offers a proposal when nothing has been quoted — no artifact exists to read", () => {
    expect(manualNextStep({ ...base, proposalCount: 0 })?.label).toBe("Build a proposal");
  });

  it("offers won/lost on a sent proposal — a verbal yes leaves no trace", () => {
    const step = manualNextStep({ ...base, status: "proposal", subStatus: "sent", proposalCount: 1, sentProposalCount: 1 });
    expect(step?.label).toBe("Mark won or lost");
  });

  it("offers starting the job once it is won, and nothing at all once it is lost", () => {
    expect(manualNextStep({ ...base, status: "pre_sale_closed", subStatus: "won" })?.label).toBe("Start the job");
    expect(manualNextStep({ ...base, status: "pre_sale_closed", subStatus: "lost" })).toBeNull();
  });
});
