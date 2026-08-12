import { describe, it, expect } from "vitest";
import { dealTabsFor } from "@/lib/commercial/opportunities/kanban-columns";
import { dealPhase, isPostSaleProject } from "@/lib/commercial/opportunities/constants";

/**
 * Katie's note, verbatim:
 *   "Pre-Contract Tabs should be different from Post-Contract Tabs.
 *    Pre Contract  = Proposals, Documents.
 *    Post Contract = Submittals, Invoices, Work Orders, Change Orders,
 *                    AIA Billing, P&L, Closeout & Warranty, Costs."
 *
 * These were composed inline on a 7,000-line page, so nothing stopped them
 * drifting from the spec. Pinned here against her list.
 */
describe("deal page tabs by contract phase", () => {
  it("shows Katie's PRE-contract set and nothing from delivery", () => {
    const { primary, tools } = dealTabsFor(false);
    expect(primary.map((t) => t.label)).toEqual(["Overview", "Proposals", "Documents"]);
    // The whole point: no Submittals / Invoices / AIA / Costs on a bid.
    expect(tools).toHaveLength(0);
  });

  it("shows every one of Katie's EIGHT post-contract items", () => {
    const { primary, tools } = dealTabsFor(true);
    const all = [...primary, ...tools].map((t) => t.label);
    for (const required of [
      "Submittals",
      "Invoices",
      "Work Order",
      "Change Orders",
      "AIA Billing",
      "P&L",
      "Closeout & Warranty",
      "Transactions", // Katie's "Costs", renamed in the same meeting
    ]) {
      expect(all, `missing: ${required}`).toContain(required);
    }
  });

  it("keeps Proposals and Documents in BOTH phases", () => {
    // Katie lists them under pre-contract, but a won job still needs to reach
    // the signed proposal and its drawings.
    for (const post of [false, true]) {
      const labels = dealTabsFor(post).primary.map((t) => t.label);
      expect(labels, `post=${post}`).toContain("Proposals");
      expect(labels, `post=${post}`).toContain("Documents");
    }
  });

  it("switches on the real status, so the page changes as a deal progresses", () => {
    // The behaviour Karan asked to confirm: tools appear the moment a deal is
    // won and stay through delivery; a lost bid never gets them.
    const tabsFor = (status: string, sub: string | null) =>
      dealTabsFor(isPostSaleProject({ status, sub_status: sub })).tools.length;

    expect(tabsFor("qualifying", "solicitation")).toBe(0);
    expect(tabsFor("estimating", "estimating")).toBe(0);
    expect(tabsFor("proposal", "sent")).toBe(0);
    expect(tabsFor("pre_sale_closed", "won")).toBe(6);
    expect(tabsFor("pre_construction", "coordination")).toBe(6);
    expect(tabsFor("in_progress", "wip_on_site")).toBe(6);
    expect(tabsFor("billing", "substantial_completion")).toBe(6);
    expect(tabsFor("post_sale_closed", "closed")).toBe(6);
    // A lost bid is NOT post-contract — no delivery tools on a dead deal.
    expect(tabsFor("pre_sale_closed", "lost")).toBe(0);
  });

  it("gives a WON deal delivery tools but the not-started money card", () => {
    // Tools follow the CONTRACT (a won job needs Submittals immediately);
    // the Overview's money tiles follow the finer phase, because billed and
    // collected are structurally zero the day you win. The divergence is
    // deliberate — this test exists so nobody 'fixes' it into agreement.
    const won = { status: "pre_sale_closed", sub_status: "won" };
    expect(dealTabsFor(isPostSaleProject(won)).tools).toHaveLength(6);
    expect(dealPhase(won)).toBe("won_not_started");
  });
});
