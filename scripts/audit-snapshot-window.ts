/**
 * Quantifies Katie's §A finding: the snapshot pulls Opps/WOs on a 365-day
 * CreatedDate window, but the PFQ-anchored scorecard reports deals by
 * CLOSE/END date. A deal created >365d ago but closed in PFQ is invisible.
 *
 * This measures the ACTUAL undercount against live PPP data for the prior
 * fiscal quarter — so we know if §A is a real problem or theoretical.
 *
 * Also verifies the remaining KPI field assumptions not covered by
 * verify-kpi-alignment.ts (KPI 1 revenue field, KPI 5 appt fields,
 * Review__c shape, quota objects, rep universe).
 *
 * Run: npx tsx scripts/audit-snapshot-window.ts
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
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("system_credentials").select("key, value").in("key", ["sf_refresh_token", "sf_instance_url"]);
  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const conn = new jsforce.Connection({
    instanceUrl: map.sf_instance_url,
    refreshToken: map.sf_refresh_token,
    oauth2: { clientId: process.env.SF_CONSUMER_KEY!, clientSecret: process.env.SF_CONSUMER_SECRET!, loginUrl: process.env.SF_LOGIN_URL! },
    version: "60.0",
  });
  await conn.identity();
  console.log(`Connected: ${map.sf_instance_url}\n`);

  // ── Compute PFQ (prior fiscal quarter). PPP FY = Feb 1 → Jan 31.
  const now = new Date();
  const m = now.getUTCMonth(); // 0-indexed
  const y = now.getUTCFullYear();
  const fyOf = m === 0 ? y - 1 : y;
  const fqOf = m >= 1 && m <= 3 ? 1 : m >= 4 && m <= 6 ? 2 : m >= 7 && m <= 9 ? 3 : 4;
  const pfq = fqOf === 1 ? { fy: fyOf - 1, q: 4 } : { fy: fyOf, q: fqOf - 1 };
  const qStartMonth = { 1: 1, 2: 4, 3: 7, 4: 10 }[pfq.q]!; // 0-indexed UTC month of quarter start
  const pfqStart = new Date(Date.UTC(pfq.q === 4 ? pfq.fy : pfq.fy, qStartMonth, 1));
  const pfqEndMonth = pfq.q === 4 ? 1 : qStartMonth + 3;
  const pfqEndYear = pfq.q === 4 ? pfq.fy + 1 : pfq.fy;
  const pfqEnd = new Date(Date.UTC(pfqEndYear, pfqEndMonth, 1));
  const iso = (d: Date) => d.toISOString().split("T")[0];
  // Snapshot cutoff: CreatedDate >= today - 365d
  const snapCutoff = new Date(now.getTime() - 365 * 86_400_000);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(` §A · Snapshot-window undercount for PFQ = FY${String(pfq.fy).slice(-2)} Q${pfq.q}`);
  console.log(`     PFQ range: ${iso(pfqStart)} → ${iso(pfqEnd)} (exclusive)`);
  console.log(`     Snapshot includes only CreatedDate >= ${iso(snapCutoff)}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // KPI 1/3b/7 — WON opps closed in PFQ. How many created before the snapshot cutoff?
  const wonInPfq = await conn.query<{ cnt: number; total: number }>(
    `SELECT COUNT(Id) cnt, SUM(QuotedSubtotalWithChangeOrder__c) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${iso(pfqStart)} AND CloseDate < ${iso(pfqEnd)}`
  );
  const wonAll = wonInPfq.records[0] as unknown as { cnt: number; total: number };
  const wonMissed = await conn.query<{ cnt: number; total: number }>(
    `SELECT COUNT(Id) cnt, SUM(QuotedSubtotalWithChangeOrder__c) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${iso(pfqStart)} AND CloseDate < ${iso(pfqEnd)} AND CreatedDate < ${iso(snapCutoff)}T00:00:00Z`
  );
  const wonMiss = wonMissed.records[0] as unknown as { cnt: number; total: number };
  console.log("── KPI 1 Revenue (WON opps closed in PFQ) ──");
  console.log(`   Total won in PFQ:        ${wonAll.cnt} opps · $${(wonAll.total ?? 0).toFixed(2)}`);
  console.log(`   MISSED (created >365d):  ${wonMiss.cnt} opps · $${(wonMiss.total ?? 0).toFixed(2)}`);
  const pctMissedCnt = wonAll.cnt > 0 ? (wonMiss.cnt / wonAll.cnt) * 100 : 0;
  const pctMissedRev = (wonAll.total ?? 0) > 0 ? ((wonMiss.total ?? 0) / (wonAll.total ?? 1)) * 100 : 0;
  console.log(`   → undercount: ${pctMissedCnt.toFixed(1)}% of deals, ${pctMissedRev.toFixed(1)}% of revenue\n`);

  // KPI 7 — completed WOs (EndDate in PFQ) created before cutoff.
  // EndDate is a dateTime field → use full ISO datetime, unquoted.
  const dt = (d: Date) => `${iso(d)}T00:00:00Z`;
  const woInPfq = await conn.query<{ cnt: number }>(
    `SELECT COUNT(Id) cnt FROM WorkOrder WHERE (Status = 'Closed' OR Status = 'Complete Paid in Full') AND EndDate >= ${dt(pfqStart)} AND EndDate < ${dt(pfqEnd)}`
  );
  const woAll = woInPfq.records[0] as unknown as { cnt: number };
  const woMissed = await conn.query<{ cnt: number }>(
    `SELECT COUNT(Id) cnt FROM WorkOrder WHERE (Status = 'Closed' OR Status = 'Complete Paid in Full') AND EndDate >= ${dt(pfqStart)} AND EndDate < ${dt(pfqEnd)} AND CreatedDate < ${dt(snapCutoff)}`
  );
  const woAllN = woAll.cnt;
  const woMissN = (woMissed.records[0] as unknown as { cnt: number }).cnt;
  console.log("── KPI 7 Jobs Completed (WOs Closed/Paid w/ EndDate in PFQ) ──");
  console.log(`   Total completed in PFQ:  ${woAllN} WOs`);
  console.log(`   MISSED (created >365d):  ${woMissN} WOs`);
  console.log(`   → undercount: ${woAllN > 0 ? ((woMissN / woAllN) * 100).toFixed(1) : "0"}% of completed jobs\n`);

  // KPI 6 Pipeline — open opps created before cutoff (all-time open, but snapshot only has 365d)
  const openAll = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Opportunity WHERE IsClosed = false`);
  const openMissed = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Opportunity WHERE IsClosed = false AND CreatedDate < ${iso(snapCutoff)}T00:00:00Z`);
  const openAllN = (openAll.records[0] as unknown as { cnt: number }).cnt;
  const openMissN = (openMissed.records[0] as unknown as { cnt: number }).cnt;
  console.log("── KPI 6 Pipeline (open opps, snapshot-wide) ──");
  console.log(`   Total open now:          ${openAllN} opps`);
  console.log(`   MISSED (created >365d):  ${openMissN} opps`);
  console.log(`   → undercount: ${openAllN > 0 ? ((openMissN / openAllN) * 100).toFixed(1) : "0"}% of open pipeline\n`);

  // ── Field-existence sanity for the KPIs not covered by verify-kpi-alignment.ts
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(" KPI field existence (KPI 1/5/6 + Reviews + Quotas + rep universe)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const oppMeta = await conn.describe("Opportunity");
  const need = ["QuotedSubtotalWithChangeOrder__c", "AppointmentDate__c", "Estimate_Sent__c", "Date_Estimate_Sent__c", "LeadGroup__c", "CancelledAppointment__c"];
  for (const f of need) {
    const found = oppMeta.fields.find((x) => x.name === f);
    console.log(`   Opportunity.${f}: ${found ? `✅ (${found.type})` : "❌ NOT FOUND"}`);
  }

  // Review object
  try {
    const revMeta = await conn.describe("Review__c");
    const revFields = ["Account__c", "Removed__c"].map((f) => `${f}:${revMeta.fields.some((x) => x.name === f) ? "✅" : "❌"}`);
    console.log(`   Review__c exists ✅ — ${revFields.join("  ")}`);
    const revCount = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Review__c WHERE CreatedDate >= ${iso(pfqStart)} AND CreatedDate < ${iso(pfqEnd)}`);
    console.log(`   Reviews created in PFQ: ${(revCount.records[0] as unknown as { cnt: number }).cnt}`);
  } catch {
    console.log(`   Review__c: ❌ describe failed`);
  }

  // Quota objects
  for (const obj of ["TotalQuota__c", "SubQuota__c"]) {
    try {
      const c = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${obj}`);
      console.log(`   ${obj}: ✅ ${(c.records[0] as unknown as { cnt: number }).cnt} rows`);
    } catch {
      console.log(`   ${obj}: ❌ not queryable`);
    }
  }

  console.log("\n── Done. §A undercount numbers above tell us if a re-window is worth it. ──");
}
main().catch((e) => { console.error(e); process.exit(1); });
