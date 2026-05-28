/**
 * Verification script for Katie's 2026-05-27 FPRC KPI alignment.
 *
 * Hits live PPP Salesforce and confirms every field name + picklist value
 * the new scorecard code depends on. If anything here returns "FAIL", the
 * shipped fixes won't tie out against PPP's data — pause + investigate
 * before announcing reconciliation to the team.
 *
 * Run: npx tsx scripts/verify-kpi-alignment.ts
 */

import { readFileSync } from "fs";

const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";

const PASS = "✅ PASS";
const FAIL = "❌ FAIL";
const WARN = "⚠️  WARN";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } }
  );

  const { data } = await sb
    .from("system_credentials")
    .select("key, value")
    .in("key", ["sf_refresh_token", "sf_instance_url"]);

  if (!data || data.length < 2) {
    console.error("No SF credentials. Run /api/auth/salesforce/login first.");
    process.exit(1);
  }
  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));

  const conn = new jsforce.Connection({
    instanceUrl: map.sf_instance_url,
    refreshToken: map.sf_refresh_token,
    oauth2: {
      clientId: process.env.SF_CONSUMER_KEY!,
      clientSecret: process.env.SF_CONSUMER_SECRET!,
      loginUrl: process.env.SF_LOGIN_URL!,
    },
    version: "60.0",
  });

  await conn.identity(); // forces a refresh
  console.log(`Connected to: ${map.sf_instance_url}\n`);
  console.log("═════════════════════════════════════════════════════════════");
  console.log(" Verifying Katie's 6 FPRC KPI alignment assumptions against SF");
  console.log("═════════════════════════════════════════════════════════════\n");

  let allPassed = true;
  const fail = (msg: string) => { allPassed = false; console.log(`  ${FAIL} ${msg}`); };
  const pass = (msg: string) => console.log(`  ${PASS} ${msg}`);
  const warn = (msg: string) => console.log(`  ${WARN} ${msg}`);

  // ─────────────────────────────────────────────────────────────
  // FIX 2 — Self-Gen LeadGroup picklist values
  // ─────────────────────────────────────────────────────────────
  console.log("─── Fix 2 · Self-Gen LeadGroup picklist values ───");
  try {
    const oppMeta = await conn.describe("Opportunity");
    const leadGroupField = oppMeta.fields.find((f) => f.name === "LeadGroup__c");
    if (!leadGroupField) {
      fail("Opportunity.LeadGroup__c field NOT FOUND");
    } else {
      const expected = ["Self-Generated", "Trade Show", "Repeat", "Referral"];
      const actualValues = (leadGroupField.picklistValues ?? []).map((p) => p.value);
      console.log(`     Picklist values found: ${actualValues.join(", ") || "(none — free-text or hardcoded?)"}`);
      for (const exp of expected) {
        if (actualValues.includes(exp)) pass(`"${exp}" exists in picklist`);
        else if (actualValues.length === 0) warn(`"${exp}" — picklist values not returned by describe (may be String field, not Picklist)`);
        else fail(`"${exp}" NOT in picklist — case mismatch?`);
      }
      // Sample real data to confirm casing in actual records
      const r = await conn.query<{ LeadGroup__c: string }>(
        "SELECT LeadGroup__c, COUNT(Id) cnt FROM Opportunity WHERE LeadGroup__c != null GROUP BY LeadGroup__c ORDER BY COUNT(Id) DESC LIMIT 20"
      );
      console.log(`     Live data sample (top 20 by count):`);
      for (const row of r.records as Array<{ LeadGroup__c: string; cnt: number }>) {
        const mark = expected.includes(row.LeadGroup__c) ? "  [self-gen]" : "  [marketing]";
        console.log(`       ${row.LeadGroup__c}  (${row.cnt} opps)${mark}`);
      }
    }
  } catch (e) {
    fail(`LeadGroup__c probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // FIX 3 — Case.Type picklist values
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Fix 3 · Case.Type picklist values (complaint filter) ───");
  try {
    const caseMeta = await conn.describe("Case");
    const typeField = caseMeta.fields.find((f) => f.name === "Type");
    if (!typeField) {
      fail("Case.Type field NOT FOUND");
    } else {
      const expected = ["Dissatisfied Customer", "Service Call"];
      const actualValues = (typeField.picklistValues ?? []).map((p) => p.value);
      console.log(`     Picklist values found: ${actualValues.join(", ") || "(none — free-text?)"}`);
      for (const exp of expected) {
        if (actualValues.includes(exp)) pass(`"${exp}" exists in picklist (exact case match)`);
        else if (actualValues.length === 0) warn(`"${exp}" — picklist values not returned by describe`);
        else fail(`"${exp}" NOT in picklist — case mismatch?`);
      }
      // Live sample
      const r = await conn.query<{ Type: string }>(
        "SELECT Type, COUNT(Id) cnt FROM Case WHERE Type != null GROUP BY Type ORDER BY COUNT(Id) DESC LIMIT 20"
      );
      console.log(`     Live data sample (top 20 by count):`);
      for (const row of r.records as Array<{ Type: string; cnt: number }>) {
        const mark = expected.includes(row.Type) ? "  [counts as complaint]" : "";
        console.log(`       ${row.Type}  (${row.cnt} cases)${mark}`);
      }
    }
  } catch (e) {
    fail(`Case.Type probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // FIX 4 — Transaction__c.PayeeType__c + Description__c
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Fix 4 · Transaction__c PayeeType + Description fields ───");
  try {
    const txMeta = await conn.describe("Transaction__c");
    const payeeTypeField = txMeta.fields.find((f) => f.name === "PayeeType__c");
    const descField = txMeta.fields.find((f) => f.name === "Description__c");

    if (!payeeTypeField) fail("Transaction__c.PayeeType__c field NOT FOUND");
    else {
      const values = (payeeTypeField.picklistValues ?? []).map((p) => p.value);
      console.log(`     PayeeType__c picklist values: ${values.join(", ") || "(none)"}`);
      if (values.includes("Sales")) pass(`"Sales" exists in PayeeType__c picklist (exact case)`);
      else if (values.length === 0) warn(`PayeeType__c picklist values not returned by describe (may be Free-text)`);
      else fail(`"Sales" NOT in picklist — actual values: ${values.join(", ")}`);
    }

    if (!descField) fail("Transaction__c.Description__c field NOT FOUND — Fix 4 will not work");
    else pass(`Description__c field exists (type: ${descField.type}, length: ${descField.length})`);

    // Live data: count Payment_Out / PayeeType=Sales / Description LIKE %Draw% in last 365d
    const drawCheck = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM Transaction__c WHERE RecordType.DeveloperName = 'Payment_Out' AND PayeeType__c = 'Sales' AND Description__c LIKE '%Draw%' AND Date__c = LAST_N_DAYS:365`
    );
    const cnt = (drawCheck.records[0] as unknown as { cnt: number }).cnt;
    if (cnt > 0) pass(`${cnt} Draw payouts found in last 365d (PayeeType='Sales' + Description LIKE '%Draw%')`);
    else fail(`ZERO Draw payouts found in last 365d — filter chain returns nothing. KPI 9 will show $0 for all reps.`);

    // Sample 5 to confirm the shape
    if (cnt > 0) {
      const sample = await conn.query<{ Id: string; Amount__c: number; PayeeType__c: string; Description__c: string; Date__c: string }>(
        `SELECT Id, Amount__c, PayeeType__c, Description__c, Date__c, Payee__r.Name FROM Transaction__c WHERE RecordType.DeveloperName = 'Payment_Out' AND PayeeType__c = 'Sales' AND Description__c LIKE '%Draw%' AND Date__c = LAST_N_DAYS:365 ORDER BY Date__c DESC LIMIT 5`
      );
      console.log(`     Sample Draw payouts:`);
      for (const row of sample.records as Array<{ Amount__c: number; PayeeType__c: string; Description__c: string; Date__c: string; Payee__r: { Name: string } | null }>) {
        console.log(`       ${row.Date__c}  $${row.Amount__c?.toFixed(2)}  PayeeType="${row.PayeeType__c}"  Desc="${row.Description__c}"  Payee="${row.Payee__r?.Name ?? "(none)"}"`);
      }
    }

    // Bonus: distinct PayeeType values present in DATA (catches case-drift)
    const payeeDistinct = await conn.query<{ PayeeType__c: string; cnt: number }>(
      "SELECT PayeeType__c, COUNT(Id) cnt FROM Transaction__c WHERE PayeeType__c != null GROUP BY PayeeType__c ORDER BY COUNT(Id) DESC"
    );
    console.log(`     All distinct PayeeType values in live data:`);
    for (const row of payeeDistinct.records as Array<{ PayeeType__c: string; cnt: number }>) {
      console.log(`       "${row.PayeeType__c}"  (${row.cnt})`);
    }
  } catch (e) {
    fail(`Transaction probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // FIX 5 — WorkOrder.TotalChangeOrder__c
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Fix 5 · WorkOrder.TotalChangeOrder__c field ───");
  try {
    const woMeta = await conn.describe("WorkOrder");
    const tcoField = woMeta.fields.find((f) => f.name === "TotalChangeOrder__c");
    if (!tcoField) fail("WorkOrder.TotalChangeOrder__c field NOT FOUND — KPI 7 Change Orders $ will always be 0");
    else {
      pass(`TotalChangeOrder__c exists (type: ${tcoField.type}, calculated: ${tcoField.calculated})`);
      const stats = await conn.query<{ total: number; cnt: number }>(
        "SELECT SUM(TotalChangeOrder__c) total, COUNT(Id) cnt FROM WorkOrder WHERE TotalChangeOrder__c > 0 AND CreatedDate = LAST_N_DAYS:365"
      );
      const row = stats.records[0] as unknown as { total: number; cnt: number };
      if (row.cnt > 0) pass(`${row.cnt} WOs in last 365d have change orders; SUM = $${row.total?.toFixed(2)}`);
      else warn(`No WOs in last 365d have TotalChangeOrder__c > 0 (field exists but always 0)`);
    }
  } catch (e) {
    fail(`WorkOrder probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─────────────────────────────────────────────────────────────
  // FIX 6 — WO status picklist values exist
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Fix 6 · WorkOrder.Status values (strict GM/Pricing set) ───");
  try {
    const r = await conn.query<{ Status: string; cnt: number }>(
      "SELECT Status, COUNT(Id) cnt FROM WorkOrder WHERE Status != null GROUP BY Status ORDER BY COUNT(Id) DESC LIMIT 20"
    );
    const strictSet = new Set(["closed", "complete paid in full"]);
    const broadSet = new Set(["closed", "complete paid in full", "complete balance owed"]);
    console.log(`     Live WO Status values (top 20):`);
    for (const row of r.records as Array<{ Status: string; cnt: number }>) {
      const lower = row.Status.toLowerCase();
      const mark = strictSet.has(lower) ? " [strict: GM/Pricing/KPI7]"
        : broadSet.has(lower) ? " [broad: KPI 4b only]"
        : "";
      console.log(`       "${row.Status}"  (${row.cnt})${mark}`);
    }
  } catch (e) {
    fail(`WO Status probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n═════════════════════════════════════════════════════════════");
  console.log(allPassed ? " RESULT: ALL ASSUMPTIONS VERIFIED ✅" : " RESULT: BUGS DETECTED — fix before announcing ❌");
  console.log("═════════════════════════════════════════════════════════════\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
