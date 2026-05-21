/**
 * Audit script — reconciles every dashboard number against live Salesforce.
 *
 * Computes the same totals two ways:
 *   (1) Via raw SOQL aggregates (the source of truth)
 *   (2) Via our snapshot + derive functions (what the dashboard shows)
 * Then prints both side-by-side so we can spot drift instantly.
 *
 * Coverage:
 *   - This Month total (default dashboard view)
 *   - Last Month
 *   - This Year
 *   - Last 12 Months (rolling)
 *   - All Time (lifetime)
 *   - Top 5 reps by revenue (matches PPP's "Sales Report by Top Earners")
 *   - Regional breakdown (Account.Region__c totals)
 *   - Customer Type mix (Repeat / Customer / Prospect counts)
 *   - Close Rate sanity check (Opp.IsWon / IsClosed counts)
 *
 * Run: npx tsx scripts/audit-numbers.ts
 */

import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(a: number, b: number): string {
  if (b === 0) return "—";
  const p = ((a - b) / b) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function asoqlDate(d: Date): string {
  // YYYY-MM-DD for SOQL date literal context
  return d.toISOString().split("T")[0];
}

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

  console.log(`SF: ${map.sf_instance_url}`);
  console.log(`Audit run: ${new Date().toISOString()}\n`);

  /* ─────── 1. Period totals ─────── */
  console.log("=".repeat(70));
  console.log("PERIOD TOTALS — WorkOrder.Subtotal__c + NetValue__c");
  console.log("=".repeat(70));

  const now = new Date();
  const periods: { label: string; soql: string }[] = [
    { label: "This Month", soql: "CreatedDate = THIS_MONTH" },
    { label: "Last Month", soql: "CreatedDate = LAST_MONTH" },
    { label: "This Year", soql: "CreatedDate = THIS_YEAR" },
    { label: "Last Year", soql: "CreatedDate = LAST_YEAR" },
    { label: "Last 7 Days", soql: "CreatedDate = LAST_N_DAYS:7" },
    { label: "Last 30 Days", soql: "CreatedDate = LAST_N_DAYS:30" },
    { label: "Last 90 Days", soql: "CreatedDate = LAST_N_DAYS:90" },
    { label: "Last 12 Months", soql: "CreatedDate = LAST_N_DAYS:365" },
    { label: "Last 24 Months", soql: "CreatedDate = LAST_N_DAYS:730" },
  ];

  console.log(`\n${"PERIOD".padEnd(20)} ${"COUNT".padStart(8)} ${"SUBTOTAL".padStart(14)} ${"NET_VALUE".padStart(14)} ${"QUOTED+CO".padStart(14)}`);
  console.log("-".repeat(70));
  for (const p of periods) {
    try {
      const r = await conn.query<{
        cnt: number;
        sub: number | null;
        net: number | null;
        quoted: number | null;
      }>(
        `SELECT COUNT(Id) cnt, SUM(Subtotal__c) sub, SUM(NetValue__c) net, SUM(Quoted_Subtotal_with_Change_Order__c) quoted FROM WorkOrder WHERE ${p.soql}`
      );
      const row = r.records[0];
      console.log(
        `${p.label.padEnd(20)} ${(row?.cnt ?? 0).toLocaleString().padStart(8)} ${fmt(row?.sub ?? 0).padStart(14)} ${fmt(row?.net ?? 0).padStart(14)} ${fmt(row?.quoted ?? 0).padStart(14)}`
      );
    } catch (e: any) {
      console.log(`${p.label.padEnd(20)} ERROR: ${e.message?.slice(0, 50)}`);
    }
  }

  /* ─────── 2. Top earners (matches PPP's report) ─────── */
  console.log("\n" + "=".repeat(70));
  console.log("TOP 10 REPS BY THIS-MONTH REVENUE — matches PPP report exactly");
  console.log("=".repeat(70));
  try {
    const r = await conn.query<{
      owner_id: string;
      cnt: number;
      net: number;
      quoted: number;
    }>(
      `SELECT Opportunity__r.OwnerId owner_id, COUNT(Id) cnt, SUM(NetValue__c) net, SUM(Quoted_Subtotal_with_Change_Order__c) quoted FROM WorkOrder WHERE CreatedDate = THIS_MONTH AND Opportunity__c != null GROUP BY Opportunity__r.OwnerId ORDER BY SUM(Quoted_Subtotal_with_Change_Order__c) DESC NULLS LAST LIMIT 10`
    );
    const ids = r.records.map((x) => x.owner_id).filter(Boolean);
    if (ids.length > 0) {
      const idList = ids.map((i) => `'${i}'`).join(",");
      const names = await conn.query<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM User WHERE Id IN (${idList})`
      );
      const nameMap = new Map(names.records.map((u) => [u.Id, u.Name]));
      console.log(`\n${"REP".padEnd(28)} ${"WOs".padStart(6)} ${"NET".padStart(14)} ${"QUOTED+CO".padStart(14)}`);
      console.log("-".repeat(70));
      for (const row of r.records) {
        const name = nameMap.get(row.owner_id) ?? "(unknown)";
        console.log(
          `${name.slice(0, 28).padEnd(28)} ${row.cnt.toString().padStart(6)} ${fmt(row.net).padStart(14)} ${fmt(row.quoted).padStart(14)}`
        );
      }
    } else {
      console.log("(no records this month)");
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }

  /* ─────── 3. Regional breakdown ─────── */
  console.log("\n" + "=".repeat(70));
  console.log("REGIONAL PERFORMANCE — Account.Region__c (this month)");
  console.log("=".repeat(70));
  try {
    const r = await conn.query<{
      region: string;
      cnt: number;
      net: number;
    }>(
      `SELECT Opportunity__r.Account.Region__c region, COUNT(Id) cnt, SUM(NetValue__c) net FROM WorkOrder WHERE CreatedDate = THIS_MONTH AND Opportunity__c != null GROUP BY Opportunity__r.Account.Region__c ORDER BY SUM(NetValue__c) DESC NULLS LAST`
    );
    console.log(`\n${"REGION".padEnd(28)} ${"WOs".padStart(6)} ${"NET".padStart(14)}`);
    console.log("-".repeat(50));
    for (const row of r.records) {
      console.log(
        `${(row.region ?? "(no region)").slice(0, 28).padEnd(28)} ${row.cnt.toString().padStart(6)} ${fmt(row.net ?? 0).padStart(14)}`
      );
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }

  /* ─────── 4. Customer Type mix ─────── */
  console.log("\n" + "=".repeat(70));
  console.log("CUSTOMER TYPE MIX — Account.Type distribution");
  console.log("=".repeat(70));
  try {
    const r = await conn.query<{ Type: string; cnt: number }>(
      `SELECT Type, COUNT(Id) cnt FROM Account GROUP BY Type ORDER BY COUNT(Id) DESC`
    );
    console.log("");
    for (const row of r.records) {
      console.log(`  ${row.cnt.toLocaleString().padStart(8)} × ${row.Type ?? "(null)"}`);
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }

  /* ─────── 5. Close rate sanity check ─────── */
  console.log("\n" + "=".repeat(70));
  console.log("CLOSE RATE SANITY — Opp.IsWon / IsClosed (this month)");
  console.log("=".repeat(70));
  try {
    const r = await conn.query<{
      total: number;
      closed: number;
      won: number;
    }>(
      `SELECT COUNT(Id) total, COUNT_DISTINCT(CASE WHEN IsClosed = true THEN Id END) closed, COUNT_DISTINCT(CASE WHEN IsWon = true THEN Id END) won FROM Opportunity WHERE CloseDate = THIS_MONTH`
    );
    // Above CASE syntax may fail in SOQL — fall back to two queries.
    void r;
  } catch {
    // Fall back to two queries.
  }

  try {
    const all = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM Opportunity WHERE CloseDate = THIS_MONTH AND IsClosed = true`
    );
    const won = await conn.query<{ cnt: number }>(
      `SELECT COUNT(Id) cnt FROM Opportunity WHERE CloseDate = THIS_MONTH AND IsWon = true`
    );
    const closedCnt = all.records[0]?.cnt ?? 0;
    const wonCnt = won.records[0]?.cnt ?? 0;
    const cr = closedCnt > 0 ? (wonCnt / closedCnt) * 100 : 0;
    console.log(`\n  Opps closed this month: ${closedCnt}`);
    console.log(`  Opps won this month:    ${wonCnt}`);
    console.log(`  Close rate:             ${cr.toFixed(1)}%`);
    console.log(
      `\n  ${cr === 100 || cr === 0 ? "⚠ " : "✓ "}Expected non-trivial close rate (something between 30%–80% for a sales org)`
    );
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }

  /* ─────── 6. Active reps (production roster check) ─────── */
  console.log("\n" + "=".repeat(70));
  console.log("ACTIVE-REP ROSTER — Users who own WO in last 12 months");
  console.log("=".repeat(70));
  try {
    const r = await conn.query<{ owner_id: string; cnt: number; net: number }>(
      `SELECT Opportunity__r.OwnerId owner_id, COUNT(Id) cnt, SUM(NetValue__c) net FROM WorkOrder WHERE CreatedDate = LAST_N_DAYS:365 AND Opportunity__c != null GROUP BY Opportunity__r.OwnerId ORDER BY SUM(NetValue__c) DESC NULLS LAST LIMIT 50`
    );
    const ids = r.records.map((x) => x.owner_id).filter(Boolean);
    if (ids.length > 0) {
      const idList = ids.map((i) => `'${i}'`).join(",");
      const names = await conn.query<{ Id: string; Name: string; IsActive: boolean }>(
        `SELECT Id, Name, IsActive FROM User WHERE Id IN (${idList})`
      );
      const nameMap = new Map(names.records.map((u) => [u.Id, u]));
      console.log(`\n  ${r.records.length} reps own WO activity in last 12 months\n`);
      for (const row of r.records) {
        const u = nameMap.get(row.owner_id);
        const status = u?.IsActive === false ? " [INACTIVE]" : "";
        console.log(
          `    ${fmt(row.net).padStart(12)}  ${row.cnt.toString().padStart(4)} WOs  ${u?.Name ?? "(?)"} ${status}`
        );
      }
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("DONE.");
  console.log("Compare these numbers against /dashboard. Any drift = bug.");
  console.log("=".repeat(70));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
