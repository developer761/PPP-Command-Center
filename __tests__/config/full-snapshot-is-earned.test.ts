/**
 * ASKING FOR THE FULL SNAPSHOT SHOULD COST YOU SOMETHING TO JUSTIFY.
 *
 * There are two sizes. Measured on production, 2026-10-15, reading from the
 * shared cache on a warm instance:
 *
 *   materials bundle   0.4MB   227–582ms
 *   thin snapshot      3.6MB   ~1.4s
 *   FULL snapshot      8.1MB   3227ms
 *
 * And on a cold instance the full one is a 22-second Salesforce rebuild.
 *
 * `/api/admin/reps` was calling for the full snapshot to map reps down to
 * { id, name } for a dropdown — 3.2 seconds for a list of names, on an
 * endpoint that fires on admin page loads. It had simply never been
 * revisited after the thin snapshot was introduced, which is the normal way
 * this goes: the thin variant arrives, the new code uses it, and the
 * existing callers keep paying.
 *
 * So: a caller may have the full snapshot, but only if it actually reads
 * something the thin one drops. The eight dropped fields are read out of
 * the builder rather than hardcoded, so this stays true if the list
 * changes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** What `thin` drops, read from the builder so it cannot drift. */
function thinDroppedFields(): string[] {
  const src = read("lib/salesforce/queries.ts");
  const out = new Set<string>();
  for (const m of src.matchAll(/const (\w+)Promise\s*:[^=]+=\s*thin\s*\?/g)) {
    out.add(m[1] === "opps" ? "opportunities" : m[1]);
  }
  return [...out];
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(rel, acc);
    } else if (/\.(ts|tsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

/** Files that ask for the FULL snapshot — no thin, no materials. */
function fullSnapshotCallers(): string[] {
  const files = [...walk("app"), ...walk("lib")].filter((f) => !f.includes("/data-source.ts"));
  const out: string[] = [];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const calls = [
      ...src.matchAll(/loadDashboardData\(([^)]*)\)/g),
      ...src.matchAll(/loadSalesforceSnapshot\(([^)]*)\)/g),
    ];
    for (const c of calls) {
      const args = c[1];
      if (/thin:\s*true|materials:\s*true/.test(args)) continue;
      out.push(f);
      break;
    }
  }
  return out;
}

describe("only callers that need the full snapshot ask for it", () => {
  const dropped = thinDroppedFields();
  const callers = fullSnapshotCallers();

  it("found the dropped-field list and some callers", () => {
    // An audit that scanned nothing passes for the wrong reason.
    expect(dropped.length, "no thin-dropped fields parsed").toBeGreaterThanOrEqual(8);
    expect(callers.length, "no full-snapshot callers found — parser broken?").toBeGreaterThan(0);
  });

  /**
   * The four that genuinely need it. Each reaches the dropped data through a
   * DERIVED helper rather than touching the field itself, so the direct scan
   * below cannot see the justification:
   *
   *   dashboard/page.tsx   Overview KPIs — opportunities + transactions
   *   financials/page.tsx  money screens — transactions
   *   rep/page.tsx         rep list revenue — opportunities
   *   rep/[id]/page.tsx    deriveRepScorecard — transactions, quotas, cases
   *
   * Anything NEW landing here is almost certainly a caller that should be
   * thin, so prove the helper first and then add it with the reason.
   */
  const NEEDS_FULL = new Set([
    "app/dashboard/page.tsx",
    "app/dashboard/financials/page.tsx",
    "app/dashboard/rep/page.tsx",
    "app/dashboard/rep/[id]/page.tsx",
  ]);

  it("the allowlist is not hiding a caller that has been switched", () => {
    // A list nobody prunes is where slow code goes to be forgotten.
    const stale = [...NEEDS_FULL].filter((f) => !callers.includes(f));
    expect(stale, `no longer loads the full snapshot — remove from NEEDS_FULL:\n${stale.join("\n")}`).toEqual([]);
  });

  it("every full-snapshot caller reads something thin does not carry", () => {
    const unjustified: string[] = [];
    for (const f of callers) {
      if (NEEDS_FULL.has(f)) continue;
      const src = read(f);
      const usesDropped = dropped.some((field) => new RegExp(`\\.${field}\\b`).test(src));
      if (!usesDropped) unjustified.push(f);
    }
    expect(
      unjustified,
      "These load the 8.1MB full snapshot (3.2s warm, 22s cold) but read no " +
        "field the thin one drops. Pass { thin: true } — or, if a helper they " +
        "call needs the full data, say so here:\n" +
        unjustified.join("\n")
    ).toEqual([]);
  });

  it("the switched callers stayed switched", () => {
    // reps went further than thin — see the rep-directory block below.
    expect(read("app/api/search/index/route.ts")).toMatch(/loadDashboardData\(sp, \{ thin: true \}\)/);
    expect(read("app/dashboard/stuck/page.tsx")).toMatch(/loadDashboardData\(sp, \{ thin: true \}\)/);
    expect(read("app/api/admin/inbox/route.ts")).not.toMatch(/loadSalesforceSnapshot\(\)/);
    expect(read("app/api/admin/health/route.ts")).toMatch(/loadSalesforceSnapshot\(\{ thin: true \}\)/);
  });
});

describe("the rep directory does not read a whole snapshot", () => {
  /**
   * Measured on production 2026-10-15: /api/admin/reps took 3227ms against
   * the full snapshot and 2365ms against thin — for about two kilobytes of
   * names, on an endpoint that fires on admin page loads.
   *
   * It cannot be made lazy; view-switcher.tsx pre-fetches on purpose,
   * because fetching on dropdown-open left admins reading "No reps match"
   * for up to thirty seconds. So the endpoint had to get cheaper instead.
   */
  it("reads the slice, not a snapshot", () => {
    const route = read("app/api/admin/reps/route.ts");
    expect(route).toContain("loadRepsDirectory()");
    expect(route, "back to loading a whole snapshot for 26 names")
      .not.toMatch(/loadSalesforceSnapshot\(/);
  });

  it("the warm writes the slice, or the fallback is the only path", () => {
    const q = read("lib/salesforce/queries.ts");
    const at = q.indexOf("export async function warmAllSnapshots");
    expect(at).toBeGreaterThan(-1);
    expect(q.slice(at)).toMatch(/writeSharedBlob\(REPS_SLICE_CACHE_KEY/);
  });

  it("falls back to the snapshot when the slice is absent", () => {
    // A missing slice must be no worse than the old behavior, never an error.
    const q = read("lib/salesforce/queries.ts");
    const at = q.indexOf("export async function loadRepsDirectory");
    const fn = q.slice(at, q.indexOf("\n}", at));
    expect(fn).toMatch(/if \(slice\?\.reps\?\.length\) return slice\.reps;/);
    expect(fn).toMatch(/loadSalesforceSnapshot\(\{ thin: true \}\)/);
  });

  it("sorts in both paths, so the dropdown order never depends on which ran", () => {
    const q = read("lib/salesforce/queries.ts");
    const warm = q.slice(q.indexOf("export async function warmAllSnapshots"));
    const dir = q.slice(q.indexOf("export async function loadRepsDirectory"));
    expect(warm).toMatch(/localeCompare/);
    expect(dir.slice(0, 600)).toMatch(/localeCompare/);
  });
});
