/**
 * Kate p21: "When copying the materials order to my clipboard on mobile, it
 * doesn't paste properly into Gmail." Her screenshot shows the whole order
 * percent-encoded in a Gmail compose window.
 *
 * The encoding is NOT ours. Checked, not assumed: the draft API returns clean
 * text, handleCopy hands a plain string to the clipboard, there is no mailto:
 * or encodeURI in the order flow, and the control is a plain button. The
 * escape pattern does not even match a JS encoder — "," and "(" survive while
 * ":" and "[" are escaped, which is neither encodeURI nor encodeURIComponent.
 *
 * What WAS ours is that a copy which succeeds and pastes wrong left her no
 * way out, because the manual fallback only existed behind a thrown error.
 * These tests pin the way out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const SRC = "components/order-fulfillment-view.tsx";

describe("copying the order to the clipboard", () => {
  const src = () => strip(read(SRC));

  it("never encodes the ORDER TEXT", () => {
    // The thing being ruled out. Scoped to the body/subject on purpose:
    // encodeURIComponent(workOrderId) in an href is correct and unrelated,
    // and a blanket ban would fail on it and get deleted by the next person.
    const s = src();
    for (const subject of ["copyText", "bodyToSend", "draft?.subject", "draft.body"]) {
      expect(
        s,
        `the order text is being URL-encoded via ${subject}`
      ).not.toMatch(new RegExp(`encodeURI(Component)?\\(\\s*${subject.replace(/[.?]/g, "\\$&")}`));
    }
    // Every encode that IS here must be a route parameter.
    const encodes = s.match(/encodeURI(?:Component)?\([^)]*\)/g) ?? [];
    for (const e of encodes) {
      expect(e, `unexpected encode: ${e}`).toMatch(/encodeURIComponent\(workOrderId\)/);
    }
    expect(s).not.toContain("mailto:");
  });

  it("copies one string that the manual box also shows", () => {
    // Two sources would drift, and the fallback would quietly hand her
    // something different from what the button copies.
    const s = src();
    expect(s).toMatch(/const copyText = `Subject: \$\{draft\?\.subject \?\? ""\}\\n\\n\$\{bodyToSend\}`/);
    expect(s).toMatch(/value=\{copyText\}/);
    expect(s).toMatch(/new Blob\(\[copyText\]/);
  });

  it("offers the manual box WITHOUT waiting for an error", () => {
    // The whole point. The reported failure is a copy that succeeds, so an
    // error-gated fallback never shows up for it.
    const s = src();
    const toggleAt = s.indexOf("setShowCopyText((v) => !v)");
    expect(toggleAt, "no always-available toggle").toBeGreaterThan(-1);
    // Rendered on the flag alone, not on copyError.
    expect(s).toMatch(/\{showCopyText && \(/);
    expect(s).not.toMatch(/copyError && showCopyText/);
  });

  it("opens the box automatically when the copy does throw", () => {
    expect(src()).toMatch(/catch \(err\)[\s\S]{0,200}setShowCopyText\(true\)/);
  });

  it("declares text/plain and still falls back to writeText", () => {
    // Speculative half of the fix: an explicit flavour cannot be
    // re-interpreted. It must degrade where ClipboardItem is missing rather
    // than throwing on an older phone.
    const s = src();
    expect(s).toMatch(/typeof ClipboardItem !== "undefined"/);
    expect(s).toMatch(/"text\/plain":/);
    expect(s).toMatch(/else \{[\s\S]{0,120}writeText\(copyText\)/);
  });

  it("makes the box selectable and read-only", () => {
    const s = src();
    expect(s).toMatch(/readOnly/);
    expect(s).toMatch(/onFocus=\{\(e\) => e\.currentTarget\.select\(\)\}/);
  });

  it("gives the toggle a 44px target and announces its state", () => {
    const s = src();
    const at = s.indexOf("setShowCopyText((v) => !v)");
    const el = s.slice(Math.max(0, at - 300), at + 500);
    expect(el).toMatch(/aria-expanded=\{showCopyText\}/);
    expect(el).toMatch(/min-h-\[44px\]/);
  });
});
