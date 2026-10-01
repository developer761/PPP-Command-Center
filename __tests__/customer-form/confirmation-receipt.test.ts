import { describe, it, expect } from "vitest";
import {
  buildReceiptRooms,
  receiptSurfaceText,
  receiptIsEmpty,
} from "@/lib/customer-form/receipt-lines";
import { buildConfirmationEmail } from "@/lib/customer-form/confirmation-email";
import { DEFAULT_TEMPLATES, render, buildVars } from "@/lib/customer-form/templates";

/**
 * The customer's confirmation email (Kate, 2026-10-01).
 *
 * "Provides a 'receipt' and a chance to correct errors, preventing disputes" —
 * so what is tested is the DOCUMENT, not the code that assembles it. Every
 * assertion below reads the rendered subject/text/html, because the failures
 * that matter here are things a customer would see: a room missing, a skipped
 * surface silently dropped, the edit link absent, a name pasted in unescaped.
 */

const ROOM_LABELS = new Map([
  ["li-1", "Interior Painting · Bathroom"],
  ["li-2", "Interior Painting · Living Room"],
]);

function rooms() {
  return buildReceiptRooms({
    lineItems: [
      {
        id: "li-1",
        surfaces: [
          { surface: "Walls", colorName: "Stardust", colorCode: "2108-40", finish: "Satin" },
          { surface: "Ceiling", colorName: "Chantilly Lace", colorCode: "OC-65", finish: null },
          { surface: "Trim", skipped: true },
        ],
        notes: "Please keep the accent wall as is",
      },
      {
        id: "li-2",
        surfaces: [{ surface: "Walls", colorName: null, colorCode: null, finish: null }],
        notes: null,
      },
    ],
    roomLabelById: ROOM_LABELS,
  });
}

function build(overrides: Partial<Parameters<typeof buildConfirmationEmail>[0]> = {}) {
  return buildConfirmationEmail({
    templates: DEFAULT_TEMPLATES,
    vars: buildVars({ customerName: "Jane Doe", workOrderNumber: "00318893", formUrl: "https://hub.example/select/tok" }),
    render,
    rooms: rooms(),
    formUrl: "https://hub.example/select/tok",
    ...overrides,
  });
}

describe("what the receipt says happened", () => {
  it("names every room the customer answered for", () => {
    const { html, text } = build();
    let found = 0;
    for (const label of ROOM_LABELS.values()) {
      expect(html, label).toContain(label);
      expect(text.toUpperCase(), label).toContain(label.toUpperCase());
      found++;
    }
    expect(found).toBe(2);
  });

  it("prints the color AND the finish the customer chose", () => {
    const { html } = build();
    expect(html).toContain("Stardust");
    expect(html).toContain("2108-40");
    expect(html).toContain("Satin");
  });

  it("says so out loud when a finish was never chosen", () => {
    // From 2026-10-01 the form stopped auto-filling one (Alex), so this is a
    // common state and the customer is the only person who can resolve it.
    // Printing the color with a silent blank beside it is how it gets missed.
    expect(receiptSurfaceText({ surface: "Ceiling", colorName: "Chantilly Lace", colorCode: "OC-65", finish: null, skipped: false }))
      .toContain("finish not chosen");
    expect(build().html).toContain("finish not chosen");
  });

  it("shows a skipped surface rather than dropping it", () => {
    // The receipt exists to settle "was this room included?". A surface that
    // vanishes because the answer was 'no' cannot settle anything.
    const { html, text } = build();
    expect(html).toContain("Not painting this surface");
    expect(text).toContain("Not painting this surface");
  });

  it("shows a surface left blank rather than implying it was answered", () => {
    const { html } = build();
    expect(html).toContain("No color chosen yet");
  });

  it("carries the room note and the job-wide note", () => {
    const { html } = build({ globalNotes: "Gate code is 4432" });
    expect(html).toContain("Please keep the accent wall as is");
    expect(html).toContain("Gate code is 4432");
  });
});

describe("the way back in", () => {
  it("links the form so a mistake can be corrected", () => {
    // The entire second half of Kate's request. Without a usable href the
    // email is a receipt you cannot act on.
    const { html, text } = build();
    expect(html).toContain('href="https://hub.example/select/tok"');
    expect(html).toContain("Review or Update Your Colors");
    expect(text).toContain("https://hub.example/select/tok");
  });

  it("states the deadline with the SAME sentence the form uses", () => {
    // One function behind all three surfaces (Kate 2026-09-04) so the form,
    // the invite and the receipt cannot promise three different dates.
    const vars = buildVars({
      customerName: "Jane Doe",
      workOrderNumber: "00318893",
      formUrl: "https://hub.example/select/tok",
      colorDeadline: "2026-10-26",
    });
    const { html } = build({ vars });
    expect(vars.color_deadline_notice.length).toBeGreaterThan(0);
    expect(html).toContain(vars.color_deadline_notice);
  });

  it("tells a returning customer this replaces their last answer", () => {
    expect(build({ isReedit: true }).html).toContain("replaces what you sent us before");
    expect(build({ isReedit: false }).html).not.toContain("replaces what you sent us before");
  });
});

describe("what must not reach the customer", () => {
  it("escapes a name or note instead of rendering it as markup", () => {
    const evil = buildConfirmationEmail({
      templates: DEFAULT_TEMPLATES,
      vars: buildVars({ customerName: "<script>x</script> Doe", workOrderNumber: "1", formUrl: "https://h/select/t" }),
      render,
      rooms: buildReceiptRooms({
        lineItems: [{ id: "li-1", surfaces: [{ surface: "Walls", colorName: "<b>Red</b>" }], notes: "<img src=x>" }],
        roomLabelById: ROOM_LABELS,
      }),
      formUrl: "https://h/select/t",
    });
    expect(evil.html).not.toContain("<script>");
    expect(evil.html).not.toContain("<img src=x>");
    expect(evil.html).toContain("&lt;script&gt;");
  });

  it("is not sent at all when there is nothing to confirm", () => {
    // An empty submission would otherwise produce a receipt listing nothing,
    // which reads as "we got your colors" when we got none.
    const empty = buildReceiptRooms({
      lineItems: [{ id: "li-1", surfaces: [{ surface: "Walls" }], notes: null }],
      roomLabelById: ROOM_LABELS,
    });
    expect(receiptIsEmpty(empty, null)).toBe(true);
    // A note alone IS worth confirming.
    expect(receiptIsEmpty(empty, "please call first")).toBe(false);
    // So is a single skip — it is an answer.
    const skipped = buildReceiptRooms({
      lineItems: [{ id: "li-1", surfaces: [{ surface: "Walls", skipped: true }], notes: null }],
      roomLabelById: ROOM_LABELS,
    });
    expect(receiptIsEmpty(skipped, null)).toBe(false);
  });

  it("falls back to a readable room name when the line is unknown", () => {
    const orphan = buildReceiptRooms({
      lineItems: [{ id: "nope", surfaces: [{ surface: "Walls", colorName: "Stardust" }] }],
      roomLabelById: ROOM_LABELS,
    });
    expect(orphan[0].room).toBe("Unnamed area");
  });
});
