/**
 * Retro-adopt the cost duplicates that already exist.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/fix-adopt-existing-cost-duplicates.mjs            dry run
 *   …same… --apply                                                 does it
 *
 * WHY THIS IS NOT "DELETE THE DUPLICATE"
 *
 * Mary records job costs in the Commercial Command Center. That is correct and
 * wanted — it is the platform going forward, and her entries are real records
 * of real purchases. The duplicate exists because the SAME purchase also sits
 * in Salesforce and the importer, which only asked "is this Salesforce id
 * mapped?", inserted a row of its own.
 *
 * `stageCosts` now adopts: it finds her row first and claims it. But that only
 * helps transactions it has not already imported, and every one of these pairs
 * is a transaction that already created its own row on an earlier run. So the
 * existing pairs need the same outcome applied backwards.
 *
 * WHICH ROW SURVIVES, AND WHY IT IS HERS
 *
 * An earlier pass deleted the Command Center copy and kept the imported one,
 * reasoning that the imported row carries the import-map row that ties the two
 * systems together. That reasoning was about the MAP, not about the data — and
 * the map can simply be re-pointed. Her row holds the category she chose
 * (Sunbelt as "equipment", where Salesforce says "materials") and the
 * description she wrote ("Scissor Lift Rental" against a bare ticket number).
 * Keeping the ticket number and discarding the description is backwards.
 *
 * So: her row is adopted into the map, and the imported row is soft-deleted.
 * The amounts are identical — that is what made it a match — so no money moves
 * and the reconciliation does not shift by a cent.
 *
 * AND THE TICKET NUMBER IS CARRIED ACROSS.
 *
 * Reading the actual plan changed this script. Only ONE of her five rows has a
 * description ("Scissor Lift Rental"); the other four are blank, while every
 * imported row carries a receipt reference — TN-205834, TN-206006, TN-205654.
 * That number is how somebody finds the physical receipt, so discarding it to
 * keep an empty field would be a worse answer than either row alone. Her row
 * survives and takes the ticket number when it has nothing of its own.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const { findNearMissDuplicates } = await import("@/lib/commercial/import/near-miss");
const money = (c) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

async function page(table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const map = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("commercial_import_map")
    .select("sf_id, entity, row_id")
    .eq("entity", "purchase")
    .order("sf_id")
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  map.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const sfIdOf = new Map(map.map((r) => [r.row_id, r.sf_id]));

const live = (
  await page(
    "commercial_project_purchases",
    "id, opportunity_id, vendor, category, amount_cents, purchased_at, description, deleted_at",
    ["id"],
  )
).filter((r) => !r.deleted_at && r.opportunity_id && Number(r.amount_cents ?? 0) !== 0);
const deals = await page("commercial_opportunities", "id, title", ["id"]);
const nameOf = new Map(deals.map((d) => [d.id, d.title]));

const { cross } = findNearMissDuplicates(
  live.map((r) => ({
    id: r.id,
    groupKey: r.opportunity_id,
    payee: r.vendor,
    amountCents: Number(r.amount_cents ?? 0),
    occurredAt: r.purchased_at,
    imported: sfIdOf.has(r.id),
  })),
);

console.log(`\n══ RETRO-ADOPT COST DUPLICATES · ${APPLY ? "APPLYING" : "DRY RUN"} ══\n`);
if (cross.length === 0) {
  console.log("Nothing paired across the two systems. Nothing to do.\n");
  process.exit(0);
}

const plan = [];
for (const pair of cross) {
  const a = live.find((x) => x.id === pair.a.id);
  const b = live.find((x) => x.id === pair.b.id);
  const imported = sfIdOf.has(a.id) ? a : b;
  const hers = sfIdOf.has(a.id) ? b : a;
  const sfId = sfIdOf.get(imported.id);
  if (!sfId) {
    console.log(`   ⏭  ${nameOf.get(a.opportunity_id)} — no Salesforce id on the imported row, skipping`);
    continue;
  }
  plan.push({ hers, imported, sfId });
  console.log(`   ${nameOf.get(hers.opportunity_id)?.slice(0, 34)}  ${money(hers.amount_cents)}  ${pair.daysApart}d apart`);
  const carry = !String(hers.description ?? "").trim() && String(imported.description ?? "").trim()
    ? String(imported.description).trim()
    : null;
  plan[plan.length - 1].carry = carry;
  console.log(`      KEEP    ${hers.purchased_at?.slice(0, 10)}  ${hers.category.padEnd(15)} "${String(hers.description ?? "").slice(0, 34)}"   ← hers`);
  console.log(`      RETIRE  ${imported.purchased_at?.slice(0, 10)}  ${imported.category.padEnd(15)} "${String(imported.description ?? "").slice(0, 34)}"   ← imported (${sfId})`);
  console.log(
    carry
      ? `      the map moves to her row, and it takes the ticket number "${carry}"\n`
      : `      the map moves to her row; it already has its own description\n`,
  );
}

if (plan.length === 0) {
  console.log("Nothing actionable.\n");
  process.exit(0);
}
console.log(`  ${plan.length} pair(s). Job costs drop by ${money(plan.reduce((n, p) => n + Number(p.imported.amount_cents ?? 0), 0))} — the duplicated half.`);
if (!APPLY) {
  console.log(`\n(dry run — nothing written. Re-run with --apply)\n`);
  process.exit(0);
}

console.log(`\n── writing ──`);
let failed = 0;
for (const { hers, imported, sfId, carry } of plan) {
  /*
   * ORDER MATTERS. Re-point the map FIRST: if the delete succeeded and the
   * remap then failed, the Salesforce transaction would point at a deleted row
   * and the next import would insert a fresh duplicate — the exact state this
   * is here to remove. Done this way round, a failure leaves two live rows,
   * which is where we already are.
   *
   * Stamped at the epoch so `editedHere()` reads her row as human-edited and
   * Salesforce never overwrites the category and description she chose.
   */
  const { error: mapErr } = await sb
    .from("commercial_import_map")
    .update({ row_id: hers.id, updated_at: new Date(0).toISOString(), notes: "retro-adopted: already entered in the Command Center" })
    .eq("sf_id", sfId)
    .eq("entity", "purchase");
  if (mapErr) { failed++; console.log(`   🔴 ${sfId}: remap failed — ${mapErr.message}`); continue; }

  if (carry) {
    // Her row keeps everything she chose and gains the receipt reference it
    // did not have. Nothing is overwritten — this only runs when hers is blank.
    const { error: descErr } = await sb
      .from("commercial_project_purchases")
      .update({ description: carry })
      .eq("id", hers.id);
    if (descErr) console.warn(`   ⚠️  could not carry the ticket number onto ${hers.id}: ${descErr.message}`);
  }

  const { error: delErr } = await sb
    .from("commercial_project_purchases")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", imported.id)
    .is("deleted_at", null);
  if (delErr) { failed++; console.log(`   🔴 ${imported.id}: retire failed — ${delErr.message}`); continue; }

  console.log(`   ✅ ${money(hers.amount_cents)} ${hers.vendor} — map → her row, imported copy retired`);
}
console.log(
  failed === 0
    ? `\n✅ ${plan.length} resolved. Re-run: npm run check:money\n`
    : `\n${failed} of ${plan.length} failed.\n`,
);
