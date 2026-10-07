import { describe, it, expect } from "vitest";
import {
  buildReceiptRooms,
  receiptSurfaceText,
  receiptIsEmpty,
  receiptFinishText,
  receiptRecipient,
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
    //
    // The plain-text body says it inline; the HTML says it in the Finish
    // column, where an empty cell would read as "nothing to do here".
    expect(receiptSurfaceText({ surface: "Ceiling", colorName: "Chantilly Lace", colorCode: "OC-65", finish: null, skipped: false }))
      .toContain("finish not chosen");
    expect(receiptFinishText({ surface: "Ceiling", colorName: "Chantilly Lace", colorCode: "OC-65", finish: null, skipped: false }))
      .toBe("Not chosen");
    expect(build().html).toContain("Not chosen");
    expect(build().text).toContain("finish not chosen");
  });

  it("gives the receipt real columns rather than sentences", () => {
    // Karan, 2026-10-01: "it looks like a lot and not like a receipt". The
    // fix was structural — Surface / Color / Finish as actual table columns,
    // with the color code in its own muted span instead of joined to the
    // finish by a "·" that made every row read as prose.
    const { html } = build();
    for (const heading of ["Surface", "Color", "Finish"]) {
      expect(html, heading).toContain(`>${heading}</th>`);
    }
    // The color and the finish are no longer welded into one string.
    expect(html).not.toContain("Stardust (2108-40) · Satin");
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

describe("who the Internal Entry button emails", () => {
  // Katie 2026-10-01: Internal Entry does not auto-send; it gets a button.
  // The trap is that `customer_email` on a kind="internal" row holds the PPP
  // STAFF MEMBER who opened the entry screen, so the obvious column is the
  // wrong one — it would mail an AM a receipt addressed to the customer.

  it("uses the WORK ORDER's email on an internal entry, never the token's", () => {
    const r = receiptRecipient({
      tokenKind: "internal",
      tokenEmail: "katie@precisionpaintingplus.net",
      tokenCustomerName: "[Internal Entry] katie@precisionpaintingplus.net",
      workOrderEmail: "jane@example.com",
      workOrderCustomerName: "Jane Doe",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.name).toBe("Jane Doe");
  });

  it("refuses to send rather than falling back to the staff address", () => {
    // The failure that matters. With no customer email on the work order the
    // answer is "tell the AM", never "send it to the nearest address we have".
    const r = receiptRecipient({
      tokenKind: "internal",
      tokenEmail: "katie@precisionpaintingplus.net",
      tokenCustomerName: "[Internal Entry] katie@precisionpaintingplus.net",
      workOrderEmail: null,
    });
    expect(r.email).toBeNull();
  });

  it("never greets a customer with the internal-entry label", () => {
    const r = receiptRecipient({
      tokenKind: "internal",
      tokenEmail: "katie@precisionpaintingplus.net",
      tokenCustomerName: "[Internal Entry] katie@precisionpaintingplus.net",
      workOrderEmail: "jane@example.com",
      workOrderCustomerName: null,
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.name).toBeNull();
  });

  it("uses the token's own email on an ordinary customer form", () => {
    const r = receiptRecipient({
      tokenKind: null,
      tokenEmail: "jane@example.com",
      tokenCustomerName: "Jane Doe",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.name).toBe("Jane Doe");
  });

  it("rejects an address that isn't one", () => {
    expect(receiptRecipient({ tokenKind: null, tokenEmail: "jane@example", tokenCustomerName: null }).email).toBeNull();
    expect(receiptRecipient({ tokenKind: null, tokenEmail: "   ", tokenCustomerName: null }).email).toBeNull();
  });
});

describe("a preview must look like the real thing", () => {
  // Katie, 2026-10-01, on the forwarded sample: "before the first room that's
  // listed, there is this text '[TEST 12:40 PM]'. Do you know what that is?"
  // It was a marker welded into the sample ROOM names. A reader cannot tell
  // that apart from a real defect in their receipt.

  it("keeps the test marker out of the content", () => {
    const preview = build({
      previewNotice: "Sample email sent to you at 12:40 PM from Settings.",
      subjectOverride: "[TEST] receipt preview",
    });
    // The rooms read normally…
    expect(preview.html).toContain("Interior Painting · Bathroom");
    expect(preview.html).not.toContain("[TEST] Interior Painting");
    // …and the fact that it is a sample is said once, in its own bar.
    expect(preview.html).toContain("Sample email sent to you");
    expect(preview.subject).toBe("[TEST] receipt preview");
  });

  it("shows no preview bar on a real receipt", () => {
    const real = build();
    expect(real.html).not.toContain("Preview.");
    expect(real.html).not.toContain("Sample email");
    // And the real subject comes from the editable template, not an override.
    expect(real.subject).toContain("Your color selections");
  });
});

/**
 * A notes-only submission — the customer wrote to us instead of picking.
 *
 * The receipt rendered the color table anyway: three column headings,
 * SURFACE / COLOR / FINISH, over nothing, beneath a green "Color selections
 * received". Both halves were wrong at once, and the reader is someone who had
 * just told us they were not ready to pick yet.
 */
describe("a receipt for notes with no colors", () => {
  const notesOnly = () =>
    build({
      rooms: buildReceiptRooms({
        lineItems: [{ id: "li-1", surfaces: [], notes: "" }],
        roomLabelById: ROOM_LABELS,
      }),
      globalNotes: "Not ready to choose yet — I'll call you Monday.",
    });

  it("does not draw an empty table", () => {
    const { html } = notesOnly();
    // The headings are the giveaway: present means the table rendered.
    expect(html).not.toMatch(/>Surface</i);
    expect(html).not.toMatch(/>Finish</i);
  });

  it("says notes were received, not colors", () => {
    const { html } = notesOnly();
    expect(html).toContain("Notes received");
    expect(html).not.toContain("Color selections received");
  });

  it("still carries the note itself and the edit button", () => {
    // The point of sending it at all.
    const { html, text } = notesOnly();
    // Substring without the apostrophe — it is HTML-escaped in `html` and raw
    // in `text`, and which one is not the point of this assertion.
    expect(html).toContain("Not ready to choose yet");
    expect(html).toContain("call you Monday");
    expect(text).toContain("Not ready to choose yet");
    expect(html).toMatch(/https:\/\/hub\.example\/select\/tok/);
  });

  it("still draws the table and says colors when there ARE colors", () => {
    // The guard must not have turned the normal receipt off.
    const { html } = build();
    expect(html).toMatch(/>Surface</i);
    expect(html).toContain("Color selections received");
  });
});
