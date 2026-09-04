import { describe, it, expect } from "vitest";
import {
  dealStandingLines,
  billedPct,
  type DealStandingInput,
} from "@/lib/commercial/opportunities/deal-standing";

/**
 * "Where it stands" — the tab Brendan asked for, and what it says.
 *
 * Relayed by Karan from his videos, 2026-08-26: "below these we can have like
 * account specific important details like billed 5000/25000 and proposal send,
 * work order hasnr been sent ect very imporant stuff we should make a tab for
 * as well."
 *
 * The first pass built the compact block on the Activity rail and stopped
 * there, reading "as well" as either/or. It wasn't: he wanted both.
 *
 * Two things this pins that a source grep cannot:
 *  · a PRE-SALE deal is not blank. `dealStandingLines` used to return [] unless
 *    the job was won, and the rail gated on `isWon` a SECOND time — so during
 *    the whole bidding stretch, the one thing he named ("proposal send") had
 *    nowhere to appear.
 *  · the tab and the rail share one derivation, so they cannot drift into two
 *    different answers.
 */

const base: DealStandingInput = {
  billedCents: 0,
  contractCents: 0,
  outstandingCents: 0,
  retainageCents: 0,
  workOrderSent: null,
  pendingCoCount: 0,
  isWon: false,
};

describe("a pre-sale deal still has something to say", () => {
  it("names where the proposal has got to", () => {
    expect(dealStandingLines({ ...base, proposalStatus: "draft" })).toEqual([
      { label: "Proposal", value: "Draft — not sent", tone: "warn" },
    ]);
    expect(dealStandingLines({ ...base, proposalStatus: "sent" })).toEqual([
      { label: "Proposal", value: "With the GC", tone: "plain" },
    ]);
  });

  it("flags approved-but-not-sent, the one people miss", () => {
    // The estimating work is finished and nobody has pressed send. Amber.
    const [line] = dealStandingLines({ ...base, proposalStatus: "approved" });
    expect(line).toEqual({ label: "Proposal", value: "Approved, not sent", tone: "warn" });
  });

  it("says so when there is no proposal at all, without painting it amber", () => {
    // Plain: without the deal stage there is no telling a fresh lead from an
    // estimating job that has stalled.
    expect(dealStandingLines({ ...base, proposalStatus: null })).toEqual([
      { label: "Proposal", value: "Not started", tone: "plain" },
    ]);
  });

  it("does not show contract money it does not have", () => {
    // A bid has no contract. 0% billed would be a lie, not a zero.
    expect(billedPct(base)).toBeNull();
  });
});

describe("a won deal reports the money and the delivery", () => {
  const won: DealStandingInput = {
    ...base,
    isWon: true,
    billedCents: 5_000_00,
    contractCents: 25_000_00,
    outstandingCents: 5_000_00,
    workOrderSent: false,
    proposalStatus: "won",
  };

  it("gives Brendan's exact example: billed 5000 of 25000", () => {
    expect(billedPct(won)).toBe(20);
  });

  it("leads with the work order — it blocks people, not money", () => {
    const lines = dealStandingLines(won);
    expect(lines[0]).toEqual({ label: "Work order", value: "Written, not sent", tone: "warn" });
    expect(lines.map((l) => l.label)).toContain("GC owes");
    expect(lines.map((l) => l.label)).toContain("Left to bill");
  });

  it("calls out billing OVER the contract rather than showing 120% and moving on", () => {
    const over = dealStandingLines({ ...won, billedCents: 30_000_00 });
    const line = over.find((l) => l.label === "Billed over contract");
    expect(line?.tone).toBe("warn");
  });
});

describe("the tab is wired, not just declared", () => {
  it("registers, resolves from a URL, and renders", async () => {
    // A tab can be added to the list, type-check, and render nothing — the
    // label appears and the panel never mounts. Three separate seams.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/commercial/opportunities/[id]/page.tsx", "utf8");

    expect(src, "not in the tab bar").toContain('{ key: "standing", label: "Where it stands" }');
    expect(src, "?tab=standing would fall back to Overview").toContain('raw === "standing"');
    expect(src, "declared but never rendered").toMatch(/tab === "standing" &&/);
    expect(src, "panel not mounted").toContain("<DealStandingPanel");
  });

  it("the rail and the tab read the SAME derivation", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "components/commercial/activity-rail.tsx",
      "components/commercial/deal-standing-panel.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), `${f} re-derives instead of sharing`).toContain(
        "dealStandingLines"
      );
    }
  });

  it("the rail no longer gates on isWon a second time", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/commercial/activity-rail.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(
      /showStanding\s*=[^;]*standing\.isWon/.test(src),
      "the rail re-gates on isWon, so a pre-sale deal shows a blank block"
    ).toBe(false);
  });
});
