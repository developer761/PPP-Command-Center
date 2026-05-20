/**
 * One-off diagnostic — runs against the live PPP Salesforce org via the
 * stored refresh token. Tells us definitively:
 *   - Which custom currency fields live on Opportunity vs WorkOrder vs Work_Order__c
 *   - Where Net_Value/Quoted_Subtotal actually live
 *   - How WorkOrder ↔ Opportunity is related (lookup field name)
 *   - Total record counts
 *   - Aggregate revenue across each candidate field
 *   - The exact owner-name list (= our rep universe)
 *
 * Run with: npx tsx scripts/sf-deep-dive.ts
 */

import { readFileSync } from "fs";

// Load .env.local manually
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

  const { data, error } = await sb
    .from("system_credentials")
    .select("key, value")
    .in("key", ["sf_refresh_token", "sf_instance_url", "sf_connected_at"]);

  if (error || !data) {
    console.error("No SF credentials stored.", error);
    process.exit(1);
  }
  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
  if (!map.sf_refresh_token || !map.sf_instance_url) {
    console.error("Missing sf_refresh_token / sf_instance_url");
    process.exit(1);
  }

  console.log(`SF instance: ${map.sf_instance_url}`);
  console.log(`Connected at: ${map.sf_connected_at}\n`);

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

  // Force a token refresh so we have a live access token.
  const refreshed = await conn.oauth2.refreshToken(map.sf_refresh_token);
  conn.accessToken = (refreshed as { access_token: string }).access_token;

  /* ─────────── 1. Where does Net_Value__c live? ─────────── */
  console.log("─".repeat(60));
  console.log("1. Custom currency fields per object");
  console.log("─".repeat(60));

  for (const obj of ["Opportunity", "WorkOrder", "Work_Order__c", "Quote"]) {
    try {
      const meta = await conn.sobject(obj).describe();
      const currency = meta.fields.filter(
        (f) => f.custom && (f.type === "currency" || f.type === "double")
      );
      const cnt = await conn.query<{ cnt: number }>(`SELECT COUNT(Id) cnt FROM ${obj}`);
      console.log(`\n${obj} (${cnt.records[0]?.cnt ?? 0} records):`);
      for (const f of currency) {
        console.log(`  • ${f.name} [${f.type}] — "${f.label}"`);
      }
      // Find relationship fields that point to Opportunity (for joining)
      const rels = meta.fields.filter(
        (f) => f.type === "reference" && f.referenceTo?.includes("Opportunity")
      );
      if (rels.length > 0) {
        console.log(`  → Opportunity refs: ${rels.map((r) => r.name).join(", ")}`);
      }
    } catch (e: any) {
      console.log(`\n${obj}: error — ${e.message}`);
    }
  }

  /* ─────────── 2. Aggregate sums on each object ─────────── */
  console.log("\n" + "─".repeat(60));
  console.log("2. SUM of each custom currency field");
  console.log("─".repeat(60));

  for (const obj of ["Opportunity", "WorkOrder", "Work_Order__c"]) {
    try {
      const meta = await conn.sobject(obj).describe();
      const currency = meta.fields
        .filter((f) => f.custom && (f.type === "currency" || f.type === "double"))
        .slice(0, 20);
      if (currency.length === 0) {
        console.log(`\n${obj}: no custom currency fields`);
        continue;
      }
      const aggs = currency.map((f) => `SUM(${f.name}) ${f.name.toLowerCase()}_sum`).join(", ");
      const result = await conn.query<Record<string, number | null>>(
        `SELECT ${aggs} FROM ${obj}`
      );
      const row = result.records[0] ?? {};
      console.log(`\n${obj}:`);
      const sorted = currency
        .map((f) => ({ name: f.name, sum: row[`${f.name.toLowerCase()}_sum`] }))
        .filter((x) => typeof x.sum === "number" && (x.sum ?? 0) > 0)
        .sort((a, b) => (b.sum ?? 0) - (a.sum ?? 0));
      for (const x of sorted) {
        console.log(`  $${(x.sum ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}  ${x.name}`);
      }
    } catch (e: any) {
      console.log(`\n${obj}: error — ${e.message}`);
    }
  }

  /* ─────────── 3. WO ↔ Opportunity join ─────────── */
  console.log("\n" + "─".repeat(60));
  console.log("3. Try sample WorkOrder → Opportunity → Owner");
  console.log("─".repeat(60));

  for (const obj of ["WorkOrder", "Work_Order__c"]) {
    try {
      const meta = await conn.sobject(obj).describe();
      const rels = meta.fields.filter(
        (f) => f.type === "reference" && f.referenceTo?.includes("Opportunity")
      );
      if (rels.length === 0) {
        console.log(`\n${obj}: no Opportunity lookup`);
        continue;
      }
      const oppLookup = rels[0].name;
      const oppRelName = rels[0].relationshipName;
      const currency = meta.fields.filter(
        (f) => f.custom && (f.type === "currency" || f.type === "double")
      );
      const currencySelect = currency.slice(0, 8).map((f) => f.name).join(", ");
      const sample = await conn.query<Record<string, unknown>>(
        `SELECT Id, ${currencySelect ? currencySelect + ", " : ""}${oppLookup}, ${oppRelName}.Name, ${oppRelName}.Owner.Name, ${oppRelName}.CloseDate FROM ${obj} WHERE ${oppLookup} != null LIMIT 5`
      );
      console.log(`\n${obj}.${oppLookup} → ${oppRelName}:`);
      console.log(JSON.stringify(sample.records, null, 2));
    } catch (e: any) {
      console.log(`\n${obj}: error — ${e.message}`);
    }
  }

  /* ─────────── 4. Owner / rep universe ─────────── */
  console.log("\n" + "─".repeat(60));
  console.log("4. Sales-rep owner universe (from opps that have revenue)");
  console.log("─".repeat(60));

  // Try aggregating opp owners by net value (if Net_Value lives on Opp at all)
  for (const obj of ["Opportunity", "WorkOrder", "Work_Order__c"]) {
    try {
      const meta = await conn.sobject(obj).describe();
      const ownerField = meta.fields.find((f) => f.name === "OwnerId");
      const oppRef = meta.fields.find((f) => f.type === "reference" && f.referenceTo?.includes("Opportunity"));
      const currencyTop = meta.fields
        .filter((f) => f.custom && (f.type === "currency" || f.type === "double"))
        .filter((f) => /net|value|subtotal|quoted/i.test(f.name))
        .slice(0, 2);
      if (currencyTop.length === 0) continue;

      const groupOwner = ownerField
        ? "OwnerId"
        : oppRef
          ? `${oppRef.relationshipName}.OwnerId`
          : null;
      if (!groupOwner) {
        console.log(`\n${obj}: no owner field found`);
        continue;
      }

      for (const cf of currencyTop) {
        const q = `SELECT ${groupOwner} owner_id, SUM(${cf.name}) total FROM ${obj} GROUP BY ${groupOwner} ORDER BY SUM(${cf.name}) DESC NULLS LAST LIMIT 30`;
        try {
          const r = await conn.query<{ owner_id: string; total: number }>(q);
          console.log(`\n${obj} grouped by ${groupOwner}, SUM(${cf.name}):`);
          // Resolve owner names
          const ids = r.records.map((x) => x.owner_id).filter(Boolean);
          if (ids.length > 0) {
            const idList = ids.map((i) => `'${i}'`).join(",");
            const names = await conn.query<{ Id: string; Name: string }>(
              `SELECT Id, Name FROM User WHERE Id IN (${idList})`
            );
            const nameMap = new Map(names.records.map((u) => [u.Id, u.Name]));
            for (const row of r.records) {
              const n = nameMap.get(row.owner_id) ?? row.owner_id;
              console.log(`  $${(row.total ?? 0).toLocaleString()}  ${n}`);
            }
          }
        } catch (e: any) {
          console.log(`  (query failed: ${e.message})`);
        }
      }
    } catch {}
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
