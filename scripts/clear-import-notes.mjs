/**
 * Take the import's own bookkeeping out of Mary's notes column.
 *
 * Every migrated invoice landed with `notes` set to "Imported from Salesforce
 * work order 00287824." — which is a fact about the MIGRATION, not about the
 * money. It filled the Notes column on Receivables, which is where Mary writes
 * what she has chased, so every row read as though somebody had already written
 * a note and had nothing to say. It also starved the AI read, which summarises
 * that column.
 *
 * Karan 2026-09-17: "yes clear the notes."
 *
 * Only the sentence this import wrote is removed. Anything appended after it —
 * the adjustment labels the importer adds for a folded tax or a carried
 * adjustment — is kept, because that IS about the money.
 *
 *   node --env-file=.env.local scripts/clear-import-notes.mjs            # dry run
 *   node --env-file=.env.local scripts/clear-import-notes.mjs --commit
 */
import { readFileSync } from "node:fs";

const COMMIT = process.argv.includes("--commit");
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data } = await sb
  .from("commercial_invoices")
  .select("id, invoice_number, notes")
  .is("deleted_at", null)
  .like("notes", "Imported from Salesforce work order%");

const IMPORT_SENTENCE = /^Imported from Salesforce work order [^.]*\.\s*/;
const plan = (data ?? []).map((i) => ({
  id: i.id,
  invoice_number: i.invoice_number,
  before: i.notes,
  after: (i.notes || "").replace(IMPORT_SENTENCE, "").trim() || null,
}));

const kept = plan.filter((p) => p.after);
console.log(`\n${plan.length} invoices carry the import sentence${COMMIT ? "" : "   (DRY RUN)"}`);
console.log(`  cleared to blank      : ${plan.length - kept.length}`);
console.log(`  something real kept   : ${kept.length}`);
for (const k of kept.slice(0, 5)) console.log(`     ${k.invoice_number}  →  "${k.after}"`);

if (!COMMIT) {
  console.log("\nRe-run with --commit to apply.");
  process.exit(0);
}

let n = 0;
for (const p of plan) {
  const { error } = await sb.from("commercial_invoices").update({ notes: p.after }).eq("id", p.id);
  if (error) console.error("  failed", p.invoice_number, error.message);
  else n++;
}
console.log(`\n✅ ${n} of ${plan.length} notes cleared`);
