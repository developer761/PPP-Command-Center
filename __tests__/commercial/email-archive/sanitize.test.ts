import { describe, it, expect } from "vitest";
import {
  sanitizeEmailHtml,
  htmlToPlainText,
} from "@/lib/commercial/email-archive/sanitize";

/**
 * Tests for lib/commercial/email-archive/sanitize.ts — the DOMPurify-grade
 * sanitizer for archived email bodies (R8 hardening).
 *
 * These assert SECURITY INVARIANTS (no executable content survives) rather than
 * exact output strings — DOMPurify normalizes markup (attribute order, quoting,
 * self-closing), so pinning exact strings would be brittle. What must ALWAYS
 * hold: no <script>/<iframe>/<style>, no on-* handlers, no javascript:/vbscript:
 * URLs, no inline style=, and links are forced safe.
 */

const hasScript = (s: string) => /<script/i.test(s);
const hasOnHandler = (s: string) => /\son\w+\s*=/i.test(s);
const hasJsUrl = (s: string) => /javascript:|vbscript:/i.test(s);

describe("sanitizeEmailHtml — removes executable content", () => {
  it("drops <script> tags and their contents", () => {
    const out = sanitizeEmailHtml("<p>Hi</p><script>alert(1)</script><p>Bye</p>");
    expect(hasScript(out)).toBe(false);
    expect(out).toContain("Hi");
    expect(out).toContain("Bye");
  });

  it("drops <iframe>", () => {
    const out = sanitizeEmailHtml('<iframe src="http://evil.com"></iframe>OK');
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toContain("OK");
  });

  it("drops <style> blocks", () => {
    const out = sanitizeEmailHtml("<style>body{background:red}</style>OK");
    expect(out).not.toMatch(/<style/i);
    expect(out).toContain("OK");
  });

  it("strips on-* event handlers", () => {
    const out = sanitizeEmailHtml('<p onclick="alert(1)" onmouseover="x()">hi</p>');
    expect(hasOnHandler(out)).toBe(false);
    expect(out).toContain("hi");
  });

  it("strips inline style attributes", () => {
    const out = sanitizeEmailHtml('<p style="background:url(javascript:alert(1))">hi</p>');
    expect(out).not.toMatch(/style\s*=/i);
    expect(hasJsUrl(out)).toBe(false);
  });

  it("neutralizes javascript: hrefs", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(hasJsUrl(out)).toBe(false);
  });

  it("neutralizes entity-encoded scheme bypass (java&#x09;script:)", () => {
    const out = sanitizeEmailHtml('<a href="java&#x09;script:alert(1)">x</a>');
    expect(hasJsUrl(out)).toBe(false);
  });

  it("strips <svg> (can carry script via foreignObject)", () => {
    const out = sanitizeEmailHtml('<svg><foreignObject><script>alert(1)</script></foreignObject></svg>ok');
    expect(hasScript(out)).toBe(false);
    expect(out).not.toMatch(/<svg/i);
  });

  it("drops form controls", () => {
    const out = sanitizeEmailHtml('<form><input name="x"><button>go</button></form>text');
    expect(out).not.toMatch(/<form|<input|<button/i);
    expect(out).toContain("text");
  });

  it("resists a mutation-XSS style nesting trick", () => {
    // A classic mXSS payload — must not yield an executable <script>/handler.
    const out = sanitizeEmailHtml('<div><style><style/><img src=x onerror=alert(1)>');
    expect(hasScript(out)).toBe(false);
    expect(hasOnHandler(out)).toBe(false);
    expect(hasJsUrl(out)).toBe(false);
  });
});

describe("sanitizeEmailHtml — keeps safe email content", () => {
  it("preserves basic formatting + links + images", () => {
    const out = sanitizeEmailHtml('<p>Hello <strong>Alex</strong> <a href="https://ppp.com">link</a> <img src="https://ppp.com/a.png"></p>');
    expect(out).toContain("Hello");
    expect(out).toMatch(/<strong>/i);
    expect(out).toMatch(/href="https:\/\/ppp\.com"/i);
    expect(out).toMatch(/<img/i);
  });

  it("forces links to open safely (target=_blank rel=noopener)", () => {
    const out = sanitizeEmailHtml('<a href="https://ppp.com">x</a>');
    expect(out).toMatch(/rel="noopener noreferrer"/i);
    expect(out).toMatch(/target="_blank"/i);
  });

  it("returns empty string for falsy input", () => {
    expect(sanitizeEmailHtml("")).toBe("");
    expect(sanitizeEmailHtml(null)).toBe("");
    expect(sanitizeEmailHtml(undefined)).toBe("");
  });

  it("converges — re-sanitizing is stable (safe attr reordering aside)", () => {
    // DOMPurify may reorder attributes (e.g. the target/rel we add) on the first
    // re-parse, so strict once===twice doesn't hold — but it must stabilize.
    const a = sanitizeEmailHtml('<p onclick="x">hi <a href="https://ppp.com">l</a></p>');
    const b = sanitizeEmailHtml(a);
    const c = sanitizeEmailHtml(b);
    expect(c).toBe(b);
    expect(hasOnHandler(b)).toBe(false);
  });
});

describe("htmlToPlainText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToPlainText("<p>Hi &amp; bye</p>")).toBe("Hi & bye");
  });
  it("drops script/style content", () => {
    expect(htmlToPlainText("<style>x{}</style><p>keep</p><script>y()</script>")).toBe("keep");
  });
  it("converts breaks to newlines", () => {
    expect(htmlToPlainText("a<br>b")).toBe("a\nb");
  });
  it("returns empty for falsy", () => {
    expect(htmlToPlainText(null)).toBe("");
  });
});
