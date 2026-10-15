/**
 * Kate — "Paint Tool Modifications-2.pdf", 12 pages, received 2026-10-15.
 * Items FU.1 … FU.16 (FU.4 and FU.9 are absent from her document).
 *
 * One file for the batch so the asks stay next to the code that answers
 * them, each test naming the item it belongs to.
 */
import { describe, it, expect } from "vitest";
import { finishOptionsFor } from "@/lib/customer-form/material-types";
import { buildConfirmationEmail } from "@/lib/customer-form/confirmation-email";
import { inBuyList } from "@/lib/supplier-order/color-note-items";

/** Minimal real inputs for buildConfirmationEmail — the templates and the
 *  renderer are not what FU.8 is about. */
const EMAIL_BASE = {
  templates: {
    confirm_subject: "Your colors",
    confirm_intro: "Thanks.",
    confirm_outro: "",
    email_signoff: "PPP",
  },
  vars: { customer_name: "Sam" } as Record<string, string>,
  render: (t: string) => t,
  formUrl: "https://hub.example/select/abc",
};


describe("FU.2 — color + finish is the unique item", () => {
  // "even if the color is the same, if the finish is different, this is
  // automatically a different product and should be treated separately."
  const flatWhite = [{ colorName: "01 White", colorCode: "01", finish: "Flat" }];

  it("does NOT call a different sheen a duplicate", () => {
    // The bug: "01 White semigloss" was refused with "already exists on the
    // order. Increase quantity above." Increasing the flat one buys the
    // wrong paint and the semigloss is never ordered.
    expect(inBuyList("Trim 01 White semigloss", flatWhite, "Semi-Gloss")).toBe(false);
  });

  it("still calls the SAME color and sheen a duplicate", () => {
    expect(inBuyList("Walls 01 White flat", flatWhite, "Flat")).toBe(true);
  });

  it("matches on code as well as name", () => {
    expect(inBuyList("Walls 01", flatWhite, "Flat")).toBe(true);
  });

  it("falls back to color-only when the NOTE names no finish", () => {
    // Warning about a possible duplicate is the safer error: the estimator
    // can see the buy list, where a silent second can costs money.
    expect(inBuyList("Walls 01 White", flatWhite, null)).toBe(true);
  });

  it("falls back to color-only when the ESTIMATE has no finish", () => {
    const noFinish = [{ colorName: "01 White", colorCode: "01", finish: null }];
    expect(inBuyList("Trim 01 White semigloss", noFinish, "Semi-Gloss")).toBe(true);
  });

  it("is unaffected by case and padding", () => {
    expect(inBuyList("Trim 01 White", flatWhite, "  flat  ")).toBe(true);
    expect(inBuyList("Trim 01 White", flatWhite, " SEMI-GLOSS ")).toBe(false);
  });

  it("checks each estimate on its own, not the set", () => {
    // Flat AND semigloss both on the order: a semigloss note IS covered.
    const both = [
      { colorName: "01 White", colorCode: "01", finish: "Flat" },
      { colorName: "01 White", colorCode: "01", finish: "Semi-Gloss" },
    ];
    expect(inBuyList("Trim 01 White semigloss", both, "Semi-Gloss")).toBe(true);
    expect(inBuyList("Trim 01 White eggshell", both, "Eggshell")).toBe(false);
  });
});

describe("FU.6 — exterior sheens read least shine to most", () => {
  // "Reorder the finishes for exterior products: flat, satin, low lustre,
  // soft gloss (flip satin and low lustre)."
  const order = (list: string[]) =>
    list.filter((f) => ["Flat", "Satin", "Low Lustre", "Soft Gloss"].includes(f));

  it("puts satin before low lustre on a declared product", () => {
    const got = finishOptionsFor([], "Ultra Spec", "exterior");
    expect(order(got)).toEqual(["Satin", "Low Lustre", "Soft Gloss"]);
  });

  it("orders the generic exterior fallback the same way", () => {
    const got = finishOptionsFor(
      ["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss"],
      "Some Exterior Product Nobody Listed",
      "exterior"
    );
    expect(order(got)).toEqual(["Flat", "Satin", "Low Lustre", "Soft Gloss"]);
  });

  it("leaves the INTERIOR order alone", () => {
    // The ask is exterior-only. Interior keeps the ladder Jason set.
    expect(finishOptionsFor([], "Ultra Spec", "interior")).toEqual([
      "Flat", "Eggshell", "Satin", "Semi-Gloss",
    ]);
  });

  it("keeps a sheen the order does not name rather than dropping it", () => {
    // Gloss is not in Kate's four. It must still be offered, after them.
    const got = finishOptionsFor([], "SW Super Paint", "exterior");
    expect(got).toContain("Gloss");
    expect(got.indexOf("Flat")).toBeLessThan(got.indexOf("Gloss"));
  });

  it("drops nothing and adds nothing — same set, new order", () => {
    const before = finishOptionsFor([], "SW Duration", "exterior");
    expect([...before].sort()).toEqual([...new Set(before)].sort());
    expect(before.length).toBeGreaterThan(1);
  });
});

describe("FU.8 — multi-room lines on the confirmation email", () => {
  const surfaces = [
    { surface: "Walls", colorName: null, colorCode: null, finish: null, skipped: false },
    { surface: "Ceiling", colorName: null, colorCode: null, finish: null, skipped: false },
  ];

  it("leaves the surfaces OFF a multi-room room", () => {
    // The customer was never shown a picker for these, so "No color chosen
    // yet" reports a question nobody asked.
    const { html, text } = buildConfirmationEmail({
      ...EMAIL_BASE,
      rooms: [{ room: "Interior Painting", surfaces, notes: "Living Room:\nWalls: Carter Plum", multiRoom: true }],
    });
    expect(text).not.toContain("No color chosen yet");
    expect(html).not.toContain("No color chosen yet");
    // Their actual answer survives.
    expect(text).toContain("Carter Plum");
    expect(html).toContain("Carter Plum");
  });

  it("STILL shows them on an ordinary room", () => {
    // The blank is deliberate elsewhere: it is what gets someone back into
    // the form before we order.
    const { html, text } = buildConfirmationEmail({
      ...EMAIL_BASE,
      // Realistic: they answered Walls and not Ceiling. A room with nothing
      // at all is an empty submission the form already refuses.
      rooms: [{
        room: "Kitchen",
        surfaces: [
          { surface: "Walls", colorName: "01 White", colorCode: "01", finish: "Flat", skipped: false },
          { surface: "Ceiling", colorName: null, colorCode: null, finish: null, skipped: false },
        ],
        notes: null,
        multiRoom: false,
      }],
    });
    expect(text).toContain("No color chosen yet");
    expect(html).toContain("chosen yet");
  });

  it("keeps the line breaks between rooms in the HTML half", () => {
    // It went through escapeHtml alone, so HTML collapsed every newline and
    // the rooms ran together into one unreadable line.
    const { html } = buildConfirmationEmail({
      ...EMAIL_BASE,
      rooms: [{
        room: "Interior Painting",
        surfaces: [],
        notes: "Living Room:\nWalls: Carter Plum\n\nDining Room:\nWalls: 01 White",
        multiRoom: true,
      }],
    });
    expect(html).toContain("<br />");
    expect(html).toContain("margin-top:7px");
    expect(html).not.toMatch(/Carter Plum\s+Dining Room/);
  });

  it("escapes before it adds the breaks, so tags cannot be injected", () => {
    const { html } = buildConfirmationEmail({
      ...EMAIL_BASE,
      rooms: [{ room: "Kitchen", surfaces: [], notes: "<script>alert(1)</script>\nsecond line", multiRoom: false }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<br />");
  });
});

describe("a notes-only submission still reaches the customer's HTML receipt", () => {
  /**
   * Found while building FU.8, not asked for.
   *
   * The room table was gated on "are there any colors", and the per-room
   * notes live INSIDE that table. A multi-room customer answers entirely in
   * notes and picks no surface color, so the whole table was dropped and the
   * HTML receipt arrived with none of their answers. The plain-text half had
   * them all along, which is why it went unnoticed — mail clients show HTML.
   */
  const notesOnly = [{
    room: "Interior Painting",
    surfaces: [],
    notes: "Living Room:\nWalls: Carter Plum CW-355",
    multiRoom: true,
  }];

  it("prints their note in the HTML, not just the plain text", () => {
    const { html, text } = buildConfirmationEmail({ ...EMAIL_BASE, rooms: notesOnly });
    expect(text).toContain("Carter Plum CW-355");
    expect(html).toContain("Carter Plum CW-355");
  });

  it("calls it 'Notes received' rather than claiming colors", () => {
    const { html } = buildConfirmationEmail({ ...EMAIL_BASE, rooms: notesOnly });
    expect(html).toContain("Notes received");
    expect(html).not.toContain("Color selections received");
  });

  it("still prints nothing when there is genuinely nothing", () => {
    const { html } = buildConfirmationEmail({
      ...EMAIL_BASE,
      rooms: [{ room: "Kitchen", surfaces: [], notes: null, multiRoom: false }],
    });
    expect(html).not.toContain("<th align=\"left\"");
  });
});

describe("FU.6 — products whose single list IS the exterior list", () => {
  it("orders an exterior-only product that declares a flat array", () => {
    // "Ultra Spec Exterior" has one list, not a by-scope pair. The first
    // version of the reorder only touched by-scope products, so the ones
    // actually NAMED for the exterior kept the old order.
    expect(finishOptionsFor([], "Ultra Spec Exterior", "exterior")).toEqual([
      "Satin", "Low Lustre", "Soft Gloss",
    ]);
  });

  it("leaves an interior-only flat array alone", () => {
    expect(finishOptionsFor([], "Ultra Spec Interior", "interior")).toEqual([
      "Flat", "Eggshell", "Satin", "Semi-Gloss",
    ]);
  });
});
