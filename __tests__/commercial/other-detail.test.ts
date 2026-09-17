import { describe, it, expect } from "vitest";

import { joinOtherDetail } from "@/lib/commercial/forms/other-detail";

/**
 * Choosing "Other" has to keep what the person typed.
 *
 * The failure this replaces was silent and only visible a month later: the
 * picker recorded the word "Other" and dropped the explanation, so a list of
 * purchases carried eleven rows saying Other with no way to tell a dumpster
 * hire from a parking permit. Nothing errored; the information simply was not
 * asked for.
 */
describe("what you type on Other survives", () => {
  it("keeps the typed detail when nothing else is there", () => {
    expect(joinOtherDetail("dumpster hire", "")).toBe("dumpster hire");
  });

  it("keeps both, and says which is which", () => {
    expect(joinOtherDetail("dumpster hire", "INV-4471")).toBe("dumpster hire — INV-4471");
  });

  it("leaves an existing reference alone when Other was not used", () => {
    expect(joinOtherDetail("", "INV-4471")).toBe("INV-4471");
    expect(joinOtherDetail(null, "INV-4471")).toBe("INV-4471");
  });

  it("gives null rather than an empty string when there is nothing", () => {
    // The columns are nullable, and "" is a different thing to blank — it
    // renders as a present-but-empty reference in the list.
    expect(joinOtherDetail("", "")).toBeNull();
    expect(joinOtherDetail(null, undefined)).toBeNull();
  });

  it("does not say the same thing twice", () => {
    expect(joinOtherDetail("dumpster hire", "dumpster hire")).toBe("dumpster hire");
    expect(joinOtherDetail("Dumpster Hire", "dumpster hire")).toBe("Dumpster Hire");
  });

  it("ignores whitespace somebody tabbed through", () => {
    expect(joinOtherDetail("  ", "  ")).toBeNull();
    expect(joinOtherDetail("  dumpster hire  ", "  INV-4471 ")).toBe("dumpster hire — INV-4471");
  });

  it("uses an em dash, which the PDF fonts can print", () => {
    // WinAnsi has the em dash; the arrow and the bullet-triangle do not. A
    // reference ends up on the printed AR sheet, so this is not cosmetic.
    const joined = joinOtherDetail("a", "b")!;
    expect(joined).toContain("—");
    expect([...joined].every((c) => c <= "ÿ" || c === "—")).toBe(true);
  });
});
