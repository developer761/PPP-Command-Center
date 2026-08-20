import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCUMENT_CATEGORIES,
  documentCategoryLabel,
} from "@/lib/commercial/documents/categories";

/**
 * Constants that exist in two places.
 *
 * This is the failure that ate Brendan's 2026-08-12 change: he retired four
 * document categories from the account, and the upload form went on offering
 * all four — with a retired one still selected by default — because the form
 * carried its own hardcoded copy of the list. Their own file says it: *"The
 * constants said one thing and the screen said another, which is worse than
 * not having made the change at all."*
 *
 * The deal-side form had the same copy, and it had ALREADY drifted:
 * `work_order` was in the real list and absent from the mirror, so nobody
 * could file a document under it. Nothing failed; the option simply wasn't
 * there.
 *
 * Client components genuinely cannot import `server-only` modules, so some
 * mirrors are unavoidable. What is avoidable is drift going unnoticed.
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The literal in `const X = 100 * 1024 * 1024` or `= 52428800`. */
function byteConstant(src: string, name: string): number | null {
  const m = src.match(new RegExp(`${name}\\s*=\\s*([\\d*\\s]+);`));
  if (!m) return null;
  // Only digits, spaces and `*` were captured, so this is arithmetic-safe.
  return m[1].split("*").reduce((a, b) => a * Number(b.trim()), 1);
}

describe("document category list is not mirrored", () => {
  it("the deal upload form imports the list instead of copying it", () => {
    const src = read("components/commercial-files-upload-form.tsx");
    expect(src).toContain('from "@/lib/commercial/documents/categories"');
    // A hand-written array of {value, label} pairs is the shape that drifts.
    expect(src).not.toMatch(/\{\s*value:\s*"(bid_set|rfi|permit|insurance)"/);
  });

  it("no client component hardcodes a category value list", () => {
    for (const f of [
      "components/commercial-files-upload-form.tsx",
      "components/commercial-document-upload-form.tsx",
    ]) {
      const src = read(f);
      const pairs = [...src.matchAll(/\{\s*value:\s*"[a-z_0-9]+",\s*label:/g)];
      expect(pairs.length, `${f} hardcodes ${pairs.length} category entries`).toBe(0);
    }
  });

  it("every category has a real label, not the raw slug", () => {
    // documentCategoryLabel falls through to returning the slug, so a new
    // category with no case lands in the picker reading "master_agreement".
    for (const c of DOCUMENT_CATEGORIES) {
      expect(documentCategoryLabel(c), `no label for "${c}"`).not.toBe(c);
    }
  });

  it("carries the compliance documents Tomco provides to the GC", () => {
    // Stephanie 2026-08-13. On a proposal Tomco is the subcontractor, so these
    // belong to the job, not to the customer record.
    for (const c of ["insurance", "w9", "master_agreement", "safety", "prequal"]) {
      expect(DOCUMENT_CATEGORIES as readonly string[]).toContain(c);
    }
  });
});

describe("upload size limits stay in sync with their servers", () => {
  it("the deal form's client limit matches lib/commercial/documents/db.ts", () => {
    // Drift here is silent in the worst way: a client cap ABOVE the server's
    // lets someone upload for two minutes and then be refused at the end.
    const server = byteConstant(read("lib/commercial/documents/db.ts"), "MAX_UPLOAD_BYTES");
    const client = byteConstant(
      read("components/commercial-files-upload-form.tsx"),
      "CLIENT_MAX_UPLOAD_BYTES"
    );
    expect(server).not.toBeNull();
    expect(client).toBe(server);
  });

  it("the account form's client limit matches lib/commercial/accounts/documents.ts", () => {
    const server = byteConstant(read("lib/commercial/accounts/documents.ts"), "MAX_UPLOAD_BYTES");
    const src = read("components/commercial-document-upload-form.tsx");
    const client =
      byteConstant(src, "CLIENT_MAX_UPLOAD_BYTES") ?? byteConstant(src, "MAX_UPLOAD_BYTES");
    expect(server).not.toBeNull();
    expect(client).toBe(server);
  });
});

/**
 * The custom-alert triggers live in TypeScript AND in a Postgres CHECK. They
 * are a mirror by necessity — the DB has to reject a bad value even if the app
 * is bypassed — but drift here is silent in the worst direction: the picker
 * offers a trigger, the user configures it, and the INSERT is rejected by a
 * constraint they will never see the text of.
 *
 * Found while adding `aia_overdue`, which had to be added in both places.
 */
describe("notification-rule triggers match their CHECK constraint", () => {
  it("every trigger the UI offers is one the database accepts", () => {
    const ts = read("lib/commercial/notification-rules/constants.ts");
    const tsTriggers = (ts.match(/export const RULE_TRIGGERS = \[([\s\S]*?)\] as const;/)?.[1] ?? "")
      .match(/"([a-z_]+)"/g)
      ?.map((q) => q.replace(/"/g, "")) ?? [];
    expect(tsTriggers.length).toBeGreaterThan(5);

    // The LAST migration to redefine the constraint wins.
    const sqlFiles = ["supabase/migrations/075_commercial_notification_rules.sql",
                      "supabase/migrations/157_aia_application_dunning.sql"];
    const latest = sqlFiles
      .map(read)
      .filter((sql) => /trigger IN \(/.test(sql))
      .pop()!;
    const sqlTriggers = (latest.match(/trigger IN \(([\s\S]*?)\)/)?.[1] ?? "")
      .match(/'([a-z_]+)'/g)
      ?.map((q) => q.replace(/'/g, "")) ?? [];

    expect([...tsTriggers].sort()).toEqual([...sqlTriggers].sort());
  });

  it("every trigger has picker copy, so none renders blank", () => {
    const ts = read("lib/commercial/notification-rules/constants.ts");
    const tsTriggers = (ts.match(/export const RULE_TRIGGERS = \[([\s\S]*?)\] as const;/)?.[1] ?? "")
      .match(/"([a-z_]+)"/g)
      ?.map((q) => q.replace(/"/g, "")) ?? [];
    const meta = ts.slice(ts.indexOf("TRIGGER_META"));
    for (const t of tsTriggers) expect(meta).toContain(`${t}: {`);
    // …and each is reachable from a group, or the picker never shows it.
    const groups = ts.slice(ts.indexOf("TRIGGER_GROUPS"), ts.indexOf("RULE_CHANNELS"));
    for (const t of tsTriggers) expect(groups).toContain(`"${t}"`);
  });
});
