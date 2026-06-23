import { describe, it, expect } from "vitest";
import {
  sanitizeEmailHtml,
  htmlToPlainText,
} from "@/lib/commercial/email-archive/sanitize";

/**
 * Tests for lib/commercial/email-archive/sanitize.ts — HTML stripper
 * for archived email bodies.
 *
 * Why this matters: Stage 2 recheck caught a CRITICAL bypass via
 * entity-encoded URL schemes (`href="java&#x09;script:..."`). These
 * tests lock in every known bypass + the audit-flagged regressions
 * (inline `style=` carrying `expression()`, `<svg onload>` attribute
 * tricks, etc).
 *
 * NOTE: This is a focused sanitizer, NOT a full DOMPurify. Some
 * mutation-XSS cases are knowingly out of scope (acknowledged in
 * the file's own block comment). These tests verify the
 * dangerous-tags + on-* attributes + dangerous-protocol cases that
 * matter for the actual attack surface (internal team rendering an
 * archived email from a hostile GC).
 */

describe("sanitizeEmailHtml — script + iframe + style stripping", () => {
  it("strips <script> tag + contents", () => {
    expect(sanitizeEmailHtml("<p>Hi</p><script>alert(1)</script><p>Bye</p>")).toBe(
      "<p>Hi</p><p>Bye</p>"
    );
  });

  it("strips <iframe> tag", () => {
    expect(
      sanitizeEmailHtml('<iframe src="http://evil.com"></iframe>OK')
    ).toBe("OK");
  });

  it("strips <style> tag + contents", () => {
    expect(sanitizeEmailHtml("<style>body{background:red}</style>OK")).toBe(
      "OK"
    );
  });

  it("strips inline style= attribute", () => {
    expect(
      sanitizeEmailHtml('<div style="background:url(javascript:alert(1))">x</div>')
    ).toBe("<div>x</div>");
  });

  it("strips <form> and friends", () => {
    expect(sanitizeEmailHtml("<form><input/><button>OK</button></form>")).toBe("");
  });

  it("strips <object> + <embed>", () => {
    expect(
      sanitizeEmailHtml('<object data="x.swf"></object><embed src="y.swf"/>')
    ).toBe("");
  });

  it("strips <link> + <meta>", () => {
    expect(
      sanitizeEmailHtml('<link rel="stylesheet" href="x.css"><meta charset="utf-8">OK')
    ).toBe("OK");
  });

  it("self-closing forms also stripped", () => {
    expect(sanitizeEmailHtml('<input type="text"/>OK')).toBe("OK");
  });
});

describe("sanitizeEmailHtml — on-* attribute strip", () => {
  it("strips onclick handler", () => {
    expect(
      sanitizeEmailHtml('<a href="https://safe.com" onclick="alert(1)">link</a>')
    ).toMatch(/^<a href="https:\/\/safe\.com">link<\/a>$/);
  });

  it("strips onload handler (lowercase)", () => {
    expect(sanitizeEmailHtml('<img src="x.png" onload="alert(1)">')).toMatch(
      /<img src="x\.png">/
    );
  });

  it("strips ONERROR handler (case-insensitive)", () => {
    expect(sanitizeEmailHtml('<img src="x.png" ONERROR="alert(1)">')).not.toMatch(
      /onerror/i
    );
  });

  it("strips onmouseover handler", () => {
    expect(
      sanitizeEmailHtml('<span onmouseover="alert(1)">hover</span>')
    ).not.toMatch(/onmouseover/);
  });
});

describe("sanitizeEmailHtml — dangerous URL protocol neutralization", () => {
  it("neutralizes plain javascript: href", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).toContain('href="#"');
    expect(out).not.toContain("javascript:");
  });

  it("neutralizes entity-encoded javascript: href (the audit bypass)", () => {
    // The CRITICAL Stage 2 audit fix: href="java&#x09;script:alert(1)"
    // — browsers decode the entity + strip whitespace before resolving
    // the scheme. Pre-fix regex missed it. Post-fix normalizeUrlAttr
    // entity-decodes before testing.
    const out = sanitizeEmailHtml('<a href="java&#x09;script:alert(1)">x</a>');
    expect(out).toContain('href="#"');
  });

  it("neutralizes vbscript: href", () => {
    expect(
      sanitizeEmailHtml('<a href="vbscript:msgbox(1)">x</a>')
    ).toContain('href="#"');
  });

  it("neutralizes data: href", () => {
    expect(
      sanitizeEmailHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    ).toContain('href="#"');
  });

  it("preserves safe https: href", () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it("preserves safe http: href", () => {
    const out = sanitizeEmailHtml('<a href="http://example.com">x</a>');
    expect(out).toContain('href="http://example.com"');
  });

  it("preserves mailto: href", () => {
    const out = sanitizeEmailHtml('<a href="mailto:a@b.com">x</a>');
    expect(out).toContain('href="mailto:a@b.com"');
  });
});

describe("sanitizeEmailHtml — srcset + target stripping", () => {
  it("strips srcset (tracker-pixel vector)", () => {
    expect(
      sanitizeEmailHtml('<img src="x.png" srcset="x.png 1x, y.png 2x">')
    ).not.toMatch(/srcset/);
  });

  it("strips target=_blank (reverse-tabnabbing defense)", () => {
    expect(
      sanitizeEmailHtml('<a href="https://x.com" target="_blank">x</a>')
    ).not.toMatch(/target/);
  });
});

describe("sanitizeEmailHtml — safe content preservation", () => {
  it("keeps <p>, <strong>, <em>, <br>", () => {
    const out = sanitizeEmailHtml(
      "<p>Hello <strong>bold</strong> <em>italic</em><br/>line2</p>"
    );
    expect(out).toContain("<p>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
    expect(out).toContain("<br/>");
  });

  it("keeps <table> markup", () => {
    const out = sanitizeEmailHtml(
      "<table><tr><td>cell</td></tr></table>"
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<td>");
  });

  it("keeps <img> with safe src", () => {
    const out = sanitizeEmailHtml('<img src="https://safe.com/x.png" alt="x">');
    expect(out).toContain('src="https://safe.com/x.png"');
  });

  it("empty input returns empty string", () => {
    expect(sanitizeEmailHtml("")).toBe("");
    expect(sanitizeEmailHtml(null)).toBe("");
    expect(sanitizeEmailHtml(undefined)).toBe("");
  });
});

describe("htmlToPlainText — fallback text extraction", () => {
  it("strips all HTML tags", () => {
    expect(htmlToPlainText("<p>Hi <strong>there</strong>!</p>")).toBe("Hi there!");
  });

  it("converts <br> and </p> to newlines", () => {
    const out = htmlToPlainText("<p>Line1</p><p>Line2</p>");
    expect(out).toBe("Line1\nLine2");
  });

  it("strips <script> content entirely", () => {
    expect(htmlToPlainText("Hi<script>alert(1)</script>Bye")).toBe("HiBye");
  });

  it("decodes &amp; &lt; &gt; &quot; entities", () => {
    expect(htmlToPlainText("a &amp; b &lt; c &gt; d &quot;e&quot;")).toBe(
      'a & b < c > d "e"'
    );
  });

  it("collapses runs of whitespace", () => {
    expect(htmlToPlainText("a   b\t\t\tc")).toBe("a b c");
  });

  it("empty input returns empty string", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText(null)).toBe("");
  });
});
