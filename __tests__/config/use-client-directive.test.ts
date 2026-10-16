import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * "use client" must be the first statement in the file.
 *
 * This shipped broken on 2026-08-31. A script added an import to four client
 * components by prepending it to the file, which pushed the directive to line
 * two. Next refuses to compile that:
 *
 *   The "use client" directive must be placed before other expressions.
 *
 * tsc does not know the rule. The 1789 unit tests are pure logic and never
 * render. So it passed every gate and reached main, where `next build` would
 * have failed and the deploy simply would not have shipped.
 *
 * A compile-time rule that no compiler in the verification path enforces needs
 * a test, or it is enforced only by whoever happens to load a page next.
 */
const ROOTS = ["app", "components"];

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip leading comments and blank lines — those are legal above a directive. */
function firstStatement(src: string): string {
  let s = src.replace(/^﻿/, "");
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith("//")) { s = t.slice(t.indexOf("\n") + 1); continue; }
    if (t.startsWith("/*")) { s = t.slice(t.indexOf("*/") + 2); continue; }
    return t;
  }
}

describe('"use client" placement', () => {
  const files = ROOTS.flatMap((r) => tsxFiles(r));

  it("scans a meaningful number of files", () => {
    // A zero-file scan would report a perfect pass forever.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has the directive as the first statement wherever it appears", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Strip comments BEFORE asking whether the file has the directive.
      // Raw source said yes to any file that merely MENTIONS "use client"
      // in prose: on 2026-10-16 a docblock in app/dashboard/page.tsx
      // explaining why the snapshot must not be handed to a "use client"
      // component turned this green check red, on a file that correctly has
      // no directive at all. Sixth time a test in this suite has read a
      // comment as code — see __tests__/helpers/strip-comments.ts.
      if (!/["']use client["']/.test(stripComments(src))) continue;
      if (!/^["']use client["']/.test(firstStatement(src))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("detects a directive pushed below an import", () => {
    // Proves the check can FAIL — the exact shape that shipped.
    const bad = 'import x from "y";\n"use client";\n';
    expect(/^["']use client["']/.test(firstStatement(bad))).toBe(false);
    const good = '"use client";\n\nimport x from "y";\n';
    expect(/^["']use client["']/.test(firstStatement(good))).toBe(true);
  });

  it("does not treat a file that only MENTIONS the directive as having one", () => {
    // The 2026-10-16 false positive, pinned. A server component whose
    // docblock discusses "use client" has no directive and must be skipped,
    // not reported as a misplaced one.
    const prose = '/** Passing this to a "use client" component is the bug. */\nexport default function P() {}\n';
    expect(/["']use client["']/.test(prose)).toBe(true);
    expect(/["']use client["']/.test(stripComments(prose))).toBe(false);
  });
});
