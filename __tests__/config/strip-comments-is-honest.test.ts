import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * THE STRIPPER ITSELF HAD NO TEST.
 *
 * `stripComments` exists so a source-grep cannot pass on prose. Every test in
 * this suite that reads a file and greps it is built on top of it, which makes
 * it the single most load-bearing function in `__tests__/` — and until today
 * nothing asserted that it removed the right characters, or only those.
 *
 * It did not. Twice:
 *
 *   1. Its JSX rule ate 35% of components/dashboard-view.tsx (recorded in the
 *      helper's own docblock, found 2026-10-16 by mutation-testing).
 *
 *   2. Its trailing-comment rule deleted the remainder of every line holding
 *      two adjacent slashes — `"https://…"`, `` `https://…` ``, `/^https?:\/\//`.
 *      So a test asserting an email link is ABSOLUTE was grepping source with
 *      every `https://` truncated to `https:`. Found the same day, by routing
 *      119 more test files through the helper and watching which went red.
 *
 * Both bugs removed CODE and left the suite green, which is the failure mode
 * the helper was written to prevent, committed by the helper.
 *
 * So: this file pins both directions. Real comments must go; nothing that is
 * not a comment may be touched. The cases below are not hypothetical — each
 * one is a line shape that exists in this repo's source today.
 */

describe("stripComments removes comments", () => {
  const gone = (src: string) => stripComments(src);

  it("a whole-line comment", () => {
    expect(gone("// the reason\nkeep();")).not.toContain("the reason");
    expect(gone("// the reason\nkeep();")).toContain("keep();");
  });

  it("a trailing comment", () => {
    expect(gone('const a = 1; // because Katie asked')).not.toContain("Katie");
    expect(gone('const a = 1; // because Katie asked')).toContain("const a = 1;");
  });

  it("a block comment and a docblock", () => {
    expect(gone("/* inline */ keep();")).not.toContain("inline");
    expect(gone("/**\n * Stephanie 2026-09-11 said so.\n */\nkeep();")).not.toContain("Stephanie");
  });

  it("a JSX comment", () => {
    const src = "<div>{/* TODO: ask Brendan */}<Real /></div>";
    expect(gone(src)).not.toContain("Brendan");
    expect(gone(src)).toContain("<Real />");
  });

  it("a docblock that names the very thing a test greps for", () => {
    // The original burn: a comment explaining WHY a function is exempt from
    // `assertProposalDraft` made `toContain("assertProposalDraft")` pass on a
    // file that had stopped calling it.
    const src = "/** Exempt from assertProposalDraft because … */\nexport function f() {}";
    expect(gone(src)).not.toContain("assertProposalDraft");
  });
});

describe("stripComments removes NOTHING else", () => {
  /**
   * Each of these is a real shape from this codebase. The second column is a
   * substring that MUST survive — the old regex stripper destroyed every one.
   */
  const KEEP: Array<[label: string, src: string, survives: string]> = [
    ["a URL string literal", 'const U = "https://hub.precisionpaintingplus.net";', "https://hub.precisionpaintingplus.net"],
    ["a URL in a template literal", "const t = `${base}https://x.y/z`;", "https://x.y/z"],
    ["a protocol regex", 'if (/^https?:\\/\\//.test(configured)) return configured;', "return configured;"],
    ["a regex ending in an escaped slash", "const re = /\\/$/;\nkeep();", "keep();"],
    ["two slashes inside a plain string", 'const s = "a // b"; keep();', "a // b"],
    ["a mailto/href with a protocol", '<a href="https://tomcopainting.com/pay">Pay</a>', "https://tomcopainting.com/pay"],
    ["a division that looks like nothing", "const r = a / b / c; keep();", "a / b / c"],
    ["an apostrophe in JSX text", "<p>Mary's invoice</p>", "Mary's invoice"],
    ["a string holding a block-comment opener", 'const s = "/* not a comment */"; keep();', "keep();"],
  ];

  for (const [label, src, survives] of KEEP) {
    it(label, () => {
      expect(stripComments(src)).toContain(survives);
    });
  }

  it("never returns more than it was given", () => {
    const src = 'const a = 1; /* note */ const b = 2;\n// tail\nconst c = 3;';
    const out = stripComments(src);
    expect(out.length).toBeLessThanOrEqual(src.length);
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(out).toContain("const c = 3;");
  });

  it("preserves line structure", () => {
    // Load-bearing, not cosmetic: a dozen tests here anchor with `/m` —
    // `/^[ \t]*await sendEmail/m` is the live example — and those mean
    // nothing if removing a docblock joins two lines together.
    const src = "a();\n// gone\nb();\n/* also\n   gone */\nc();";
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });

  it("keeps a slice window full of CODE, not of deleted docblock", () => {
    // The other half of the contract, and the reason comments are removed
    // rather than blanked to spaces. Several tests read a fixed window after
    // a landmark — `src.slice(i, i + 400)` — to ask "what does the code do
    // next?". Pad that window with the whitespace of an excised 40-line
    // docblock and it reaches nothing, so the assertion inside it stops
    // being able to fail.
    const src = `marker();\n${"/** padding padding padding */\n".repeat(20)}target();`;
    const window = stripComments(src).slice(0, 60);
    expect(window).toContain("target()");
  });
});

describe("stripComments on this repo's real files", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  /**
   * The regression test for bug #1, kept as a measurement rather than a
   * sample: the old stripper removed 35% of this file. A stripper that is
   * removing a third of a source file is not stripping comments.
   */
  it("removes a plausible fraction of a big component, not a third of it", () => {
    const src = read("components/dashboard-view.tsx");
    const pct = ((src.length - stripComments(src).length) / src.length) * 100;
    expect(pct, `removed ${pct.toFixed(1)}% of dashboard-view.tsx`).toBeLessThan(25);
  });

  it("leaves the component's exported entry point intact", () => {
    // The specific casualty of bug #1.
    expect(stripComments(read("components/dashboard-view.tsx"))).toContain(
      "export default function DashboardView"
    );
  });

  it("leaves every https:// in a file full of them intact", () => {
    // The specific casualty of bug #2.
    const src = read("lib/notifications/commercial-events.ts");
    const urls = (src.match(/https:\/\//g) ?? []).length;
    expect(urls, "pick a file that actually has URLs in it").toBeGreaterThan(0);
    expect((stripComments(src).match(/https:\/\//g) ?? []).length).toBe(urls);
  });

  it("keeps every line of every file it is given", () => {
    for (const p of [
      "lib/commercial/aia/db.ts",
      "lib/commercial/invoices/email.ts",
      "components/customer-form-view.tsx",
      "app/commercial/invoices/[id]/page.tsx",
    ]) {
      const src = read(p);
      expect(stripComments(src).split("\n").length, p).toBe(src.split("\n").length);
    }
  });

  it("leaves every export of every file it is given", () => {
    // The blunt version of the dashboard-view check, across a spread of real
    // files: whatever a stripper does to comments, it may not remove a
    // declaration. Bug #1 removed `export default function DashboardView`.
    for (const p of [
      "lib/commercial/aia/db.ts",
      "lib/commercial/invoices/email.ts",
      "lib/notifications/commercial-events.ts",
      "components/customer-form-view.tsx",
      "components/dashboard-view.tsx",
      "app/commercial/invoices/[id]/page.tsx",
    ]) {
      const src = read(p);
      const out = stripComments(src);
      const exports = [...src.matchAll(/^export (?:default )?(?:async )?(?:function|const|class) (\w+)/gm)];
      expect(exports.length, `${p} has no exports to check`).toBeGreaterThan(0);
      for (const m of exports) expect(out, `${p} lost ${m[1]}`).toContain(m[0]);
    }
  });
});
