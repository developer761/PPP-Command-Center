/**
 * Find ALL fields with usable lat/lng data on Opp + Account + WO.
 * Karan's Map tab shows 0 jobs — diagnostic to find the right source.
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

  for (const obj of ["Opportunity", "Account", "WorkOrder"]) {
    console.log(`\n=== ${obj} — all geolocation/address fields ===`);
    try {
      const meta = await conn.sobject(obj).describe();
      const geoFields = meta.fields.filter(
        (f) =>
          /lat|long|geo|coord/i.test(f.name) ||
          f.type === "location" ||
          (f.name.includes("Address") && (f.type === "address" || f.type === "double"))
      );
      for (const f of geoFields) {
        console.log(`  ${f.name.padEnd(45)} [${f.type}]  "${f.label}"`);
      }

      // For each candidate, count non-null
      const subjectFilters: Record<string, string> = {
        Opportunity: "CreatedDate = LAST_N_DAYS:365 AND Amount > 0",
        Account: "Total_Lifetime_Revenue__c > 0",
        WorkOrder: "CreatedDate = LAST_N_DAYS:365",
      };
      for (const f of geoFields) {
        if (f.type === "address" || f.type === "location") continue; // can't filter compound fields
        try {
          const r = await conn.query<{ cnt: number }>(
            `SELECT COUNT(Id) cnt FROM ${obj} WHERE ${f.name} != null AND ${subjectFilters[obj]}`
          );
          const c = r.records[0]?.cnt ?? 0;
          if (c > 0) console.log(`    ↳ ${c.toLocaleString()} records with ${f.name} populated`);
        } catch (err: any) {
          // Some fields can't be filtered
        }
      }

      // Sample one populated record per object
      const lat = geoFields.find((f) => /latitude/i.test(f.name) && f.type === "double");
      const lng = geoFields.find((f) => /longitude/i.test(f.name) && f.type === "double");
      if (lat && lng) {
        try {
          const sample = await conn.query<Record<string, unknown>>(
            `SELECT Id, Name, ${lat.name}, ${lng.name} FROM ${obj} WHERE ${lat.name} != null AND ${lng.name} != null LIMIT 3`
          );
          if (sample.records.length > 0) {
            console.log(`    ↳ Sample records:`);
            for (const r of sample.records) {
              console.log(`        ${r.Id}: ${r[lat.name]}, ${r[lng.name]}  (${r.Name})`);
            }
          }
        } catch {}
      }

      // Also try the standard address fields on Account (BillingLatitude/Longitude)
      if (obj === "Account") {
        for (const f of ["BillingLatitude", "BillingLongitude", "ShippingLatitude", "ShippingLongitude"]) {
          try {
            const r = await conn.query<{ cnt: number }>(
              `SELECT COUNT(Id) cnt FROM Account WHERE ${f} != null`
            );
            const c = r.records[0]?.cnt ?? 0;
            console.log(`  ${f.padEnd(45)} [auto]  ${c.toLocaleString()} populated`);
          } catch {}
        }
      }
    } catch (e: any) {
      console.log(`  ERROR: ${e.message?.slice(0, 100)}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
