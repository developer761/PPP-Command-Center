import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

/** Kate's "Paint Tool Mobile Modifications", 2026-10-07 — the cosmetic half. */

describe("the work order progress header", () => {
  const src = read("components/work-order-progress-bar.tsx");

  it("never prints a Salesforce id fragment as a work order number", () => {
    // "random letters at end of title: DZFOAW" — the fallback was
    // workOrderId.slice(-6), an ID fragment shown as though it were a number.
    expect(strip(src)).not.toMatch(/workOrderId\.slice\(-6\)/);
    expect(src).toContain("Work order number not set");
  });

  it("does not label two different steps the same word", () => {
    // Step 1 (form sent) and step 5 (order sent) both read "Sent" on the
    // mobile timeline — two different events, indistinguishable in one list.
    const shorts = [...src.matchAll(/shortLabel:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(shorts.length).toBeGreaterThanOrEqual(5);
    expect(new Set(shorts).size, `duplicate step labels: ${shorts.join(", ")}`).toBe(shorts.length);
  });
});

describe("the order page alerts", () => {
  const src = read("components/order-builder-view.tsx");

  it("names the room that asked for the accent wall", () => {
    expect(src).toContain("Accent wall requested");
    expect(src).toMatch(/accentWallRooms/);
    // The old wording pointed at "this line", which on a color spanning six
    // rooms pointed at all of them.
    expect(strip(src)).not.toContain("accent wall on this line");
  });

  it("colors the accent wall as a warning, not an error", () => {
    // Kate: "Make alerts yellow and errors red. This should be yellow."
    // Searched in the COMMENT-STRIPPED source. Two traps hit in a row here:
    // a fixed 900-char lookback landed before the className, and then the
    // explanatory comment I had just written quotes Kate's own example
    // ("Accent wall requested in Dining Room"), so the anchor matched inside
    // the comment rather than the markup. Strip first, always.
    const code = strip(src);
    const start = code.indexOf("{e.accentWallReview && (");
    const block = code.slice(start, code.indexOf("Accent wall requested", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/bg-amber-50/);
    expect(block).toMatch(/text-amber-800/);
    expect(block).not.toMatch(/bg-ppp-orange-50\b/);
  });

  it("inverts the product-line error so it reads as the blocking one", () => {
    // "Invert the colors so the alert is the darker red and the text is the
    // lighter red." Verified AA before shipping: 5.51:1 light, 8.02:1 dark.
    expect(src).toMatch(/text-ppp-orange-50 bg-ppp-orange-700/);
  });

  it("tints the field itself, not just its ring", () => {
    expect(src).toMatch(/ring-2 ring-ppp-orange-700 bg-ppp-orange-500\/10/);
  });

  it("calls the section by the name the heading uses", () => {
    // "Rename Buy-list to Order — what to buy so they know which section is
    // being referred to." The heading already did; this stray line did not.
    expect(src).toContain("Already in &ldquo;Order &mdash; what to buy&rdquo; above.");
    expect(strip(src)).not.toContain("Already in the buy-list above");
  });
});

describe("the unit selector", () => {
  const src = read("components/order-builder-view.tsx");

  it("always offers the same three, so rows stop changing width", () => {
    expect(src).toMatch(/\(\["gal", "qt", "bucket"\] as PaintUnit\[\]\)/);
  });

  it("keeps the five-gallon rule by disabling, not hiding", () => {
    // Karan 2026-09-09: nobody orders a pail for two gallons of paint.
    expect(src).toMatch(/const bucketAllowed = \(unit === "gal" && total >= 5\) \|\| unit === "bucket"/);
    expect(src).toMatch(/disabled = u === "bucket" && !bucketAllowed/);
    expect(src).toMatch(/A bucket is five gallons/);
  });

  it("is readable — Kate asked for the text to be bigger", () => {
    const block = src.slice(src.indexOf("const bucketAllowed"), src.indexOf("const bucketAllowed") + 1400);
    expect(block).toMatch(/text-\[13px\]/);
    expect(block).not.toMatch(/text-\[11px\]/);
  });
});

describe("the materials list", () => {
  it("shrinks the help mark without shrinking the tap target", () => {
    const src = read("components/info-dot.tsx");
    expect(strip(src)).not.toMatch(/h-11 w-11/);   // the 44px visible disc
    expect(src).toMatch(/min-h-\[44px\]/);          // still thumb-sized
    expect(src).toMatch(/after:-inset-x-3/);        // hit area beyond the mark
  });

  it("lets the attention chips span the full width when stacked", () => {
    const src = read("components/materials-view.tsx");
    expect(src).toMatch(/flex w-full items-center[^`"]*sm:inline-flex sm:w-auto/);
    expect(src).toMatch(/flex flex-col items-stretch gap-2 sm:flex-row/);
  });
});

/**
 * Kate p15: "random order materials button at bottom of page."
 *
 * There were two Order Materials buttons to the same route on a phone — the
 * Materials card one and the sticky bottom bar. Neither could simply be
 * deleted: the card button carries every refusal reason and sits above the
 * per-room list, and the sticky bar is what saves scrolling back up after you
 * finish entering colors. They are now mutually exclusive instead.
 */
describe("the two Order Materials buttons are never both on screen", () => {
  const src = () => strip(read("components/materials-view.tsx"));

  it("gates the sticky bar on the card button being out of view", () => {
    // The bar's own preconditions must survive — without line items, picking a
    // supplier produces a blank paint order (audit 2026-07-01).
    expect(src()).toMatch(
      /job\.lineItems\.length > 0 && canOrderMaterials && orderCtaOffScreen &&/
    );
  });

  it("watches the card button, not something else", () => {
    const s = src();
    // The ref has to be ON the block holding the card CTA, or the bar hides and
    // shows against an unrelated element.
    expect(s).toMatch(/<div ref=\{orderCtaRef\} className="flex flex-col gap-1\.5">/);
    expect(s).toMatch(/io\.observe\(el\)/);
    expect(s).toMatch(/setOrderCtaOffScreen\(!entry\.isIntersecting\)/);
  });

  it("starts hidden, because the card button is on screen at the top", () => {
    expect(src()).toMatch(/useState\(false\)[^\n]*\n?/);
    expect(src()).toMatch(/const \[orderCtaOffScreen, setOrderCtaOffScreen\] = useState\(false\)/);
  });

  it("degrades to the card button alone when IntersectionObserver is missing", () => {
    // SSR and old browsers. Failing closed here means one working button, not
    // a bar that never hides or a crash on render.
    expect(src()).toMatch(/typeof IntersectionObserver === "undefined"\) return/);
    expect(src()).toMatch(/io\.disconnect\(\)/);
  });

  it("keeps the bottom padding unconditional so the page does not jump", () => {
    // pb-24 reserves room for the bar. Tying it to the same flag would change
    // the document height mid-scroll, which is worse than a little dead space.
    expect(src()).toMatch(
      /canOrderMaterials && activeJob\.lineItems\.length > 0 \? "pb-24 lg:pb-0" : ""/
    );
  });
});
