import { describe, it, expect, vi } from "vitest";

/**
 * A pasted block of exclusions becomes a LIST, not one wall of text.
 *
 * Stephanie 2026-10-05: "Can we add a custom block called Custom Exclusions &
 * Qualifications as well, just verbiage? Also, can the option to bullet within
 * both?"
 *
 * Her Glenwood proposal carries fourteen of them. Pasted into one box and kept
 * whole, that is a single bullet holding fourteen lines, where her own document
 * has fourteen bullets. It needed no new column — `custom_exclusions` is
 * already a text[] on the proposal; what it needed was splitting at render.
 *
 * The library half is mocked because this is about the custom half; the
 * library path has its own coverage.
 */
vi.mock("@/lib/commercial/exclusions/db", () => ({
  listExclusions: async () => [],
}));

const { resolveProposalExclusions } = await import(
  "@/lib/commercial/proposals/exclusion-texts"
);

const HER_GLENWOOD_PASTE = [
  "Work to be completed during normal business hours",
  "Trees, bushes, and vegetation to be cut back prior to mobilization to allow access to all work areas.",
  "Roof surfaces",
  "Copper gutters, flashing, and copper components",
  "Brick surfaces",
  "Decking",
  "Chain-link fence",
  "Garage doors",
  "Any work not specifically listed under inclusions",
].join("\n");

const proposal = (custom: string[]) =>
  ({ id: "p1", exclusion_ids: [], custom_exclusions: custom }) as never;

describe("a pasted exclusions block", () => {
  it("becomes one line per bullet, not one bullet for the lot", async () => {
    const out = await resolveProposalExclusions(proposal([HER_GLENWOOD_PASTE]));
    expect(out).toHaveLength(9);
    expect(out[0].text).toBe("Work to be completed during normal business hours");
    expect(out[8].text).toBe("Any work not specifically listed under inclusions");
  });

  it("strips bullets she pasted in, so none is printed as a character", async () => {
    // Times has no ● glyph — a typed one renders as "Ï" on the page.
    const out = await resolveProposalExclusions(
      proposal(["● Roof surfaces\n• Decking\n- Garage doors"]),
    );
    expect(out.map((e) => e.text)).toEqual(["Roof surfaces", "Decking", "Garage doors"]);
  });

  it("drops the blank lines a paste always carries", async () => {
    const out = await resolveProposalExclusions(proposal(["Roof surfaces\n\n\nDecking"]));
    expect(out.map((e) => e.text)).toEqual(["Roof surfaces", "Decking"]);
  });

  it("still caps a runaway line so the layout cannot blow up", async () => {
    const out = await resolveProposalExclusions(proposal(["x".repeat(900)]));
    expect(out[0].text.length).toBeLessThanOrEqual(501);
    expect(out[0].text.endsWith("…")).toBe(true);
  });

  it("leaves a single-line entry exactly as it was", async () => {
    // The shape every existing proposal is in — none of them may change.
    const out = await resolveProposalExclusions(proposal(["Sales Tax, unless applicable."]));
    expect(out.map((e) => e.text)).toEqual(["Sales Tax, unless applicable."]);
  });
});
