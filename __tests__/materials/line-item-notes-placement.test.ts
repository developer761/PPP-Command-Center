import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kate, 2026-09-08: "The dropdown here collapses the entire line item instead
 * of opening the notes."
 *
 * LineItemNotes renders its own <button>. On the color form it had been placed
 * INSIDE the room's collapse toggle — a button within a button, which is
 * invalid markup and, more to the point, means the outer control receives every
 * click. Pressing the notes chevron collapsed the whole room.
 *
 * The repo already has this rule written down: trace the HTML tree after any
 * layout change, no nested forms, no swallowed clicks. This asserts it, because
 * "it type-checks" and "it renders" both stayed true while the control did
 * nothing a user wanted.
 *
 * Comments are stripped before counting. The first version of this check read
 * the fix's own comment — which contains the words "a button within a button" —
 * and reported the bug as still present after it was fixed.
 */
const ROOT = join(__dirname, "..", "..");

/** Every surface that renders the notes control. */
const CONSUMERS = [
  "components/customer-form-view.tsx",
  "components/materials-view.tsx",
  "components/order-builder-view.tsx",
];

function strip(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the notes control is never inside another clickable", () => {
  it.each(CONSUMERS)("%s renders it outside any button or summary", (file) => {
    const code = strip(readFileSync(join(ROOT, file), "utf8"));
    let from = 0;
    let found = 0;
    for (;;) {
      const i = code.indexOf("<LineItemNotes", from);
      if (i === -1) break;
      found += 1;
      const before = code.slice(0, i);
      for (const tag of ["button", "summary", "a"] as const) {
        const opens = (before.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
        const closes = (before.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
        expect(
          opens > closes,
          `${file}: <LineItemNotes> sits inside an unclosed <${tag}> — its own button cannot receive the click`
        ).toBe(false);
      }
      from = i + 1;
    }
    expect(found, `${file} no longer renders LineItemNotes`).toBeGreaterThan(0);
  });

  it("the control really does render a button — the reason placement matters", () => {
    const c = readFileSync(join(ROOT, "components/line-item-notes.tsx"), "utf8");
    expect(c).toMatch(/<button/);
    expect(c).toMatch(/onClick=\{\(\) => setOpen/);
  });

  it("reaches all three surfaces Kate asked for", () => {
    // color forms (internal + customer), Rooms & colors, and the order page.
    for (const f of CONSUMERS) {
      expect(strip(readFileSync(join(ROOT, f), "utf8")), f).toContain("<LineItemNotes");
    }
  });
});
