/**
 * The Ascent $75 — a mis-keyed cheque number, not a second payment.
 *
 * Salesforce cheque 974107 is ONE GC cheque split across four jobs:
 *   AlphaMed $1,425 · Ascent $75 · DuCon-Landlord $855 · LMJ Cipla $950
 * Cheque 974104 is $3,150, on LMJ- Big Apple Phase 4 — a different job, a
 * different amount. So the hand-entered Ascent row referencing "974104" at $75
 * is the 974107 line typed with the wrong cheque number, and Ascent's invoice
 * reads $1,575 paid against a $1,500 total.
 *
 * Removes the CC-entered copy and keeps the Salesforce-imported one, per the
 * rule in the labor-payout script: the imported row carries the import-map row
 * that ties the two systems together.
 *
 * `commercial_invoice_payments` has no deleted_at — the row is hard-deleted,
 * and trg_recompute_paid_cents (042, fires on DELETE) puts paid_cents and the
 * invoice status back.
 */
import { readFileSync } from "node:fs";
const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(
  readFileSync("/Users/karanmalhotra/Desktop/PPP/ppp-command-center/.env.local", "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const m = (c) => `$${((c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const TARGET = "e446bdc3-b8c2-45e5-a5ce-695e90fc5eda";
const { data: row } = await sb.from("commercial_invoice_payments")
  .select("id,invoice_id,amount_cents,paid_at,reference,recorded_by_user_id").eq("id", TARGET).maybeSingle();
if (!row) { console.log(`row ${TARGET} is already gone — nothing to do.`); process.exit(0); }
const { data: inv } = await sb.from("commercial_invoices")
  .select("invoice_number,total_cents,paid_cents,balance_cents,status").eq("id", row.invoice_id).maybeSingle();

// Refuse to act if this is not the row the docblock describes.
if (Number(row.amount_cents) !== 7500 || row.reference !== "974104" || !row.recorded_by_user_id) {
  console.error(`🔴 REFUSING: row does not match the expected shape ($75.00, ref 974104, person-recorded).`);
  console.error(`   found: ${m(row.amount_cents)}, ref ${row.reference}, recorded_by ${row.recorded_by_user_id ?? "importer"}`);
  process.exit(1);
}
console.log(`\ninvoice ${inv.invoice_number} BEFORE  total ${m(inv.total_cents)}  paid ${m(inv.paid_cents)}  balance ${m(inv.balance_cents)}  status=${inv.status}`);
console.log(`deleting  ${m(row.amount_cents)}  ref ${row.reference}  ${String(row.paid_at).slice(0,10)}  (hand-entered)`);
if (!APPLY) { console.log(`\n(dry run — nothing written. re-run with --apply)\n`); process.exit(0); }

const { error } = await sb.from("commercial_invoice_payments").delete().eq("id", TARGET);
if (error) throw new Error(error.message);
const { data: inv2 } = await sb.from("commercial_invoices")
  .select("invoice_number,total_cents,paid_cents,balance_cents,status").eq("id", row.invoice_id).maybeSingle();
console.log(`invoice ${inv2.invoice_number} AFTER   total ${m(inv2.total_cents)}  paid ${m(inv2.paid_cents)}  balance ${m(inv2.balance_cents)}  status=${inv2.status}`);
console.log(Number(inv2.paid_cents) === Number(inv2.total_cents) ? `\n✅ paid now equals total.\n` : `\n⚠️  paid still != total — look before trusting this.\n`);
