/**
 * Second SF deep-dive — focused on:
 *   - Account: which custom fields exist, what Type values look like, lifetime revenue
 *   - Work_Order_Line_Item__c: schema, color field, supplier field, quantity
 *   - User profiles in this org: what roles/regions/profiles look like in real data
 *
 * Run: npx tsx scripts/sf-deep-dive-2.ts
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

  /* ─── 1. Account schema + sample values ─── */
  console.log("─".repeat(60));
  console.log("ACCOUNT SCHEMA");
  console.log("─".repeat(60));
  const acctMeta = await conn.sobject("Account").describe();
  const customAcct = acctMeta.fields.filter((f) => f.custom);
  for (const f of customAcct) {
    console.log(`  ${f.name} [${f.type}] — "${f.label}"`);
  }
  const acctCnt = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM Account`);
  console.log(`\n  Total accounts: ${acctCnt.records[0]?.cnt}`);

  // Type values (helps us know what "Repeat Customer" looks like in API)
  console.log("\nAccount.Type distribution:");
  try {
    const types = await conn.query<{ Type: string; cnt: number }>(
      `SELECT Type, COUNT(Id) cnt FROM Account GROUP BY Type`
    );
    for (const r of types.records) {
      console.log(`  ${r.cnt}× "${r.Type}"`);
    }
  } catch (e) {
    console.log(`  (failed: ${e})`);
  }

  // Sample account with custom fields
  try {
    const customNames = customAcct.slice(0, 30).map((f) => f.name).join(", ");
    const sample = await conn.query<Record<string, unknown>>(
      `SELECT Id, Name, Type, ${customNames} FROM Account LIMIT 3`
    );
    console.log("\nSample accounts:");
    console.log(JSON.stringify(sample.records, null, 2));
  } catch (e) {
    console.log(`Sample fetch failed: ${e}`);
  }

  /* ─── 2. Work_Order_Line_Item__c (for Phase 2) ─── */
  console.log("\n" + "─".repeat(60));
  console.log("WORK_ORDER_LINE_ITEM__c SCHEMA");
  console.log("─".repeat(60));
  for (const candidate of ["Work_Order_Line_Item__c", "WorkOrderLineItem", "WO_Line_Item__c"]) {
    try {
      const meta = await conn.sobject(candidate).describe();
      const cnt = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${candidate}`);
      console.log(`\n${candidate} (${cnt.records[0]?.cnt} records):`);
      for (const f of meta.fields.filter((f) => f.custom)) {
        console.log(`  ${f.name} [${f.type}] — "${f.label}"`);
      }
      const rels = meta.fields.filter(
        (f) => f.type === "reference" && (f.referenceTo?.includes("WorkOrder") || f.referenceTo?.includes("Opportunity") || f.referenceTo?.some((r) => r.includes("Paint")))
      );
      if (rels.length > 0) {
        console.log("  Relevant references:");
        for (const r of rels) {
          console.log(`    ${r.name} → ${r.referenceTo?.join(",")}`);
        }
      }
      // Sample
      const customNames = meta.fields.filter((f) => f.custom).slice(0, 15).map((f) => f.name).join(", ");
      if (customNames) {
        const sample = await conn.query<Record<string, unknown>>(
          `SELECT Id, ${customNames} FROM ${candidate} LIMIT 3`
        );
        console.log("  Sample:");
        console.log(JSON.stringify(sample.records, null, 2));
      }
      break;
    } catch (e: any) {
      console.log(`\n${candidate}: ${e.message?.slice(0, 80)}`);
    }
  }

  /* ─── 3. PaintColor__c standalone object ───
     CORRECTION 2026-05-22: the object is `PaintColor__c` (one word, not
     Paint_Color__c). Discovered via WorkOrderLineItem relationship probe:
       ColorWall__c → PaintColor__c. */
  console.log("\n" + "─".repeat(60));
  console.log("PAINTCOLOR__c SCHEMA");
  console.log("─".repeat(60));
  for (const candidate of ["PaintColor__c", "Paint_Color__c"]) {
    try {
      const meta = await conn.sobject(candidate).describe();
      const cnt = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${candidate}`);
      console.log(`\n${candidate} (${cnt.records[0]?.cnt} records):`);
      for (const f of meta.fields.filter((f) => f.custom)) {
        console.log(`  ${f.name} [${f.type}] — "${f.label}"`);
      }
      const customNames = meta.fields.filter((f) => f.custom).map((f) => f.name).join(", ");
      if (customNames) {
        const sample = await conn.query<Record<string, unknown>>(
          `SELECT Id, Name, ${customNames} FROM ${candidate} LIMIT 5`
        );
        console.log("  Sample colors:");
        console.log(JSON.stringify(sample.records, null, 2));
      }
      break;
    } catch (e: any) {
      console.log(`${candidate}: ${e.message?.slice(0, 100)}`);
    }
  }

  /* ─── 4. User table — UserRole + Profile distribution ─── */
  console.log("\n" + "─".repeat(60));
  console.log("USER UNIVERSE (active reps)");
  console.log("─".repeat(60));
  const users = await conn.query<{ Id: string; Name: string; UserRole: { Name: string } | null; Profile: { Name: string } | null; Department: string | null; UserType: string }>(
    `SELECT Id, Name, UserRole.Name, Profile.Name, Department, UserType FROM User WHERE IsActive = true LIMIT 200`
  );
  console.log(`\nProfile distribution (active users):`);
  const profileCnts = new Map<string, number>();
  for (const u of users.records) {
    const p = u.Profile?.Name ?? "(none)";
    profileCnts.set(p, (profileCnts.get(p) ?? 0) + 1);
  }
  for (const [p, c] of [...profileCnts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}× ${p}`);
  }
  console.log(`\nRole distribution:`);
  const roleCnts = new Map<string, number>();
  for (const u of users.records) {
    const r = u.UserRole?.Name ?? "(none)";
    roleCnts.set(r, (roleCnts.get(r) ?? 0) + 1);
  }
  for (const [r, c] of [...roleCnts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}× ${r}`);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
