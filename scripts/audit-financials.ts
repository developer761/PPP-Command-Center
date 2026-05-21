/**
 * Verify the Financials tab numbers against raw SOQL.
 * Focused on the metrics Karan called out: GP margin, AR aging, lead fee,
 * discounts, commission. Catches "100% margin everywhere" bugs.
 */

import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";

const fmt = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : Math.abs(n) >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
  : `$${n.toFixed(0)}`;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } }
  );
  const { data } = await sb.from("system_credentials").select("key, value").in("key", ["sf_refresh_token", "sf_instance_url"]);
  const map = Object.fromEntries(data!.map((r) => [r.key, r.value]));
  const conn = new jsforce.Connection({
    instanceUrl: map.sf_instance_url,
    refreshToken: map.sf_refresh_token,
    oauth2: { clientId: process.env.SF_CONSUMER_KEY!, clientSecret: process.env.SF_CONSUMER_SECRET!, loginUrl: process.env.SF_LOGIN_URL! },
    version: "60.0",
  });
  const refreshed = await conn.oauth2.refreshToken(map.sf_refresh_token);
  conn.accessToken = (refreshed as { access_token: string }).access_token;

  console.log("FINANCIALS AUDIT · this month\n");

  // 1. Revenue + GP reality check
  console.log("[1] Per-WO GP vs Amount comparison (last 30d, sample):");
  const sample = await conn.query<{
    Id: string; NetValue__c: number; GrossProfit__c: number;
    CostMaterials__c: number; TotalPayoutsForLabor__c: number;
  }>(
    `SELECT Id, NetValue__c, GrossProfit__c, CostMaterials__c, TotalPayoutsForLabor__c FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:30 AND NetValue__c > 0 LIMIT 20`
  );
  let gpEqualsRev = 0, hasExplicitCost = 0, missing = 0;
  for (const w of sample.records) {
    const cost = (w.CostMaterials__c ?? 0) + (w.TotalPayoutsForLabor__c ?? 0);
    if (cost > 0) hasExplicitCost += 1;
    if (w.GrossProfit__c && w.GrossProfit__c >= w.NetValue__c * 0.99) gpEqualsRev += 1;
    if (!w.GrossProfit__c || w.GrossProfit__c === 0) missing += 1;
  }
  console.log(`  ${gpEqualsRev}/${sample.records.length} WOs have GP ≈ Amount (= no cost data entered)`);
  console.log(`  ${hasExplicitCost}/${sample.records.length} WOs have explicit cost data (materials + labor)`);
  console.log(`  ${missing}/${sample.records.length} WOs have GP missing entirely`);

  // 2. Aggregate margin reality check
  console.log("\n[2] Aggregate margin reality check (this month):");
  const agg = await conn.query<{
    revenue: number; gp: number; materials: number; labor: number; cnt: number;
  }>(
    `SELECT SUM(NetValue__c) revenue, SUM(GrossProfit__c) gp, SUM(CostMaterials__c) materials, SUM(TotalPayoutsForLabor__c) labor, COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = THIS_MONTH AND NetValue__c > 0`
  );
  const a = agg.records[0];
  if (a) {
    const reportedMargin = a.revenue > 0 ? (a.gp / a.revenue) * 100 : 0;
    const explicitCost = (a.materials ?? 0) + (a.labor ?? 0);
    const explicitMargin = a.revenue > 0 ? ((a.revenue - explicitCost) / a.revenue) * 100 : 0;
    console.log(`  WO count:        ${a.cnt}`);
    console.log(`  Net Revenue:     ${fmt(a.revenue)}`);
    console.log(`  Reported GP:     ${fmt(a.gp)} (${reportedMargin.toFixed(1)}% margin)`);
    console.log(`  Materials:       ${fmt(a.materials ?? 0)} (${a.revenue > 0 ? ((a.materials ?? 0) / a.revenue * 100).toFixed(1) : 0}% of revenue)`);
    console.log(`  Labor payouts:   ${fmt(a.labor ?? 0)} (${a.revenue > 0 ? ((a.labor ?? 0) / a.revenue * 100).toFixed(1) : 0}% of revenue)`);
    console.log(`  Explicit costs:  ${fmt(explicitCost)} → implied margin ${explicitMargin.toFixed(1)}%`);
    if (reportedMargin > 90) {
      console.log(`\n  ⚠ Reported margin >90% — confirms many WOs have GP = Amount (cost data missing).`);
    }
    if ((a.labor ?? 0) < a.revenue * 0.20) {
      console.log(`  ⚠ Labor payouts are only ${(((a.labor ?? 0) / a.revenue) * 100).toFixed(1)}% of revenue.`);
      console.log(`    Real paint contractor labor is ~30-40%. Either labor data is incomplete,`);
      console.log(`    or PPP tracks labor cost differently (e.g., crew rate × days, not payout records).`);
    }
  }

  // 3. AR aging
  console.log("\n[3] AR aging right now (BalanceOwed > 0):");
  const aging = await conn.query<{ aging: number | null; sum: number; cnt: number }>(
    `SELECT Final_Balance_Aging__c aging, SUM(BalanceOwed__c) sum, COUNT(Id) cnt FROM WorkOrder WHERE BalanceOwed__c > 0 GROUP BY Final_Balance_Aging__c ORDER BY Final_Balance_Aging__c NULLS FIRST`
  );
  let buckets = { current: 0, days30: 0, days60: 0, days90: 0, days90Plus: 0, total: 0 };
  for (const row of aging.records) {
    const age = row.aging ?? 0;
    buckets.total += row.sum;
    if (age < 30) buckets.current += row.sum;
    else if (age < 60) buckets.days30 += row.sum;
    else if (age < 90) buckets.days60 += row.sum;
    else if (age < 120) buckets.days90 += row.sum;
    else buckets.days90Plus += row.sum;
  }
  console.log(`  Current (0-29d): ${fmt(buckets.current)} (${(buckets.current/buckets.total*100).toFixed(0)}%)`);
  console.log(`  30-59d:          ${fmt(buckets.days30)} (${(buckets.days30/buckets.total*100).toFixed(0)}%)`);
  console.log(`  60-89d:          ${fmt(buckets.days60)} (${(buckets.days60/buckets.total*100).toFixed(0)}%)`);
  console.log(`  90-119d:         ${fmt(buckets.days90)} (${(buckets.days90/buckets.total*100).toFixed(0)}%)`);
  console.log(`  120+d:           ${fmt(buckets.days90Plus)} (${(buckets.days90Plus/buckets.total*100).toFixed(0)}%)`);
  console.log(`  TOTAL OUTSTANDING: ${fmt(buckets.total)}`);

  // 4. Commission + Discount + Lead Fee
  console.log("\n[4] Commission / Discount / Lead Fee (this month):");
  const commission = await conn.query<{ sum: number }>(
    `SELECT SUM(CommissionAmount__c) sum FROM WorkOrder WHERE CreatedDate = THIS_MONTH`
  );
  const discounts = await conn.query<{ sum: number }>(
    `SELECT SUM(Discount_Given__c) sum FROM Opportunity WHERE CloseDate = THIS_MONTH`
  );
  const leadFee = await conn.query<{ sum: number }>(
    `SELECT SUM(Lead_Fee__c) sum FROM Opportunity WHERE CloseDate = THIS_MONTH`
  );
  console.log(`  Commission paid:   ${fmt(commission.records[0]?.sum ?? 0)}`);
  console.log(`  Discounts given:   ${fmt(discounts.records[0]?.sum ?? 0)}`);
  console.log(`  Lead fees:         ${fmt(leadFee.records[0]?.sum ?? 0)}`);

  // 5. MTD revenue (matches dashboard "Actual captured")
  console.log("\n[5] Month-to-date dashboard reconciliation:");
  const mtdWO = await conn.query<{ sum: number; cnt: number }>(
    `SELECT SUM(NetValue__c) sum, COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = THIS_MONTH`
  );
  const lastMonthWO = await conn.query<{ sum: number; cnt: number }>(
    `SELECT SUM(NetValue__c) sum, COUNT(Id) cnt FROM WorkOrder WHERE CreatedDate = LAST_MONTH`
  );
  const mtd = mtdWO.records[0]?.sum ?? 0;
  const lm = lastMonthWO.records[0]?.sum ?? 0;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const pacePct = (daysElapsed / daysInMonth) * 100;
  const expectedByNow = lm * (pacePct / 100);
  console.log(`  MTD revenue:       ${fmt(mtd)}`);
  console.log(`  Last month total:  ${fmt(lm)}`);
  console.log(`  % of last month:   ${lm > 0 ? ((mtd / lm) * 100).toFixed(1) : 0}%  ← should match "Actual ($) (XX% of last month's $)"`);
  console.log(`  Day ${daysElapsed} of ${daysInMonth} (${pacePct.toFixed(0)}% elapsed)`);
  console.log(`  Expected by today: ${fmt(expectedByNow)}  ← should match "Target $"`);
  console.log(`  Pace status:       ${mtd >= expectedByNow ? "▲ ahead" : "▼ behind"} by ${fmt(Math.abs(mtd - expectedByNow))}`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
