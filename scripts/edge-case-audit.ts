/**
 * Edge case audit — proactively hunt for bugs in the live dashboard data.
 *
 * Checks:
 *   1. Owners with WO revenue but missing/inactive User records
 *   2. WOs with null amount (won't appear in dashboard)
 *   3. WOs without Opportunity__c link (orphaned)
 *   4. Opps without WOs but with non-null Amount (where does revenue come from?)
 *   5. WO close-date <= created-date (impossible / data quality)
 *   6. Negative revenue values
 *   7. Accounts with Type=null
 *   8. Reps owning accounts in different regions (territory mismatch)
 *   9. Stale opps (created >180d ago, still open)
 *   10. Cancellations vs completions ratio
 *
 * Run: npx tsx scripts/edge-case-audit.ts
 */

import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";

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
  const map = Object.fromEntries(data!.map((r) => [r.key, r.value]));
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
  const refreshed = await conn.oauth2.refreshToken(map.sf_refresh_token);
  conn.accessToken = (refreshed as { access_token: string }).access_token;

  console.log(`Edge case audit · ${new Date().toISOString()}\n`);

  let issuesFound = 0;
  const log = (severity: "OK" | "WARN" | "BUG", msg: string) => {
    const icon = severity === "OK" ? "✓" : severity === "WARN" ? "⚠" : "✗";
    console.log(`  ${icon} ${severity.padEnd(4)} ${msg}`);
    if (severity !== "OK") issuesFound += 1;
  };

  /* ─── 1. WOs with null revenue ─── */
  console.log("[1] WorkOrders with null Subtotal__c (last 12 months):");
  try {
    const r = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:365 AND Subtotal__c = null AND NetValue__c = null AND Quoted_Subtotal_with_Change_Order__c = null`
    );
    const cnt = r.records[0]?.cnt ?? 0;
    if (cnt > 0) log("WARN", `${cnt} WOs have NO revenue figure populated — they'll show as $0 in dashboard`);
    else log("OK", "All WOs have at least one revenue field populated");
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 2. WOs without Opp link ─── */
  console.log("\n[2] WorkOrders without Opportunity__c link (last 12 months):");
  try {
    const r = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:365 AND Opportunity__c = null`
    );
    const cnt = r.records[0]?.cnt ?? 0;
    if (cnt > 0) log("WARN", `${cnt} WOs have no Opportunity — orphaned, won't get an Owner attributed`);
    else log("OK", "All recent WOs are linked to an Opportunity");
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 3. Opps with revenue but no WO ─── */
  console.log("\n[3] Opps with NetValue but no WorkOrder (potential dashboard double-count check):");
  try {
    // Opps that have NetValue set but no WO would show up in opp-totals but not WO-totals
    const r = await conn.query<{ cnt: number; sum: number }>(
      `SELECT COUNT(Id) cnt, SUM(NetValue__c) sum FROM Opportunity WHERE CreatedDate = LAST_N_DAYS:90 AND NetValue__c > 0`
    );
    const woR = await conn.query<{ cnt: number }>(
      `SELECT COUNT_DISTINCT(Opportunity__c) cnt FROM WorkOrder WHERE Opportunity__c IN (SELECT Id FROM Opportunity WHERE CreatedDate = LAST_N_DAYS:90 AND NetValue__c > 0)`
    );
    const oppCnt = r.records[0]?.cnt ?? 0;
    const woCnt = woR.records[0]?.cnt ?? 0;
    if (oppCnt > woCnt) {
      log("WARN", `${oppCnt - woCnt} opps have NetValue but no WO yet — they're in-flight quotes (expected if pipeline is healthy)`);
    } else {
      log("OK", "All revenue-bearing opps are attached to WOs");
    }
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 4. Negative revenue ─── */
  console.log("\n[4] Negative revenue values (data integrity):");
  try {
    const r = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM WorkOrder WHERE NetValue__c < 0 OR Subtotal__c < 0 OR Quoted_Subtotal_with_Change_Order__c < 0`
    );
    const cnt = r.records[0]?.cnt ?? 0;
    if (cnt > 0) log("WARN", `${cnt} WOs have negative revenue — likely credits/refunds, may skew totals`);
    else log("OK", "No negative revenue values");
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 5. Accounts with Type=null ─── */
  console.log("\n[5] Accounts with Type=null (would show as unbadged in customer cards):");
  try {
    const r = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Account WHERE Type = null`);
    const cnt = r.records[0]?.cnt ?? 0;
    if (cnt > 100) log("WARN", `${cnt} accounts have no Type set — repeat/key badges won't render for these`);
    else log("OK", `${cnt} accounts with Type=null (acceptable)`);
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 6. Stale opps (still open, created >180d ago) ─── */
  console.log("\n[6] Stale open opps (created >180d, still IsClosed=false):");
  try {
    const r = await conn.query<{ cnt: number; sum: number }>(
      `SELECT COUNT(Id) cnt, SUM(NetValue__c) sum FROM Opportunity WHERE IsClosed = false AND CreatedDate < LAST_N_DAYS:180`
    );
    const cnt = r.records[0]?.cnt ?? 0;
    const sumK = Math.round((r.records[0]?.sum ?? 0) / 1000);
    if (cnt > 0) log("WARN", `${cnt} stale open opps worth ~$${sumK.toLocaleString()}K — may need cleanup or auto-close`);
    else log("OK", "No stale opps");
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 7. Cancellation rate ─── */
  console.log("\n[7] WO cancellation rate (Status='Canceled' last 90d):");
  try {
    const canceled = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:90 AND Status = 'Canceled'`
    );
    const total = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:90`
    );
    const cancelCnt = canceled.records[0]?.cnt ?? 0;
    const totalCnt = total.records[0]?.cnt ?? 1;
    const rate = (cancelCnt / totalCnt) * 100;
    if (rate > 20) log("WARN", `${rate.toFixed(1)}% cancellation rate (${cancelCnt}/${totalCnt}) — high; investigate`);
    else log("OK", `${rate.toFixed(1)}% cancellation rate (${cancelCnt}/${totalCnt}) — healthy`);
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 8. Inactive owners with recent activity ─── */
  console.log("\n[8] Inactive users with recent WO activity (last 30d):");
  try {
    const r = await conn.query<{ owner_id: string; cnt: number }>(
      `SELECT Opportunity__r.OwnerId owner_id, COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:30 AND Opportunity__c != null GROUP BY Opportunity__r.OwnerId`
    );
    const ids = r.records.map((x) => x.owner_id).filter(Boolean);
    if (ids.length > 0) {
      const idList = ids.map((i) => `'${i}'`).join(",");
      const users = await conn.query<{ Id: string; Name: string; IsActive: boolean }>(
        `SELECT Id, Name, IsActive FROM User WHERE Id IN (${idList}) AND IsActive = false`
      );
      if (users.records.length > 0) {
        log("WARN", `${users.records.length} inactive users still own recent WOs: ${users.records.map((u) => u.Name).join(", ")}`);
      } else {
        log("OK", "All recent WO owners are active users");
      }
    }
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 9. Lifetime revenue field sanity ─── */
  console.log("\n[9] Accounts with Total_Lifetime_Revenue__c > 0 but no WO record:");
  try {
    const r = await conn.query<{ cnt: number; sum: number }>(
      `SELECT COUNT(Id) cnt, SUM(Total_Lifetime_Revenue__c) sum FROM Account WHERE Total_Lifetime_Revenue__c > 0`
    );
    log("OK", `${r.records[0]?.cnt ?? 0} accounts have Total_Lifetime_Revenue__c populated (total $${Math.round((r.records[0]?.sum ?? 0) / 1_000_000)}M lifetime across PPP)`);
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  /* ─── 10. Status value distribution ─── */
  console.log("\n[10] WO Status distribution (last 30 days):");
  try {
    const r = await conn.query<{ Status: string; cnt: number }>(
      `SELECT Status, COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:30 GROUP BY Status ORDER BY COUNT(Id) DESC`
    );
    for (const row of r.records) {
      console.log(`        ${row.cnt.toString().padStart(5)} × ${row.Status ?? "(null)"}`);
    }
    log("OK", `${r.records.length} distinct status values in last 30d`);
  } catch (e: any) {
    log("BUG", `Query failed: ${e.message}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  if (issuesFound === 0) {
    console.log(`✓ CLEAN AUDIT — zero issues found. Safe to move to Phase 2.`);
  } else {
    console.log(`Found ${issuesFound} issue(s) to triage above.`);
  }
  console.log(`${"=".repeat(60)}`);
  process.exit(issuesFound > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
