import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A component nothing imports is a component nobody maintains.
 *
 * This has now happened three times, always the same way: a surface is
 * retired, its page is deleted or turned into a redirect, and the components it
 * alone used are left behind. commercial-kanban-dnd (417 lines) survived the
 * Kanban retirement; the opportunities sort picker survived its toolbar;
 * post-job-tool-index (205 lines) survived the Post-Job redirects — and I
 * wrote those redirects, so I stranded it myself and did not notice until a
 * scan two days later.
 *
 * Dead code is not merely untidy here. It reads as live: the next person greps,
 * finds a component that looks like the thing they need, and edits a file that
 * renders nowhere.
 *
 * KEPT DELIBERATELY are listed below with the reason. The list may only
 * SHRINK — a stale entry means someone deleted one and left the exemption
 * behind, which quietly re-opens the door.
 */

const KEPT: Record<string, string> = {
  "components/commercial/account-hover-card.tsx":
    "Built 2026-07-11 as a Tier-2 signature moment (hover an account name → stats popover) and never wired to a single name. /api/commercial/account-summary exists solely to feed it. Karan's call whether to wire or delete — not dead by accident.",
  "components/commercial/banner.tsx":
    "The canonical Banner primitive. Its last consumers were deliberately deleted (5362601a); kept so the next banner is not ad-hoc again.",
  "components/commercial/ui.tsx":
    "RUX-0 shared primitives, a documented future-phase foundation. Deleting them would contradict a locked convention.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every module path imported anywhere in the app. */
function importedPaths(): Set<string> {
  const out = new Set<string>();
  const re = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g;
  for (const dir of ["app", "components", "lib", "__tests__"]) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(re)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith("@/")) out.add(spec.slice(2));
        else if (spec.startsWith(".")) {
          const abs = join(file, "..", spec).replace(/\\/g, "/");
          out.add(abs.replace(/^\.\//, ""));
        }
      }
    }
  }
  return out;
}

describe("no component is stranded", () => {
  it("every component under components/ is imported by something", () => {
    const imported = importedPaths();
    const stranded = walk("components")
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => !imported.has(f.replace(/\.tsx?$/, "")));

    const unexpected = stranded.filter((f) => !(f in KEPT));
    expect(
      unexpected,
      `\nNothing imports these:\n${unexpected.join("\n")}\n\n` +
        `Delete them, or add an entry to KEPT saying why they stay.\n`
    ).toEqual([]);
  });

  it("the KEPT list only shrinks", () => {
    // A stale exemption is worse than none: it says "this was considered and
    // kept" about a file somebody already deleted.
    const imported = importedPaths();
    for (const f of Object.keys(KEPT)) {
      let exists = true;
      try {
        statSync(f);
      } catch {
        exists = false;
      }
      expect(exists, `${f} is exempted but no longer exists — remove the entry`).toBe(true);
      expect(
        imported.has(f.replace(/\.tsx?$/, "")),
        `${f} is imported now — it is no longer stranded, so remove the exemption`
      ).toBe(false);
    }
  });
});
