import { describe, it, expect } from "vitest";
import { attentionFor, manualNextStep, nextStep, sensibleNextStatuses, isUnderContract, type AttentionInput } from "@/lib/commercial/opportunities/attention";

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
  it("names the ACTION at each delivery stage, not the state", () => {
    // Karan 2026-08-12: "it should be like 'mark it as approved' and then it
    // brings you to the proposal". Nobody thinks in states; they think in the
    // next thing on their list. Delivery used to return null here — which left
    // a won job with no visible next move at all.
    const at = (s: string) => manualNextStep({ ...base, status: s })?.label;
    expect(at("pre_construction")).toBe("Write the work order");
    expect(at("in_progress")).toBe("Bill the work");
    expect(at("billing")).toBe("Close it out");
    // A finished job has nothing ahead of it.
    expect(at("post_sale_closed")).toBeUndefined();
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

/**
 * Karan 2026-08-12: "shouldnt the opportunity move forward on its own?" It does.
 * The picker predates the auto-advance engine and offered all eight statuses,
 * which is why it needed a banner warning half of them were "valid but
 * unusual" — a control that has to apologise for its own options is offering
 * the wrong options.
 */
describe("sensibleNextStatuses — only the moves with no artifact behind them", () => {
  it("offers a priced deal only the outcome, because forward is driven by the proposal", () => {
    // Building a proposal moves it to Estimating; sending it moves it to Sent.
    // Neither needs a person. Losing does.
    for (const s of ["estimating", "proposal"]) {
      expect(sensibleNextStatuses(s, null), s).toEqual(["pre_sale_closed"]);
    }
  });

  it("lets a person move Qualifying to RFP — a package landing is an email", () => {
    // Brendan 2026-08-12: "The first stage in an opp should be RFP." Nothing in
    // the system sees a bid package arrive, so this is a human move by
    // definition — and it was previously unreachable from the picker.
    // Forward moves only — the picker prepends the CURRENT status itself, so
    // returning it here listed Qualifying twice in the dropdown.
    expect(sensibleNextStatuses("qualifying", "solicitation")).not.toContain("qualifying");
    // …and once the RFP is in, forward is Estimating (assigning the estimator).
    expect(sensibleNextStatuses("qualifying", "rfp")).toContain("estimating");
  });

  it("offers a won job the start of work, and a lost one nothing", () => {
    expect(sensibleNextStatuses("pre_sale_closed", "won")).toEqual(["pre_construction"]);
    // Reopening a lost deal is a correction, and corrections belong behind the
    // disclosure rather than in the default list.
    expect(sensibleNextStatuses("pre_sale_closed", "lost")).toEqual([]);
  });

  it("walks delivery one step at a time, never sideways", () => {
    expect(sensibleNextStatuses("pre_construction", "coordination")).toEqual(["in_progress"]);
    expect(sensibleNextStatuses("in_progress", "wip_on_site")).toEqual(["billing"]);
    expect(sensibleNextStatuses("billing", "substantial_completion")).toEqual(["post_sale_closed"]);
  });

  it("never offers a jump the old picker had to warn about", () => {
    // Qualifying → Billing was offered, and flagged "valid but unusual". It is
    // simply not offered now.
    for (const s of ["qualifying", "estimating", "proposal"]) {
      const offered = sensibleNextStatuses(s, null);
      for (const jump of ["pre_construction", "in_progress", "billing", "post_sale_closed"]) {
        expect(offered, `${s} → ${jump}`).not.toContain(jump);
      }
    }
  });

  // SUPERSEDED 2026-08-21 (Stephanie): this pinned "a closed job is the end of
  // the line", which was right about the pipeline and wrong about painting.
  // "There are many times when we think we are done and they call us back,
  // sometimes months later, and we have to reopen the job." Being called back
  // is a punch-list, not a correction — so the one move a person actually
  // makes from Closed is offered, and only that one.
  it("offers the way back when a finished job gets called back", () => {
    expect(sensibleNextStatuses("post_sale_closed", "closed")).toEqual(["in_progress"]);
  });
});

/**
 * The dashboard's "Under contract" tile and the list it opens must describe the
 * SAME jobs. They briefly didn't: the tile counted `listProjects` while the list
 * filtered by the post-contract kanban lane, so the tile counted won-not-started
 * jobs the list omitted and the list showed completed jobs the tile omitted.
 * Caught by the parallel session's audit of step 10.
 */
describe("isUnderContract — one definition for the tile and the list", () => {
  it("counts a job the moment it is won, before anyone mobilises", () => {
    // The half the kanban-lane filter dropped: a won job sits in the PRE-contract
    // lane by column, but it is unambiguously under contract.
    expect(isUnderContract("pre_sale_closed", "won")).toBe(true);
  });

  it("counts every stage of delivery", () => {
    for (const s of ["pre_construction", "in_progress", "billing"]) {
      expect(isUnderContract(s, null), s).toBe(true);
    }
  });

  it("stops counting once the job is closed out", () => {
    // The other half of the mismatch: the lane filter included completed jobs,
    // which the tile's total deliberately excludes.
    expect(isUnderContract("post_sale_closed", "closed")).toBe(false);
  });

  it("never counts a deal we lost or are still selling", () => {
    expect(isUnderContract("pre_sale_closed", "lost")).toBe(false);
    for (const s of ["qualifying", "estimating", "proposal"]) {
      expect(isUnderContract(s, null), s).toBe(false);
    }
  });
});

/**
 * Karan 2026-08-12: "I approved the proposal and it didn't close status and ask
 * me closed won or lost."
 *
 * Approval is INTERNAL — Brendan signing off before it goes out — so it
 * correctly closes nothing. What was missing is the step between: nobody said
 * it was ready to send. An approved proposal that never goes out is the most
 * expensive kind of stall, because the pricing is already paid for.
 */
describe("approved but not sent", () => {
  const approved = { ...base, status: "estimating", subStatus: "proposal_pending_approval", proposalCount: 1, approvedNotSentCount: 1 };

  it("says so, and says what it costs", () => {
    const item = attentionFor(approved).find((a) => a.key === "approved_not_sent")!;
    expect(item).toBeDefined();
    expect(item.consequence).toMatch(/won or lost|hasn't seen/i);
  });

  it("offers SEND, not a decision — the GC can't answer what they don't have", () => {
    expect(manualNextStep(approved)?.label).toBe("Send it to the GC");
  });

  it("switches to the decision once it is actually out", () => {
    const sent = { ...base, status: "proposal", subStatus: "sent", proposalCount: 1, sentProposalCount: 1, approvedNotSentCount: 0 };
    expect(manualNextStep(sent)?.label).toBe("Mark won or lost");
    expect(keys(sent)).not.toContain("approved_not_sent");
  });

  it("stops nagging once the job is won", () => {
    expect(keys(won({ approvedNotSentCount: 1 }))).not.toContain("approved_not_sent");
  });
});

/**
 * Karan 2026-08-12: "there is like a Start Project button when an opp is won
 * which is great, we need more of that so people know what to do / where to go
 * easily for their next step… it should be like 'mark it as approved' and then
 * it brings you to the proposal for mark as approved."
 *
 * Two rules, and they are what separate this from a status dropdown: it names
 * the ACTION rather than the state, and it goes where the action happens.
 */
describe("nextStep", () => {
  const ACC = "aaaaaaaa-1111-2222-3333-444444444444";
  const PROP = "bbbbbbbb-1111-2222-3333-444444444444";
  const at = (over: Partial<Parameters<typeof nextStep>[0]>) =>
    nextStep({ ...base, accountId: ACC, ...over } as Parameters<typeof nextStep>[0]);

  it("says 'Mark it approved' and opens THAT proposal", () => {
    const step = at({
      status: "estimating",
      subStatus: "proposal_pending_approval",
      proposalCount: 1,
      proposal: { id: PROP, status: "pending_approval" },
    })!;
    expect(step.label).toBe("Mark it approved");
    // The exact ask: it brings you TO the proposal, not to a list of them.
    expect(step.href).toContain(`/proposal/${PROP}`);
    // …and carries a way back, so approving doesn't strand you.
    expect(step.href).toContain("back=");
  });

  it("walks the proposal's own lifecycle, one action at a time", () => {
    // Each state read from the STAGE it belongs to. The deal leads (see
    // nextStep), so asking about an approved proposal while the deal is parked
    // back at Estimating is a different question — covered below.
    const withProp = (sub: string, status: string) =>
      at({ status: "estimating", subStatus: sub, proposalCount: 1, proposal: { id: PROP, status } })!.label;
    expect(withProp("estimating", "draft")).toBe("Send it for approval");
    expect(withProp("proposal_pending_approval", "pending_approval")).toBe("Mark it approved");
    expect(withProp("proposal_pending_approval", "approved")).toBe("Send it to the GC");
  });

  it("when the paperwork has run ahead, it asks you to catch the deal up", () => {
    // Karan 2026-08-13: a deal moved back to Qualifying still said "Send it
    // for approval" while the bar above read Qualifying. The bar and the
    // button must never contradict each other.
    const behind = at({ status: "estimating", subStatus: "estimating", proposalCount: 1, proposal: { id: PROP, status: "pending_approval" } })!;
    expect(behind.label).toBe("Move it to Pending Approval");
  });

  it("asks for the answer only once the GC actually has it", () => {
    const sent = at({ status: "proposal", subStatus: "sent", proposalCount: 1, sentProposalCount: 1, proposal: { id: PROP, status: "sent" } })!;
    expect(sent.label).toBe("Mark won or lost");
  });

  it("gives every delivery stage a next move too", () => {
    // A won job used to show nothing at all here — the one place people most
    // need telling what happens next.
    expect(at({ status: "pre_sale_closed", subStatus: "won" })!.label).toBe("Start the job");
    expect(at({ status: "pre_construction" })!.label).toBe("Write the work order");
    expect(at({ status: "in_progress" })!.label).toBe("Bill the work");
    expect(at({ status: "billing" })!.label).toBe("Close it out");
  });

  it("goes quiet where there is genuinely nothing to do", () => {
    expect(at({ status: "post_sale_closed" })).toBeNull();
    expect(at({ status: "pre_sale_closed", subStatus: "lost" })).toBeNull();
  });

  it("explains itself — every step says why", () => {
    // The button is the answer to "what now?"; the line under it is the answer
    // to "why that?".
    for (const s of ["pre_construction", "in_progress", "billing"]) {
      expect(at({ status: s })!.why, s).toBeTruthy();
    }
  });

  it("falls back to the proposals tab when there is no proposal to point at", () => {
    const step = at({ proposalCount: 0 })!;
    expect(step.label).toBe("Build a proposal");
    expect(step.href).toContain("tab=proposals");
  });
});
