import { describe, it, expect } from "vitest";

/**
 * A section of the handbook never OPENS at the foot of a page.
 *
 * Katie, 2026-09-17: "Labor Payments in Mary's section begins with a few lines
 * at the bottom of the 7th page and then spills over to the 8th. It would be
 * best if the beginning of a section happens at the beginning of a new page or
 * in the middle of one (if it would create too much dead space in the doc)."
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW. The first fix was
 * `minPresenceAhead={130}` on the section block. It reads exactly like the fix
 * for this, it type-checks, and it changed nothing: rendering page 7 showed
 * Labor payments still opening four lines from the bottom. The fix that works
 * is structural — heading, path, tab strip, purpose and the first three steps
 * are one `wrap={false}` unit in lib/commercial/guide/pdf.tsx. Neither version
 * is distinguishable by reading the source, so this reads the BYTES.
 *
 * THE RULE, stated so it can fail: a section's heading and its THIRD step land
 * on the same page. Proven able to fail — run against the pre-fix render and it
 * reports four splits, including the one Katie reported:
 *
 *   FAIL  Mary › Labor payments: heading on page 7, step 3 on page 8
 *   FAIL  Mary › Job costs: heading on page 10, step 3 on page 11
 *   FAIL  Mary › Balance owed: heading on page 11, step 3 on page 12
 *   FAIL  Stephanie › AIA Billing: heading on page 22, step 3 on page 23
 *
 * `scripts/check-guide-pagination.mjs` is the same rule against a PDF on disk,
 * for when you want to check a file somebody sent you.
 */

/** Text of one page, runs concatenated. react-pdf writes glyphs as hex. */
function pageText(page: { node: { Contents: () => unknown } }, zlib: typeof import("zlib")): string {
  const contents = page.node.Contents() as { contents?: Uint8Array; asUint8Array?: () => Uint8Array };
  const raw = contents.contents ?? contents.asUint8Array?.();
  let s: string;
  try {
    s = zlib.inflateSync(Buffer.from(raw as Uint8Array)).toString("latin1");
  } catch {
    s = Buffer.from(raw as Uint8Array).toString("latin1");
  }
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const hex = m[1].replace(/\s+/g, "");
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

const norm = (s: unknown) =>
  String(s ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("the handbook's page breaks", () => {
  it("never starts a section at the foot of a page", async () => {
    const zlib = await import("node:zlib");
    const { PDFDocument } = await import("pdf-lib");
    const { renderGuidePdf } = await import("@/lib/commercial/guide/pdf");
    const { ROLES } = await import("@/lib/commercial/guide/roles");

    const bytes = await renderGuidePdf({ company: "Tomco Painting", logo: null });
    const doc = await PDFDocument.load(new Uint8Array(bytes));
    const pages = doc.getPages().map((p) => pageText(p as never, zlib as never));

    expect(pages.length).toBeGreaterThan(20);

    let checked = 0;
    const split: string[] = [];

    for (const role of ROLES) {
      for (const chapter of role.chapters ?? []) {
        for (const surface of chapter.surfaces ?? []) {
          const steps = surface.steps ?? [];
          if (steps.length < 3) continue;

          // Heading-with-path and the opening of the purpose are matched
          // SEPARATELY, not concatenated. Two traps, both of which made an
          // earlier version of this measure almost nothing and pass:
          //   · the name alone appears in sibling pages' tab strips;
          //   · name+path is not unique — Brendan and the Overview both have an
          //     "Opportunities" at the same path with different steps;
          //   · a surface with a tab strip prints the whole strip BETWEEN its
          //     path and its purpose, so the two never sit adjacent.
          const heading = norm(surface.name) + norm(surface.path);
          const purposeHead = norm(surface.purpose).slice(0, 40);
          const third = norm(steps[2]);
          if (!heading || !purposeHead || !third) continue;

          const headPage = pages.findIndex((t) => {
            const n = norm(t);
            return n.includes(heading) && n.includes(purposeHead);
          });
          // The Overview role is deliberately not in the printed book — it is
          // the on-screen walkthrough only. Anything else missing is a defect.
          if (headPage === -1) continue;

          checked++;
          const thirdPage = pages.findIndex((t, i) => i >= headPage && norm(t).includes(third));
          if (thirdPage !== headPage) {
            split.push(
              `${role.label} › ${surface.name}: heading on page ${headPage + 1}, step 3 on page ${
                thirdPage === -1 ? "NOWHERE" : thirdPage + 1
              }`
            );
          }
        }
      }
    }

    // Without this, a rename in roles.ts turns the whole test into a green
    // no-op — which is how the first version of it passed.
    expect(checked).toBeGreaterThanOrEqual(25);
    expect(split).toEqual([]);
  }, 60000);
});
