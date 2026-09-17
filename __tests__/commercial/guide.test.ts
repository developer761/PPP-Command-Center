import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ROLES, LOOKUP, JOURNEY } from "@/lib/commercial/guide/roles";
import { walkthroughRoutes } from "@/lib/commercial/guide/walkthrough";

/**
 * The handbook cannot be allowed to go stale.
 *
 * A printed process document fails the same way every time: a page gets
 * renamed, the document keeps naming the old one, and nobody notices for
 * months because nothing checks. The whole reason this one is generated from
 * `roles.ts` is so that something CAN check — which is only true if these
 * tests actually run against the app's routes rather than against the
 * handbook's own copy of them.
 *
 * So: every route in the handbook must exist on disk as a real page.
 */

/**
 * `/commercial/accounting?view=purchases` → `app/commercial/accounting/page.tsx`
 *
 * Job-scoped surfaces carry a `:job` / `:wonjob` placeholder, filled at render
 * time with a real job id (see sample-job.ts). On disk that is the dynamic
 * segment, so the placeholder maps to `[id]`.
 */
function pageFileFor(route: string): string {
  const path = route
    .split("?")[0]
    .replace(/^\//, "")
    .replace(/:wonjob|:job\b/, "[id]");
  return join(process.cwd(), "app", path, "page.tsx");
}

describe("every page the handbook sends you to exists", () => {
  for (const route of walkthroughRoutes(ROLES)) {
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
    ...ROLES.flatMap((r) => [
      r.label,
      r.tagline,
      r.intro,
      ...r.chapters.flatMap((c) => [
        c.title,
        c.blurb,
        ...c.surfaces.flatMap((su) => [
          su.name,
          su.path,
          su.purpose,
          su.watchOut ?? "",
          ...(su.steps ?? []),
          ...(su.controls ?? []).flatMap((ct) => [ct.label, ct.does]),
          ...(su.strip?.boxes ?? []),
        ]),
      ]),
    ]),
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

describe("the walkthrough is worth reading", () => {
  const named = ROLES.filter((r) => r.key !== "overview");

  it("gives each person their own walkthrough", () => {
    // Karan asked to be able to "go as Brendan / Stephanie / Mary", plus an
    // overview that covers everything at less depth.
    expect(ROLES.map((r) => r.key)).toEqual(["overview", "mary", "brendan", "stephanie"]);
    for (const r of named) {
      expect(r.chapters.length, `${r.label} has no chapters`).toBeGreaterThan(0);
    }
  });

  it("tells each person what the buttons do, not just where to go", () => {
    // The whole point over a list of links: a named role must explain controls
    // somewhere, or it is a tour rather than a walkthrough.
    for (const r of named) {
      const withControls = r.chapters.flatMap((c) => c.surfaces).filter((su) => (su.controls?.length ?? 0) > 0);
      expect(withControls.length, `${r.label} never says what a single control does`).toBeGreaterThan(0);
    }
  });

  it("every surface is step by step", () => {
    /**
     * Karan 2026-09-17: "make it simpler and literally step by step for all of
     * them." Nineteen surfaces had no steps at all — they said what the page
     * was for and left you to work out the clicks. A scripted bulk edit claimed
     * to have written them and silently skipped those nineteen, which is why
     * this counts rather than trusts.
     */
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          expect(su.steps?.length ?? 0, `${su.name} has no steps`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("a surface's steps belong to that surface", () => {
    /**
     * A bulk edit put the Settings steps — "Click Settings in the left menu" —
     * on the Receivables card, under the Receivables heading, with the
     * Receivables tab strip above them. Everything compiled, every page
     * rendered, every route resolved, and the only way it surfaced was reading
     * the printed page. This is the cheap version of reading it.
     *
     * The rule: a surface reached through a top-level area has to mention that
     * area, or say "Open the job"/"Open the tab" — anything else means the
     * steps came from somewhere else.
     */
    const AREAS = ["Accounting", "Opportunities", "Field Ops", "Reports", "Settings", "Email", "Dashboard"];
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          const area = AREAS.find((a) => su.path.startsWith(a));
          if (!area) continue;
          const all = (su.steps ?? []).join(" ");
          const startsInsideAJob = /^(Open|This is|Read)/.test(su.steps?.[0] ?? "");
          expect(
            all.includes(area) || startsInsideAJob,
            `${su.name} (${su.path}) has steps that never mention ${area}: "${su.steps?.[0]}"`
          ).toBe(true);
        }
      }
    }
  });

  it("no two surfaces share the same steps", () => {
    // Identical steps on two cards is the symptom of a misplaced copy, which
    // is exactly how the Receivables card ended up telling people to open
    // Settings.
    const seen = new Map<string, string>();
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          const key = (su.steps ?? []).join("|");
          if (!key) continue;
          const already = seen.get(key);
          expect(already, `${su.name} has the same steps as ${already}`).toBeUndefined();
          seen.set(key, `${r.label}/${su.name}`);
        }
      }
    }
  });

  it("a step is one instruction, not a paragraph", () => {
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          for (const st of su.steps ?? []) {
            // Simple means short. A step that runs past this is two steps.
            expect(st.length, `${su.name}: "${st.slice(0, 40)}…" is too long for one step`).toBeLessThan(150);
            expect(st.trim().endsWith("."), `${su.name}: "${st}" should end in a full stop`).toBe(true);
          }
        }
      }
    }
  });

  it("every surface says where it is and what it is for", () => {
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          expect(su.path.length, `${su.name} does not say where it is`).toBeGreaterThan(0);
          expect(su.purpose.length, `${su.name} does not say what it is for`).toBeGreaterThan(20);
          expect(su.href.startsWith("/commercial"), `${su.name} links outside the platform`).toBe(true);
        }
      }
    }
  });

  it("a chapter id is unique, so the contents links land where they say", () => {
    for (const r of ROLES) {
      const ids = r.chapters.map((c) => c.id);
      expect(new Set(ids).size, `${r.label} has two chapters with the same id`).toBe(ids.length);
    }
  });

  it("a tab strip highlights a tab that exists on it", () => {
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          if (!su.strip) continue;
          expect(su.strip.at, `${su.name}: the highlight is off the end of the row`).toBeLessThan(
            su.strip.boxes.length
          );
          expect(su.strip.at).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("no control is listed twice on one surface", () => {
    for (const r of ROLES) {
      for (const c of r.chapters) {
        for (const su of c.surfaces) {
          const labels = (su.controls ?? []).map((ct) => ct.label);
          expect(new Set(labels).size, `${su.name} lists a control twice`).toBe(labels.length);
        }
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
