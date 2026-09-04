import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colorDeadlineNotice } from "@/lib/customer-form/deadline-notice";
import { DEFAULT_TEMPLATES, buildVars, render } from "@/lib/customer-form/templates";

/**
 * Kate, 2026-09-04 — two asks on the colour tool.
 *
 *  1. Show the Salesforce line-item notes per room. "The field team's typical
 *     behavior is adding one line item to a Quote, then adding multiple rooms
 *     in the line item notes. Without the line item notes, the Account Managers
 *     and Customers cannot see which rooms are included."
 *
 *  2. Make the deadline explicit, on the customer email AND the entry page:
 *     "Deadline for submitting colors is [DEADLINE]. You have until 24 hours
 *      before the start date to submit edits."
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the deadline sentence", () => {
  it("names the sender's date when they set one", () => {
    const n = colorDeadlineNotice("2026-09-20", "2026-09-04");
    expect(n.hasExplicitDate).toBe(true);
    expect(n.text).toBe(
      "Deadline for submitting colors is Sunday, September 20. You have until 24 hours before the start date to submit edits."
    );
  });

  it("does not slide a day across the EDT/EST boundary", () => {
    // The bug this codebase already had once: anchoring a calendar date to a
    // hardcoded EST offset then formatting in America/New_York renders Aug 20
    // as August 21 through daylight time.
    expect(colorDeadlineNotice("2026-08-20", "2026-08-01").text).toContain("August 20");
    expect(colorDeadlineNotice("2026-01-15", "2026-01-01").text).toContain("January 15");
  });

  it("falls back to the start-date wording with no sender deadline", () => {
    const n = colorDeadlineNotice(null, "2026-09-04");
    expect(n.hasExplicitDate).toBe(false);
    expect(n.text).toContain("24 hours before the start date");
  });

  it("does not say the same thing twice in the fallback", () => {
    // Kate's literal wording, with the fallback substituted, would read
    // "…is 24 hours before the start date. You have until 24 hours before the
    // start date to submit edits." One promise, said once.
    const n = colorDeadlineNotice(null, "2026-09-04");
    const occurrences = n.text.split("24 hours before the start date").length - 1;
    expect(occurrences).toBe(1);
  });

  it("ignores a deadline that has already passed", () => {
    // Migration 147: customers were "regularly shown a deadline that has
    // already expired". A past date must not be presented as the deadline.
    const n = colorDeadlineNotice("2026-08-01", "2026-09-04");
    expect(n.hasExplicitDate).toBe(false);
    expect(n.text).not.toContain("August 1");
  });

  it("survives a malformed stored value", () => {
    for (const bad of ["", "   ", "not-a-date", "2026-13-45"]) {
      expect(() => colorDeadlineNotice(bad, "2026-09-04")).not.toThrow();
      expect(colorDeadlineNotice(bad, "2026-09-04").hasExplicitDate).toBe(false);
    }
  });
});

describe("the email and the page cannot promise different dates", () => {
  it("the email renders the identical sentence", () => {
    const vars = buildVars({ customerName: "Jane Doe", workOrderNumber: "00316046", colorDeadline: "2026-09-20" });
    const outro = render(DEFAULT_TEMPLATES.email_outro, vars);
    expect(outro).toContain(colorDeadlineNotice("2026-09-20").text);
  });

  it("no literal deadline wording is hand-written anywhere else", () => {
    // Two copies of a sentence is how the email and the page start disagreeing.
    const view = read("components/customer-form-view.tsx");
    expect(view).not.toMatch(/Deadline for submitting colors is/);
    expect(view).toMatch(/colorDeadlineNotice\(colorDeadline\)/);
  });

  it("the template variable is registered with the typo linter", () => {
    // Otherwise the editor flags our own default email as a misspelling.
    expect(read("components/templates-editor.tsx")).toContain('"color_deadline_notice"');
  });

  it("the deadline reaches the email sender from the create route", () => {
    expect(read("app/api/admin/customer-form/create/route.ts")).toMatch(/colorDeadline,/);
    expect(read("lib/email/resend.ts")).toMatch(/colorDeadline: input\.colorDeadline/);
  });
});

describe("line-item notes reach every surface Kate named", () => {
  it("Description is pulled in BOTH Salesforce read paths", () => {
    // Assert the MAPPING, not the field name. queries.ts already selected
    // "Description" on the WorkOrder query long before this change, so a bare
    // /"Description",/ passes whether or not the WOLI query asks for it —
    // verified: deleting it from the WOLI field list left that assertion green.
    const q = read("lib/salesforce/queries.ts");
    expect(q).toMatch(/description: str\(r, "Description"\)/);
    // ...and pin it inside the WOLI field list specifically.
    const woliFields = q.slice(q.indexOf("const baseFields = ["), q.indexOf("const baseFields = [") + 1600);
    expect(woliFields).toMatch(/"Description",/);

    const rd = read("lib/customer-form/render-data.ts");
    expect(rd).toMatch(/lineItemNotes: str\("Description"\)/);
    expect(rd).toMatch(/"Description",/);
  });

  it("the internal + customer entry forms render it", () => {
    const view = read("components/customer-form-view.tsx");
    expect(view).toMatch(/<LineItemNotes notes=\{lineItem\.lineItemNotes\}/);
  });

  it("Order Materials renders it, fed from the snapshot", () => {
    expect(read("components/order-builder-view.tsx")).toMatch(/<LineItemNotes notes=\{l\.notes\}/);
    expect(read("lib/materials/order-page-data.ts")).toMatch(/notes: li\.raw\.description/);
  });

  it("it is COLLAPSED by default — the colour pickers stay above the fold", () => {
    const c = read("components/line-item-notes.tsx");
    expect(c).toMatch(/useState\(false\)/);
    // and renders nothing at all when empty (27% of lines have no Description)
    expect(c).toMatch(/if \(!cleaned\) return null;/);
  });

  it("keeps line breaks — a room list joined into a paragraph is unreadable", () => {
    expect(read("components/line-item-notes.tsx")).toMatch(/whitespace-pre-line/);
  });
});
