import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing you tap on a phone may be smaller than 44px.
 *
 * Alex opens this on his phone every morning, and 44px is the floor the
 * platform already committed to — most controls carry `min-h-[44px]`. Six had
 * slipped through with an explicit small height and no mobile override:
 * docs/OPEN_BACKLOG logged four of them ("inline-field pencil, stage-KPI parent
 * links, saved-view chip remove-X, activity Add task"); this found two more.
 *
 * The fix pattern is the platform's own: full target on mobile, tighter rhythm
 * from `sm:` up — `h-11 sm:h-8` — because a 44px icon button in a dense desktop
 * toolbar looks broken, and a 32px one on a phone IS broken.
 *
 * A tap target cannot be checked by rendering, and nobody re-measures by hand.
 */

const ROOTS = ["app/commercial", "components/commercial"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `h-8` → 32. Tailwind's scale is 4px per unit. */
function pxOf(token: string): number | null {
  const m = /^h-(\d+)$/.exec(token);
  return m ? Number(m[1]) * 4 : null;
}

describe("commercial tap targets", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("no interactive element sets a sub-44px height without a mobile override", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // [^] rather than the /s flag — tsconfig targets below es2018.
      for (const m of src.matchAll(/<(button|a|Link|summary)\b[^>]{0,900}?className="([^"]{0,900})"/g)) {
        const cls = m[2];
        if (cls.includes("min-h-[44px]")) continue;
        // The base (unprefixed) height is what a phone gets.
        const base = cls.split(/\s+/).filter((t) => /^h-\d+$/.test(t));
        for (const t of base) {
          const px = pxOf(t);
          if (px !== null && px < 44) {
            const line = src.slice(0, m.index!).split("\n").length;
            offenders.push(
              `${file}:${line} — <${m[1]}> is ${px}px on a phone (${t}). ` +
                `Use h-11 with an sm: override, or add min-h-[44px].`
            );
          }
        }
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
  });

  it("is actually scanning the platform", () => {
    // A regex that stopped matching would pass the check above in silence.
    const total = files.reduce(
      (n, f) => n + [...readFileSync(f, "utf8").matchAll(/<(button|Link|summary)\b/g)].length,
      0
    );
    expect(total, "found no interactive elements — the scan is inspecting nothing").toBeGreaterThan(200);
  });
});
