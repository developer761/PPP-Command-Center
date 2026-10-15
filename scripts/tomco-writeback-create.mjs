/**
 * Stage 3: put a sold deal into Salesforce that Salesforce has never seen.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/tomco-writeback-create.mjs                 plan only
 *   …same… --apply                                          does it
 *   …same… --apply --deal="Flagstar"                        one deal
 *
 * Separate from the Stage 2 runner on purpose. Creating is the only action in
 * this feature that can put a SECOND copy of a real sale into Katie's total, so
 * it does not share a command with the safe one — nobody should be able to run
 * it by adding a flag they half-remember.
 *
 * It will only create a deal that `decideWriteBack` says to insert: already
 * linked, held for review, or anything a person has not cleared is refused
 * here. That decision reads the pairing queue and the cutover date; see
 * lib/salesforce/tomco-decide.ts.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--deal=")) ?? "").slice(7).replace(/^["']|["']$/g, "");

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
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { getSalesforceClient } = await import("@/lib/salesforce/client");
const { createNew } = await import("@/lib/salesforce/tomco-writeback");
const { listUnpairedSoldDeals, listOpenSalesforceCandidates, listResolvedDeals } = await import("@/lib/salesforce/tomco-pairing");
const { decideWriteBack } = await import("@/lib/salesforce/tomco-decide");

const money = (c) => `$${(Number(c ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const conn = await getSalesforceClient();
const ctx = { conn, actorUserId: null, apply: APPLY };

console.log(`\n══ TOMCO WRITE-BACK · STAGE 3 (creates) · ${APPLY ? "APPLYING" : "PLAN"} ══`);
console.log(`   ${conn.instanceUrl}`);

const [deals, candidates, resolved] = await Promise.all([
  listUnpairedSoldDeals(),
  listOpenSalesforceCandidates(),
  listResolvedDeals(),
]);
const { data: meta } = await sb
  .from("commercial_opportunities")
  .select("id, created_at, decided_at")
  .in("id", deals.map((d) => d.id));
const metaOf = new Map((meta ?? []).map((r) => [r.id, r]));

const results = [];
for (const deal of deals) {
  if (ONLY && !deal.title.toLowerCase().includes(ONLY.toLowerCase())) continue;

  const decided = resolved.get(deal.id);
  const plan = decideWriteBack({
    deal,
    pairedSfId: null,
    openCandidates: candidates,
    dealCreatedAt: metaOf.get(deal.id)?.created_at ?? null,
  });

  /*
   * A HELD DEAL IS NOT CREATED, EVEN HERE.
   *
   * Unless a person has explicitly cleared it as new. The queue exists because
   * a machine cannot tell "new sale" from "the same job Mary already entered in
   * Salesforce", and a --apply on this script must not quietly overrule that.
   */
  if (plan.action === "hold" && decided?.decision !== "new") {
    console.log(`\n   ⏸  ${deal.title.slice(0, 50)}  ${money(deal.contractCents)}`);
    console.log(`        HELD — ${plan.why}`);
    console.log(`        clear it in the queue first, or with scripts/tomco-pair.mjs`);
    continue;
  }
  if (plan.action === "update") {
    console.log(`\n   ⏭  ${deal.title.slice(0, 50)} — already linked; that is Stage 2's job`);
    continue;
  }

  /*
   * The close date. Katie, 2026-10-14: "if the sync happens regularly, then the
   * Close Date should match the date that it's created." A flow overwrites it
   * with TODAY on the transition anyway, so sending the sold date would be
   * discarded — it is sent because the field is required on insert, not because
   * it survives.
   */
  const closeDate = (metaOf.get(deal.id)?.decided_at ?? new Date().toISOString()).slice(0, 10);

  // The GC, matched on an exact name. SOQL `=` is case-insensitive, which is
  // what makes "Cummins Sales" and "Cummins sales" one company.
  let accountId = null;
  if (deal.accountName) {
    const safe = deal.accountName.replace(/'/g, "\\'");
    const r = await conn.query(`SELECT Id, Name FROM Account WHERE Name = '${safe}'`);
    if (r.records.length === 1) accountId = r.records[0].Id;
    else if (r.records.length > 1) {
      console.log(`\n   🔴 ${deal.title.slice(0, 50)} — ${r.records.length} Salesforce accounts named "${deal.accountName}". Refusing: two GCs cannot share a name by accident.`);
      continue;
    } else {
      console.log(`\n   🔴 ${deal.title.slice(0, 50)} — no Salesforce account named "${deal.accountName}". Creating accounts is not in this stage.`);
      continue;
    }
  }

  const out = await createNew(ctx, deal, { accountId, closeDate });
  results.push(out);
  const icon = out.action === "failed" ? "🔴" : out.action === "skipped" ? "·" : APPLY ? "✅" : "·";
  console.log(`\n   ${icon} ${deal.title.slice(0, 50)}  ${money(deal.contractCents)}${out.sfId ? `  ${out.sfId}` : ""}`);
  console.log(`        account ${accountId ?? "none"} · close ${closeDate} · ${plan.why}`);
  for (const s of out.steps) console.log(`        ${s}`);
  if (out.error) console.log(`        🔴 ${out.error}`);
  for (const c of out.checks) console.log(`        ${c.ok ? "✅" : "🔴"} ${c.name}: ${c.detail}`);
}

const created = results.filter((r) => r.action === "created").length;
const failed = results.filter((r) => r.action === "failed").length;
console.log(`\n── ${created} ${APPLY ? "created" : "to create"} · ${failed} failed ──`);
if (!APPLY) console.log(`\n(plan only — nothing written. Re-run with --apply)\n`);
else console.log(`\nDone. Confirm with the reconciliation.\n`);
