/**
 * Does a section of the handbook ever OPEN at the foot of a page?
 *
 * Katie, 2026-09-17: "Labor Payments in Mary's section begins with a few lines
 * at the bottom of the 7th page and then spills over to the 8th. It would be
 * best if the beginning of a section happens at the beginning of a new page or
 * in the middle of one."
 *
 * The first fix for this was `minPresenceAhead={130}` on the section block, and
 * it did nothing — Labor payments still opened four lines from the bottom. That
 * is the whole reason this file exists: the fix LOOKED right in the source and
 * was wrong in the artifact, and only rendering the document showed it. So the
 * check reads the PDF, not the JSX.
 *
 * THE RULE, stated so it can fail: a section's heading and its THIRD step must
 * land on the same page. That is exactly the promise the `wrap={false}` block in
 * lib/commercial/guide/pdf.tsx makes — heading, path, tab strip, purpose and the
 * first three steps are one unbreakable unit. If react-pdf ever stops honouring
 * it, or somebody moves a step out of the block, this goes red.
 *
 * Proven able to fail: run it against the pre-fix render and Labor payments is
 * reported split across pages 7 and 8.
 *
 *   node scripts/check-guide-pagination.mjs [path/to.pdf]
 */
import { PDFDocument, PDFRawStream } from "pdf-lib";
import { readFileSync, existsSync } from "node:fs";
import zlib from "node:zlib";

const target = process.argv[2];

/** Text of one page, in reading order, with the runs concatenated. */
function pageText(page) {
  const contents = page.node.Contents();
  const raw = contents instanceof PDFRawStream ? contents.contents : contents.asUint8Array?.();
  let s;
  try {
    s = zlib.inflateSync(Buffer.from(raw)).toString("latin1");
  } catch {
    s = Buffer.from(raw).toString("latin1");
  }
  // react-pdf writes glyphs as hex: `<4f4b> Tj` and `[<4f> -35 <4b>] TJ`.
  let out = "";
  const re = /<([0-9A-Fa-f\s]+)>/g;
  let m;
  while ((m = re.exec(s))) {
    const hex = m[1].replace(/\s+/g, "");
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

async function main() {
  let bytes;
  if (target && existsSync(target)) {
    bytes = readFileSync(target);
  } else {
    // Render it here rather than trusting a file somebody left on disk — the
    // stale-render trap cost an hour once already.
    const { renderGuidePdf } = await import("../lib/commercial/guide/pdf.tsx");
    const logoPath = new URL("../public/brand/tomco-logo.jpg", import.meta.url).pathname;
    bytes = await renderGuidePdf({
      company: "Tomco Painting",
      logo: existsSync(logoPath) ? readFileSync(logoPath) : null,
    });
  }

  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map(pageText);
  const { ROLES } = await import("../lib/commercial/guide/roles.ts");

  const norm = (s) => String(s ?? "").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();

  let checked = 0;
  const bad = [];
  const unanchored = [];

  for (const role of ROLES) {
    for (const chapter of role.chapters ?? []) {
      for (const surface of chapter.surfaces ?? []) {
        const steps = surface.steps ?? [];
        if (steps.length < 3) continue; // nothing to split
        // Anchor on heading-followed-by-path AND, separately, the opening of
        // the purpose line.
        //
        // Two traps here, both of which made an earlier version of this check
        // silently measure nothing. The name alone appears in the tab strips of
        // sibling pages. And name+path is not unique either: Brendan and the
        // Overview both carry an "Opportunities" surface at the same path with
        // different steps — the purpose is what tells them apart.
        //
        // The two are matched SEPARATELY rather than concatenated, because a
        // surface with a tab strip has the whole strip printed between its path
        // and its purpose. Concatenating them matched only the strip-less
        // surfaces, i.e. exactly half the book, and passed.
        const heading = norm(surface.name) + norm(surface.path);
        const purposeHead = norm(surface.purpose).slice(0, 40);
        const third = norm(steps[2]);
        if (!heading || !purposeHead || !third) continue;

        const titlePage = pages.findIndex((t) => {
          const n = norm(t);
          return n.includes(heading) && n.includes(purposeHead);
        });
        if (titlePage === -1) {
          unanchored.push(`${role.label} › ${surface.name}`);
          continue;
        }
        const thirdPage = pages.findIndex((t, i) => i >= titlePage && norm(t).includes(third));
        checked++;
        if (thirdPage === -1) {
          // Not a page break — the text never rendered at all, or the anchor
          // found the wrong section. Either way it is a defect in the check or
          // the document, and must not be reported as a pass.
          bad.push(`${role.label} › ${surface.name}: heading on page ${titlePage + 1}, step 3 NOT FOUND — "${third}"`);
        } else if (thirdPage !== titlePage) {
          bad.push(
            `${role.label} › ${surface.name}: heading on page ${titlePage + 1}, step 3 on page ${thirdPage + 1}`
          );
        }
      }
    }
  }

  console.log(`\n${pages.length}-page handbook · ${checked} section openings checked`);
  if (checked === 0) {
    console.log("❌ checked nothing — the extractor or the content shape changed");
    process.exitCode = 1;
    return;
  }
  if (unanchored.length) console.log(`  (${unanchored.length} not found in the PDF: ${unanchored.join(", ")})`);
  for (const b of bad) console.log(`  FAIL  ${b}`);
  console.log(
    bad.length === 0
      ? "✅ every section opens on one page — none begins at the foot of a page"
      : `\n❌ ${bad.length} section(s) open across a page break`
  );
  process.exitCode = bad.length === 0 ? 0 : 1;
}

await main();
