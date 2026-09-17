import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { SECTIONS, AREAS, LOOKUP, JOURNEY, guideRoutes } from "@/lib/commercial/guide/content";

/**
 * The handbook cannot be allowed to go stale.
 *
 * A printed process document fails the same way every time: a page gets
 * renamed, the document keeps naming the old one, and nobody notices for
 * months because nothing checks. The whole reason this one is generated from
 * `content.ts` is so that something CAN check — which is only true if these
 * tests actually run against the app's routes rather than against the
 * handbook's own copy of them.
 *
 * So: every route in the handbook must exist on disk as a real page.
 */

/** `/commercial/accounting?view=purchases` → `app/commercial/accounting/page.tsx` */
function pageFileFor(route: string): string {
  const path = route.split("?")[0].replace(/^\//, "");
  return join(process.cwd(), "app", path, "page.tsx");
}

describe("every page the handbook sends you to exists", () => {
  for (const route of guideRoutes()) {
    it(`${route} is a real page`, () => {
      expect(existsSync(pageFileFor(route)), `the handbook points at ${route}, which has no page.tsx`).toBe(true);
    });
  }
});

describe("the handbook only uses characters the PDF font can print", () => {
  /**
   * react-pdf's base-14 fonts are WinAnsi and do NOT warn on a missing glyph —
   * they print the nearest byte. The first draft shipped "Accounting → Labor
   * payments" and rendered "Accounting ' Labor payments". This is the check
   * that would have caught it before it was printed and handed to anybody.
   *
   * `→` is allowed in the source because the renderer maps it to `›`; the
   * arrow shapes are drawn as SVG and must never be typed.
   */
  const BANNED: [string, string][] = [
    ["▲", "▲ — draw it with <Triangle dir=\"up\">, it prints as a superscript 2"],
    ["▶", "▶ — draw it with <Triangle dir=\"right\">, it prints as a pilcrow"],
    ["①", "① — circled digits are not in WinAnsi, use the stepNum circle"],
    ["✓", "✓ — not in WinAnsi"],
    ["→→", "double arrow"],
  ];

  const allText = [
    ...SECTIONS.flatMap((s) => [
      s.title,
      s.who,
      s.intro,
      s.footnote ?? "",
      ...(s.table ? [...s.table.head, ...s.table.rows.flat()] : []),
      ...s.tasks.flatMap((t) => [
        t.title,
        t.path,
        t.watchOut ?? "",
        ...t.steps.map((st) => st.text),
        ...(t.sketch ? [t.sketch.arrowLabel, ...t.sketch.boxes] : []),
      ]),
    ]),
    ...AREAS.flatMap((a) => [a.name, a.holds, a.who]),
    ...JOURNEY.flatMap((j) => [j.label, j.sub]),
    ...LOOKUP.flatMap((l) => [l.question, l.answer]),
  ].join("\n");

  for (const [char, why] of BANNED) {
    it(`does not contain ${why}`, () => {
      expect(allText.includes(char)).toBe(false);
    });
  }

  it("uses no character the renderer would silently drop", () => {
    // Mirrors pdfSafe's allowed set. Anything else is either a wrong glyph on
    // the page or a hole in a sentence.
    const EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ→";
    const offenders = [...new Set([...allText].filter((c) => c > "ÿ" && !EXTRA.includes(c)))];
    expect(offenders, `these would not print: ${offenders.map((c) => JSON.stringify(c)).join(", ")}`).toEqual([]);
  });
});

describe("the handbook is worth printing", () => {
  it("covers Mary in her own right", () => {
    const marys = SECTIONS.filter((s) => s.who.toLowerCase().includes("mary"));
    // Karan asked for "a specific page or two for Mary and her accounting page".
    expect(marys.length).toBeGreaterThanOrEqual(2);
    expect(marys.some((s) => s.table), "one of Mary's pages should tour the tabs").toBe(true);
  });

  it("every task says where it happens and what to do", () => {
    for (const s of SECTIONS) {
      for (const t of s.tasks) {
        expect(t.steps.length, `${t.title} has no steps`).toBeGreaterThan(0);
        expect(t.path.length, `${t.title} does not say where it is`).toBeGreaterThan(0);
        // Numbered 1..n with no gaps — the PDF prints these in circles.
        expect(t.steps.map((st) => st.n)).toEqual(t.steps.map((_, i) => i + 1));
      }
    }
  });

  it("an arrow points at a box that exists", () => {
    for (const s of SECTIONS) {
      for (const t of s.tasks) {
        if (!t.sketch) continue;
        expect(t.sketch.arrowAt, `${t.title}: arrow points off the end of the row`).toBeLessThan(
          t.sketch.boxes.length
        );
        expect(t.sketch.arrowAt).toBeGreaterThanOrEqual(0);
        expect(t.sketch.arrowLabel.length, `${t.title}: arrow has no label`).toBeGreaterThan(0);
      }
    }
  });

  it("the lookup answers are paths a person can follow", () => {
    for (const l of LOOKUP) {
      expect(l.question.startsWith("…"), `"${l.question}" should continue "Where do I…"`).toBe(true);
      expect(l.answer.length).toBeGreaterThan(3);
    }
  });
});
