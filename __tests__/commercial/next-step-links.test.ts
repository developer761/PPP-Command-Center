import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nextStep } from "@/lib/commercial/opportunities/attention";

/**
 * Karan, 2026-08-13: *"Mark won or lost here doesn't work... Start the job
 * button doesn't work either. These are in plain sight and you didn't catch
 * them."*
 *
 * Both pointed at `?action=change-status`, a parameter the deal page reads
 * NOWHERE. Clicking navigated to the same page, nothing moved, and it looked
 * broken because it was. Type-checking cannot catch a made-up query param, and
 * neither can a test that only asserts the button's LABEL — which is exactly
 * what I had written.
 *
 * So this checks the destinations instead, against the page's own source: the
 * only real proof that a link goes somewhere the page handles.
 */

const PAGE = readFileSync("app/commercial/opportunities/[id]/page.tsx", "utf8");

/** Every (status, sub_status) a deal can sit in, with a proposal state that
 *  reaches each branch of `nextStep`. */
const CASES: { status: string; sub: string; proposal: string | null; sent: number }[] = [
  { status: "qualifying", sub: "solicitation", proposal: null, sent: 0 },
  { status: "qualifying", sub: "rfp", proposal: "draft", sent: 0 },
  { status: "estimating", sub: "estimating", proposal: "draft", sent: 0 },
  { status: "estimating", sub: "proposal_pending_approval", proposal: "pending_approval", sent: 0 },
  { status: "estimating", sub: "estimating", proposal: "approved", sent: 0 },
  { status: "proposal", sub: "sent", proposal: "sent", sent: 1 },
  { status: "pre_sale_closed", sub: "won", proposal: "won", sent: 1 },
  { status: "pre_construction", sub: "coordination", proposal: "won", sent: 1 },
  { status: "in_progress", sub: "wip_on_site", proposal: "won", sent: 1 },
  { status: "billing", sub: "substantial_completion", proposal: "won", sent: 1 },
];

const stepFor = (c: (typeof CASES)[number]) =>
  nextStep({
    oppId: "o1",
    accountId: "a1",
    status: c.status,
    subStatus: c.sub,
    proposal: c.proposal ? { id: "p1", status: c.proposal } : null,
    proposalCount: c.proposal ? 1 : 0,
    sentProposalCount: c.sent,
    approvedNotSentCount: 0,
  });

describe("every next-step button goes somewhere the page handles", () => {
  for (const c of CASES) {
    const step = stepFor(c);
    if (!step) continue;

    it(`${c.status}/${c.sub} → "${step.label}" has a live destination`, () => {
      const url = new URL(step.href, "https://x.test");

      // 1. Every query param must be one the page actually reads. `action` was
      //    invented and read by nothing, which is the whole bug.
      const READS = ["tab", "sub", "to", "to_sub", "back", "ef"];
      for (const key of url.searchParams.keys()) {
        expect(READS, `"${step.label}" passes ?${key}=, which the page never reads`).toContain(key);
      }

      // 2. A `tab` value must be one the resolver names EXPLICITLY. Unknown
      //    keys don't 404 — they fall through to Overview, so a typo lands you
      //    on the wrong screen silently.
      const tab = url.searchParams.get("tab");
      if (tab) {
        expect(PAGE, `"${step.label}" uses ?tab=${tab}, which resolveTabParam doesn't name`)
          .toContain(`"${tab}"`);
      }
    });
  }

  it("no button pre-picks the answer on a won/lost decision", () => {
    // Pre-selecting either outcome is how a mis-click books a loss as a win.
    const step = stepFor(CASES.find((c) => c.sub === "sent")!)!;
    expect(step.label).toBe("Mark won or lost");
    expect(new URL(step.href, "https://x.test").searchParams.get("to")).toBeNull();
  });

  it("lands ON the status card, not at the top of a long page", () => {
    // Half of "the button doesn't work" is arriving somewhere that looks
    // unchanged. The anchor has to exist in the page for the hash to bite.
    const step = stepFor(CASES.find((c) => c.sub === "sent")!)!;
    expect(step.href).toContain("#change-status");
    expect(PAGE).toContain('id="change-status"');
  });

  it("'Start the job' pre-picks the one sensible stage", () => {
    const step = stepFor(CASES.find((c) => c.status === "pre_sale_closed")!)!;
    expect(step.label).toBe("Start the job");
    expect(new URL(step.href, "https://x.test").searchParams.get("to")).toBe("pre_construction");
  });
});
