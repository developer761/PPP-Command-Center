import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSEOUT_ITEM_KINDS,
  CLOSEOUT_ITEM_KIND_LABEL,
  DEFAULT_CLOSEOUT_ITEMS,
  ADDABLE_CLOSEOUT_ITEM_KINDS,
} from "@/lib/commercial/closeout/constants";

/**
 * The close-out checklist, and the CHECK constraint behind it.
 *
 * Stephanie 2026-08-13: "Don't need Certificate of Insurance, drawings,
 * manuals. Add finish schedule."
 */

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

/** The kind values in the LAST CHECK defined for the close-out items table. */
function checkedKinds(): string[] | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let found: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    // Per statement, not per file — a migration can define CHECKs for more
    // than one table, and scanning whole files reads the wrong one.
    for (const stmt of sql.split(";")) {
      if (!stmt.includes("commercial_closeout_items")) continue;
      for (const m of stmt.matchAll(/kind\s+IN\s*\(([^)]*)\)/gi)) {
        const vals = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
        if (vals.length > 0) found = vals;
      }
    }
  }
  return found;
}

describe("close-out item kinds match the database", () => {
  it("every kind the app knows is accepted by the CHECK", () => {
    // The exact gap migration 136 had to repair: a kind added in code only is
    // offered on screen and rejected by Postgres at save time, and nothing in
    // TypeScript can see it.
    const db = checkedKinds();
    expect(db, "no CHECK found for commercial_closeout_items").not.toBeNull();
    for (const k of CLOSEOUT_ITEM_KINDS) {
      expect(db!, `"${k}" would be rejected by the database`).toContain(k);
    }
  });

  it("every kind has a label", () => {
    for (const k of CLOSEOUT_ITEM_KINDS) {
      expect(CLOSEOUT_ITEM_KIND_LABEL[k], `no label for "${k}"`).toBeTruthy();
    }
  });
});

describe("the seeded checklist reflects what a painter actually closes out", () => {
  const seeded = DEFAULT_CLOSEOUT_ITEMS.map((i) => i.kind);

  it("seeds the finish schedule", () => {
    // For a painting contractor this IS the close-out record: product,
    // colour, sheen, room.
    expect(seeded).toContain("finish_schedule");
  });

  it("does not seed COI, as-builts or O&M manuals", () => {
    // COI is pre-construction (Katie, earlier); a painter produces neither
    // as-builts nor O&M manuals on a normal job. Seeding them made rows
    // somebody marked N/A on every package, which is how a checklist stops
    // being read at all.
    for (const k of ["coi", "as_built", "om_manual"]) {
      expect(seeded).not.toContain(k);
    }
  });

  it("still allows as-builts and O&M manuals to be added by hand", () => {
    // A GC's close-out spec occasionally demands product data. Losing the
    // ability to satisfy a contract term is worse than one extra row.
    expect(ADDABLE_CLOSEOUT_ITEM_KINDS).toContain("as_built");
    expect(ADDABLE_CLOSEOUT_ITEM_KINDS).toContain("om_manual");
  });

  it("keeps COI as a known kind so old packages still read properly", () => {
    // Packages created before Katie's change still carry the row; dropping the
    // kind would render it as "Other".
    expect(CLOSEOUT_ITEM_KINDS as readonly string[]).toContain("coi");
    expect(ADDABLE_CLOSEOUT_ITEM_KINDS).not.toContain("coi");
  });
});
