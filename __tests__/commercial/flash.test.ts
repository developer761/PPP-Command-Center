import { describe, it, expect } from "vitest";
import { flashMessage } from "@/lib/commercial/flash";

/**
 * Next.js decodes `searchParams` before a page sees them, so calling
 * `decodeURIComponent` on the value is a SECOND decode — fine until the message
 * contains a literal `%`, at which point it throws and takes down the page that
 * was trying to show the error.
 */
describe("flashMessage", () => {
  it("does not crash on a message containing a percent sign", () => {
    // The crash: "50% over budget" → decodeURIComponent → URIError.
    expect(flashMessage("Job is 50% over budget")).toBe("Job is 50% over budget");
    expect(flashMessage("100% complete")).toBe("100% complete");
    expect(flashMessage("%")).toBe("%");
  });

  it("still decodes a value that really is encoded", () => {
    // Some callers build these by hand and double-encode; showing "%20" in a
    // banner is cosmetic, crashing is not.
    expect(flashMessage("Could%20not%20save")).toBe("Could not save");
  });

  it("survives a half-valid escape rather than throwing", () => {
    expect(flashMessage("100%25 done and 50% left")).toBeTruthy();
  });

  it("takes the first value when a param repeats, and null when absent", () => {
    expect(flashMessage(["first", "second"])).toBe("first");
    expect(flashMessage(undefined)).toBeNull();
    expect(flashMessage(null)).toBeNull();
    expect(flashMessage("")).toBeNull();
  });
});
