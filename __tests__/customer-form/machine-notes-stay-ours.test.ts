import { describe, it, expect } from "vitest";
import { extractCustomerFreeText } from "@/lib/customer-form/notes";
import { colorNoteLines, itemKey } from "@/lib/supplier-order/color-note-items";
import {
  MACHINE_NOTE_HEADINGS,
  isMachineNoteHeading,
  stripMachineNoteBlocks,
} from "@/lib/customer-form/machine-notes";

/**
 * PPP's own bookkeeping went round-trip through the customer and on toward a
 * vendor (round-six audit, 2026-09-17).
 *
 * The submit route writes four blocks into ColorNotes__c for PPP to read —
 * a finish that wasn't recognised, a color with no finish, a paint line we
 * don't sell. Only ONE of them was known to the re-sent form's "your notes"
 * box, and only one to the order builder's buy list. So a customer who typed
 * nothing was shown our note as if they had written it (and stored it again on
 * submit), and an estimator was offered the word "Walls", and a rejected typo,
 * as things to buy from a paint store.
 */

const REAL_NOTE = [
  "Dining Room:",
  "Cabinets: White Dove (OC-17) — Satin",
  "",
  MACHINE_NOTE_HEADINGS.missingFinish,
  "  Walls",
  "  Trim",
  "",
  MACHINE_NOTE_HEADINGS.droppedFinish,
  "  Walls — Eggshell Gloss",
  "",
  MACHINE_NOTE_HEADINGS.droppedPaintLine,
  "  Regal Selectt",
  "",
  MACHINE_NOTE_HEADINGS.unstorableFinish,
  "  High-Gloss",
].join("\n");

describe("what the customer is shown as their own note", () => {
  it("is nothing, when they wrote nothing", () => {
    expect(extractCustomerFreeText(REAL_NOTE)).toBe("");
  });

  it("is only their words, when they wrote some", () => {
    const withTheirs = `${REAL_NOTE}\nCustomer notes: Please use the darker white in the hall.`;
    expect(extractCustomerFreeText(withTheirs)).toBe("Please use the darker white in the hall.");
  });

  it("survives a second submit without stacking", () => {
    // What comes back from the form is stored again. If any block survived the
    // extraction it would be written a second time, and a third.
    const once = extractCustomerFreeText(REAL_NOTE);
    const stored = `${REAL_NOTE}\nCustomer notes: ${once}`.trimEnd();
    expect(extractCustomerFreeText(stored)).toBe("");
  });

  it("keeps a person's words that merely sit near a block", () => {
    const note = [
      MACHINE_NOTE_HEADINGS.missingFinish,
      "  Walls",
      "Customer wants the ceiling left alone — confirmed on the phone.",
    ].join("\n");
    expect(extractCustomerFreeText(note)).toBe(
      "Customer wants the ceiling left alone — confirmed on the phone."
    );
  });

  it("keeps a crew note that has no blocks at all", () => {
    expect(extractCustomerFreeText("Cabinets: needs sanding before paint")).toBe(
      "Cabinets: needs sanding before paint"
    );
  });
});

describe("what the estimator is offered to buy", () => {
  const offered = () => colorNoteLines(REAL_NOTE).map(itemKey);

  it("never includes a bare surface name or a rejected paint line", () => {
    for (const notPaint of ["walls", "trim", "walls — eggshell gloss", "regal selectt", "high-gloss"]) {
      expect(offered(), notPaint).not.toContain(notPaint);
    }
  });

  it("still includes the real color the note carried", () => {
    // The proof this measured something: a list that came back empty would
    // pass every assertion above.
    expect(offered()).toContain(itemKey("Cabinets: White Dove (OC-17) — Satin"));
    expect(offered().length).toBeGreaterThan(0);
  });

  it("and still offers a color a rep typed under a heading", () => {
    const note = "Exterior:\nSiding: HC-6 Kendall Charcoal\nShutters: Black";
    const out = colorNoteLines(note).map(itemKey);
    expect(out).toContain(itemKey("Siding: HC-6 Kendall Charcoal"));
    expect(out).toContain(itemKey("Shutters: Black"));
  });
});

describe("recognising a heading", () => {
  it("does not depend on the exact dash or spelling", () => {
    // Both have changed at least once. A literal match fails silently — the
    // block simply leaks again, which is how this shipped.
    expect(isMachineNoteHeading("Finish not recognized - please confirm with the customer:")).toBe(true);
    expect(isMachineNoteHeading("  No  finish  chosen — please confirm with the customer:")).toBe(true);
  });

  it("does not match a person writing about the same thing", () => {
    expect(isMachineNoteHeading("No finish was chosen for the hall, I called them")).toBe(false);
    expect(isMachineNoteHeading("Walls")).toBe(false);
  });

  it("ends a block at the first line that is not indented", () => {
    const out = stripMachineNoteBlocks(
      [MACHINE_NOTE_HEADINGS.missingFinish, "  Walls", "Back to a person's words"].join("\n")
    );
    expect(out.trim()).toBe("Back to a person's words");
  });
});
