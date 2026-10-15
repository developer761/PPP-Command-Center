/**
 * Kate — "Paint Tool Modifications-2.pdf", 12 pages, received 2026-10-15.
 * Items FU.1 … FU.16 (FU.4 and FU.9 are absent from her document).
 *
 * One file for the batch so the asks stay next to the code that answers
 * them, each test naming the item it belongs to.
 */
import { describe, it, expect } from "vitest";
import { finishOptionsFor, PAINT_LINE_VALUES, BASE_FINISHES } from "@/lib/customer-form/material-types";
import { buildConfirmationEmail } from "@/lib/customer-form/confirmation-email";
import { inBuyList } from "@/lib/supplier-order/color-note-items";
import { surfacesMissingFinish, missingFinishMessage } from "@/lib/customer-form/missing-finish";
import { COLOR_BRANDS, DEFAULT_COLOR_BRAND } from "@/lib/customer-form/color-brands";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("FU.1 — a color with no finish blocks the save", () => {
  const R = (o: Partial<Parameters<typeof surfacesMissingFinish>[0][number]>) => ({
    room: "Kitchen", surface: "Walls", ...o,
  });

  it("blocks a color with no finish", () => {
    expect(surfacesMissingFinish([R({ colorId: "c1", finish: null })]))
      .toEqual(["Kitchen → Walls"]);
  });

  it("ALLOWS an empty surface — saving partial progress is the point", () => {
    // Her ask is explicit: "continue allowing the customer to save the form
    // without all colors filled in so they can save progress and come back."
    expect(surfacesMissingFinish([R({ colorId: null, finish: null })])).toEqual([]);
  });

  it("allows a surface they said not to paint", () => {
    expect(surfacesMissingFinish([R({ colorId: "c1", finish: null, skipped: true })])).toEqual([]);
  });

  it("allows a color that has its finish", () => {
    expect(surfacesMissingFinish([R({ colorId: "c1", finish: "Flat" })])).toEqual([]);
  });

  it("treats a whitespace finish as missing", () => {
    expect(surfacesMissingFinish([R({ colorId: "c1", finish: "   " })]))
      .toEqual(["Kitchen → Walls"]);
  });

  it("names every offender, room and surface", () => {
    expect(surfacesMissingFinish([
      R({ colorId: "c1", finish: "Flat" }),
      R({ room: "Hall", surface: "Trim", colorId: "c2", finish: null }),
      R({ room: "Bath", surface: "Ceiling", colorId: "c3", finish: null }),
    ])).toEqual(["Hall → Trim", "Bath → Ceiling"]);
  });

  it("promises their other answers are safe", () => {
    // The September failure was a refusal that DID lose their work. The
    // message has to say this one does not, or it reads the same.
    expect(missingFinishMessage(["Hall → Trim"])).toMatch(/Nothing else you have entered is lost/);
    expect(missingFinishMessage(["a", "b"])).toContain("a; b");
    expect(missingFinishMessage([])).toBe("");
  });
});

describe("FU.1 — the form actually refuses, in the browser", () => {
  const src = () =>
    readFileSync(join(__dirname, "..", "..", "components/customer-form-view.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

  it("returns before sending when a finish is missing", () => {
    const s = src();
    expect(s).toMatch(/if \(!isStaffEntry && missingFinish\.length > 0\)/);
    const at = s.indexOf("missingFinish.length > 0");
    expect(s.slice(at, at + 220)).toMatch(/return;/);
  });

  it("uses the shared message, not a second copy of the wording", () => {
    expect(src()).toContain("missingFinishMessage(missingFinish)");
  });

  it("drops out of the confirmation step so they see the form again", () => {
    const s = src();
    const at = s.indexOf("missingFinish.length > 0");
    expect(s.slice(at, at + 220)).toContain("setConfirming(false)");
  });
});

describe("FU.15 / FU.16 — the product line list", () => {
  it("offers an interior and an exterior of each line Kate named", () => {
    for (const v of [
      "Ultra Spec Interior", "Ultra Spec Exterior",
      "Regal Select Interior", "Regal Select Exterior",
      "Ben Interior", "Ben Exterior",
      "Aura Interior", "Aura Exterior",
      "SW Emerald Interior", "SW Emerald Exterior",
      "SW Duration Interior", "SW Duration Exterior",
      "SW Super Paint Interior", "SW Super Paint Exterior",
    ]) {
      expect(PAINT_LINE_VALUES, `${v} missing from the picker`).toContain(v);
    }
  });

  it("adds Evo by Gemini (FU.16)", () => {
    expect(PAINT_LINE_VALUES).toContain("Evo by Gemini");
  });

  it("gives each new variant the sheens for its OWN side of the wall", () => {
    // None declares a finish list — inventing sheens is how a deck gets
    // ordered in eggshell — so each must inherit the right vocabulary.
    // BASE_FINISHES is what the picker passes; ALL_FINISH_VALUES is the
    // server's accept-list and is deliberately wider.
    const ext = finishOptionsFor(BASE_FINISHES, "Regal Select Exterior", "exterior");
    expect(ext).toContain("Low Lustre");
    expect(ext).toContain("Soft Gloss");
    expect(ext).not.toContain("Eggshell");

    const int = finishOptionsFor(BASE_FINISHES, "Regal Select Interior", "interior");
    expect(int).toContain("Eggshell");
    expect(int).not.toContain("Low Lustre");
  });

  it("orders the inherited exterior sheens Kate's way (FU.6)", () => {
    const ext = finishOptionsFor(BASE_FINISHES, "Aura Exterior", "exterior");
    const named = ext.filter((f) => ["Flat", "Satin", "Low Lustre", "Soft Gloss"].includes(f));
    expect(named).toEqual(["Flat", "Satin", "Low Lustre", "Soft Gloss"]);
  });

  it("every new value is accepted by the server", () => {
    // A dropdown option the submit route rejects is the 400 that told a
    // customer their own valid choice was invalid (2026-09-09).
    for (const v of ["Regal Select Exterior", "Aura Interior", "Evo by Gemini", "SW Duration Exterior"]) {
      expect(PAINT_LINE_VALUES).toContain(v);
    }
  });
});

describe("FU.10 — the brand toggle", () => {
  it("offers Benjamin Moore, Sherwin Williams and Farrow & Ball", () => {
    expect(COLOR_BRANDS.map((b) => b.label)).toEqual([
      "Benjamin Moore", "Sherwin Williams", "Farrow & Ball",
    ]);
  });

  it("defaults to Benjamin Moore — 'as now'", () => {
    expect(DEFAULT_COLOR_BRAND.id).toBe("benjamin-moore");
    expect(COLOR_BRANDS[0].id).toBe("benjamin-moore");
  });

  it("carries every URL Kate listed, rejoined where the PDF wrapped them", () => {
    const all = COLOR_BRANDS.flatMap((b) => b.links.map((l) => l.href));
    for (const href of [
      "https://www.farrow-ball.com/us/paint/all-paint-colours",
      "https://www.farrow-ball.com/us/room-inspiration",
      "https://www.farrow-ball.com/us/paint/exterior-masonry",
      "https://www.sherwin-williams.com/en-us/color/color-collections",
      // "color-vis / ualizer" in her PDF — a URL wrong by one character
      // still looks right in review and 404s for the customer.
      "https://www.sherwin-williams.com/en-us/color/color-tools/color-visualizer/cvw/#/active",
      "https://www.sherwin-williams.com/en-us/color/exterior-paint-colors",
      // "vin / yl-safe" in her PDF.
      "https://www.sherwin-williams.com/en-us/color/color-collections/vinyl-safe",
    ]) {
      expect(all, `${href} missing`).toContain(href);
    }
  });

  it("keeps the Benjamin Moore links that were already there", () => {
    const bm = COLOR_BRANDS[0].links.map((l) => l.href);
    expect(bm).toContain("https://www.benjaminmoore.com/en-us/color-overview/color-palettes");
    expect(bm).toContain("https://www.benjaminmoore.com/en-us/color-overview/find-your-color/color-a-room");
    expect(bm).toContain("https://www.benjaminmoore.com/en-us/b/woodluxe-exterior-wood-stain");
  });

  it("has no line breaks or spaces hiding in a URL", () => {
    for (const b of COLOR_BRANDS) {
      for (const l of b.links) {
        expect(l.href, l.href).toMatch(/^https:\/\/\S+$/);
        expect(l.href).not.toMatch(/\s/);
      }
    }
  });

  it("gives every brand its own blurb and at least three links", () => {
    for (const b of COLOR_BRANDS) {
      expect(b.blurb.length, b.label).toBeGreaterThan(40);
      expect(b.links.length, b.label).toBeGreaterThanOrEqual(3);
    }
  });

  it("shows the vinyl chart only under Benjamin Moore", () => {
    // It is a BM chart; Sherwin Williams has its own VinylSafe link.
    const src = readFileSync(join(__dirname, "..", "..", "components/customer-form-view.tsx"), "utf8");
    expect(src).toMatch(/brand\.id === "benjamin-moore" && \(/);
  });
});
