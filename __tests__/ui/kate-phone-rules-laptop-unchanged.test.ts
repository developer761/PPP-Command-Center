/**
 * KATE'S PHONE RULES, WITHOUT MOVING THE LAPTOP.
 *
 * Karan 2026-10-08: "for the phone follow kates rules the laptop should stay
 * exactly as is."
 *
 * Two of Kate's mobile requests contradict what Katie asked for on 2026-09-08,
 * and the "Line items on this WO" panel has already been flipped once (R4.18
 * collapsed it, Katie reversed it). The resolution is per-screen, so the thing
 * that needs guarding is not that the phone changed — a screenshot shows that —
 * but that the DESKTOP did not. A responsive class with a missing `lg:` looks
 * right on the phone it was tested on and silently moves the laptop, and nobody
 * is looking at the laptop when they build a phone fix.
 *
 * So every assertion here is about a BREAKPOINT PREFIX. They are source
 * assertions, which is normally the weak kind — but the artifact under test IS
 * a Tailwind class string: there is no rendered value to read, since whether
 * `hidden` applies depends on a viewport no unit test has. Comments are
 * stripped first; one of these anchors matched inside my own docblock on
 * 2026-10-08 before that was added.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "components/order-builder-view.tsx";

/** Comments quote the very class names these tests search for. */
function stripComments(s: string): string {
  return s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const src = stripComments(readFileSync(SRC, "utf8"));

function at(anchor: string): number {
  const i = src.indexOf(anchor);
  expect(i, `anchor not found in ${SRC}: ${anchor}`).toBeGreaterThan(-1);
  return i;
}

/** The className="..." (or className={`...`}) that FOLLOWS an anchor. */
function classNameAfter(anchor: string): string {
  const window = src.slice(at(anchor), at(anchor) + 1200);
  const m = window.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
  expect(m, `no className after: ${anchor}`).toBeTruthy();
  return (m![1] ?? m![2]) as string;
}

/**
 * The className of the nearest ENCLOSING `<tag` before an anchor.
 *
 * Needed because the useful anchors are inner text — `Vendor</h2>`, `Source
 * data (Salesforce)` — and a forward search from those lands on a child's
 * className instead of the container's. Searching backwards for the opening
 * tag is what actually identifies the element being asserted about.
 */
function enclosingClassName(anchor: string, tag: string): string {
  const open = src.lastIndexOf(`<${tag}`, at(anchor));
  expect(open, `no <${tag} before: ${anchor}`).toBeGreaterThan(-1);
  const m = src
    .slice(open, at(anchor))
    .match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
  expect(m, `no className on the <${tag} before: ${anchor}`).toBeTruthy();
  return (m![1] ?? m![2]) as string;
}

/**
 * The root container and the header are identified structurally rather than by
 * a class we are asserting about: the root is the element carrying the
 * pre-existing `pb-4`, and the header is the `<div>` written immediately after
 * it. Anchoring on `lg:space-y-5` or `max-lg:order-first` would be a test that
 * finds the string it is looking for and then asserts the string is there.
 */
function rootContainer(): string {
  const m = src.match(/className="([^"]*\bpb-4\b[^"]*)"/);
  expect(m, "no container carrying pb-4 — the root layout was restructured").toBeTruthy();
  return m![1];
}

function headerContainer(): string {
  const root = src.indexOf(rootContainer());
  const m = src.slice(root).match(/>\s*<div className="([^"]*)"/);
  expect(m, "no <div> immediately inside the root container").toBeTruthy();
  return m![1];
}

describe("Kate's phone rules do not move the laptop", () => {
  /* ── 1. Vendor first, on the phone only ───────────────────────────────── */

  it("reorders with max-lg: so the desktop DOM order is what renders", () => {
    const vendor = enclosingClassName(">Vendor</h2>", "section");
    // Not `order-first` bare — that would hoist the vendor above the header on
    // every screen, which is neither what Kate asked for nor what Katie has.
    expect(vendor).toContain("max-lg:order-first");
    expect(vendor).not.toMatch(/(?<!max-lg:)\border-first\b/);
  });

  it("makes the container a flex column on the phone ONLY", () => {
    const root = rootContainer();

    // The phone needs flex for order-* to mean anything.
    expect(root).toContain("max-lg:flex");
    expect(root).toContain("max-lg:flex-col");

    // The laptop must stay the block + space-y-5 container Katie signed off.
    expect(root).toContain("lg:space-y-5");

    // A bare `flex` or `space-y-5` here is the whole failure mode: the first
    // changes desktop layout, the second double-spaces the phone on top of
    // gap-5. Both look fine on the screen the author was testing.
    expect(root).not.toMatch(/(?<![-:\w])flex\b/);
    expect(root).not.toMatch(/(?<![-:\w])space-y-5\b/);
  });

  it("keeps the header above the vendor on the phone", () => {
    // Equal order keeps DOM order, so the header must ALSO be order-first or
    // the vendor card jumps above "Back to work order" and the page title.
    const header = headerContainer();
    expect(header).toContain("max-lg:order-first");
  });

  /* ── 2. Line items collapsed, on the phone only ───────────────────────── */

  it("hides the collapsed list on the phone and leaves it OPEN on desktop", () => {
    const list = classNameAfter('id="source-lines-list"');

    // The collapsed branch must re-show at lg. Plain `hidden` here is the bug
    // that would hide Salesforce line items on the laptop — the exact panel
    // Katie asked to be always visible, and the office checks the buy-list
    // against it.
    expect(list).toContain("hidden lg:block");
    expect(list).toMatch(/sourceLinesOpen\s*\?\s*""\s*:\s*"hidden lg:block"/);
  });

  it("shows the toggle on the phone and never on desktop", () => {
    const toggle = classNameAfter("onClick={() => setSourceLinesOpen(");
    expect(toggle).toContain("lg:hidden");
    // Katie's panel has no control at all; a toggle appearing at lg would be a
    // dropdown, which is the thing she asked us to remove.
    expect(toggle).not.toMatch(/(?<!max-)lg:(?!hidden)/);
  });

  it("keeps a desktop header that is present only at lg", () => {
    const deskHeader = enclosingClassName("Source data (Salesforce)", "div");
    expect(deskHeader).toContain("hidden lg:block");
  });

  it("gives the phone toggle a real button's semantics", () => {
    const at = src.indexOf("onClick={() => setSourceLinesOpen(");
    expect(at).toBeGreaterThan(-1);
    const el = src.slice(Math.max(0, at - 400), at + 600);
    // A collapsing region that does not say whether it is open is unusable
    // without sight, and these are read by field staff on phones.
    expect(el).toContain("aria-expanded={sourceLinesOpen}");
    expect(el).toContain('aria-controls="source-lines-list"');
    expect(el).toContain('type="button"');
    // 44px — the same touch floor the rest of this round was fixed to.
    expect(el).toMatch(/min-h-\[44px\]/);
  });

  it("starts collapsed, which is the whole request", () => {
    const raw = readFileSync(SRC, "utf8");
    expect(raw).toMatch(/const \[sourceLinesOpen, setSourceLinesOpen\] = useState\(false\)/);
  });

  /* ── The sweep: no unprefixed responsive class crept in ───────────────── */

  it("scopes every phone-round class to a breakpoint", () => {
    // Proves this suite measured something rather than passing on an empty
    // scan: these are the four class strings the round touched.
    const seen = [
      rootContainer(),
      enclosingClassName(">Vendor</h2>", "section"),
      classNameAfter('id="source-lines-list"'),
      classNameAfter("onClick={() => setSourceLinesOpen("),
    ];
    expect(seen).toHaveLength(4);
    for (const cls of seen) expect(cls.length).toBeGreaterThan(0);

    /**
     * An element carrying `lg:hidden` does not exist on a laptop, so an
     * unprefixed `flex` on it cannot move one — the phone toggle legitimately
     * uses bare `flex items-center`. The rule is only about elements that DO
     * render at lg, and writing it the stricter way would have forced a
     * pointless `max-lg:` onto classes that are already unreachable.
     */
    const reachesDesktop = seen.filter((c) => !/\blg:hidden\b/.test(c));
    expect(
      reachesDesktop.length,
      "every touched element is lg:hidden — the scan proved nothing"
    ).toBeGreaterThan(0);

    for (const cls of reachesDesktop) {
      for (const tok of cls.split(/\s+/)) {
        if (/^(order-|flex$|flex-col$|gap-\d)/.test(tok)) {
          expect(tok, `${tok} is unprefixed and would change the laptop`).toMatch(
            /^(max-)?lg:/
          );
        }
      }
    }
  });
});
