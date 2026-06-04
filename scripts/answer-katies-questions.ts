/**
 * Probe PPP's Salesforce for the three schema questions Katie raised:
 *   1. WorkOrderLineItem.Status — standard or custom? Picklist values?
 *   2. WorkOrder.Material_Type__c — picklist values?
 *   3. PaintColor__c.Product_Line__c — does it exist?
 *
 * Run: npx tsx scripts/answer-katies-questions.ts
 */

import { readFileSync } from "fs";

// Load .env.local
try {
  const envText = readFileSync(".env.local", "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch {
  console.warn("⚠️  No .env.local found — relying on shell env vars");
}

import jsforce from "jsforce";
import { createClient } from "@supabase/supabase-js";

type SfField = {
  name: string;
  type: string;
  label?: string;
  picklistValues?: Array<{ value: string; label: string; active: boolean; defaultValue: boolean }>;
};

async function getConn(): Promise<InstanceType<typeof jsforce.Connection>> {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } }
  );
  const { data } = await sb
    .from("system_credentials")
    .select("key, value")
    .in("key", ["sf_refresh_token", "sf_instance_url"]);
  const creds = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  if (!creds.sf_refresh_token) throw new Error("No sf_refresh_token in Supabase");

  const oauth2 = new jsforce.OAuth2({
    clientId: process.env.SF_CONSUMER_KEY!,
    clientSecret: process.env.SF_CONSUMER_SECRET!,
    loginUrl: process.env.SF_LOGIN_URL ?? "https://login.salesforce.com",
  });
  const conn = new jsforce.Connection({
    oauth2,
    instanceUrl: creds.sf_instance_url,
    refreshToken: creds.sf_refresh_token,
  });
  await conn.oauth2.refreshToken(creds.sf_refresh_token);
  return conn;
}

function picklistSummary(field: SfField | undefined): string {
  if (!field) return "<field not found>";
  if (!field.picklistValues || field.picklistValues.length === 0) {
    return `type=${field.type} (no picklist)`;
  }
  const active = field.picklistValues.filter((v) => v.active);
  return `type=${field.type}, ${active.length} active values:\n    - ${active.map((v) => `${v.value}${v.defaultValue ? " (default)" : ""}`).join("\n    - ")}`;
}

async function main() {
  console.log("🔌 Connecting to PPP Salesforce…\n");
  const conn = await getConn();
  console.log(`✓ Connected. Instance: ${conn.instanceUrl}\n`);

  // ── Q1: WorkOrderLineItem.Status ─────────────────────────────────────
  console.log("═══ Q1: WorkOrderLineItem Status field ═══");
  try {
    const woli = await conn.sobject("WorkOrderLineItem").describe();
    const statusFields = (woli.fields as unknown as SfField[]).filter((f) =>
      f.name.toLowerCase().includes("status")
    );
    console.log(`Found ${statusFields.length} status-named field(s) on WorkOrderLineItem:`);
    for (const f of statusFields) {
      console.log(`\n  ✦ ${f.name} (label: "${f.label}")`);
      console.log(`    ${picklistSummary(f)}`);
    }
  } catch (err) {
    console.error("  ✗ WorkOrderLineItem describe failed:", err instanceof Error ? err.message : err);
  }

  // ── Q2: WorkOrder.Material_Type__c picklist ──────────────────────────
  console.log("\n═══ Q2: WorkOrder Material_Type__c (and any material-named fields) ═══");
  try {
    const wo = await conn.sobject("WorkOrder").describe();
    const materialFields = (wo.fields as unknown as SfField[]).filter((f) =>
      f.name.toLowerCase().includes("material") || f.name.toLowerCase().includes("product")
    );
    console.log(`Found ${materialFields.length} material/product-named field(s) on WorkOrder:`);
    for (const f of materialFields) {
      console.log(`\n  ✦ ${f.name} (label: "${f.label}")`);
      console.log(`    ${picklistSummary(f)}`);
    }
  } catch (err) {
    console.error("  ✗ WorkOrder describe failed:", err instanceof Error ? err.message : err);
  }

  // ── Q3: PaintColor__c.Product_Line__c existence ──────────────────────
  console.log("\n═══ Q3: PaintColor__c — does Product_Line__c exist? ═══");
  try {
    const pc = await conn.sobject("PaintColor__c").describe();
    const fields = pc.fields as unknown as SfField[];
    const productLine = fields.find((f) => f.name === "Product_Line__c");
    if (productLine) {
      console.log(`✓ Product_Line__c EXISTS:`);
      console.log(`    ${picklistSummary(productLine)}`);
    } else {
      console.log("✗ Product_Line__c does NOT exist on PaintColor__c");
      const productish = fields.filter((f) =>
        f.name.toLowerCase().includes("product") || f.name.toLowerCase().includes("line") || f.name.toLowerCase().includes("series")
      );
      if (productish.length > 0) {
        console.log("\n  Related field candidates that DO exist:");
        for (const f of productish) {
          console.log(`    - ${f.name} (label: "${f.label}", type=${f.type})`);
        }
      } else {
        console.log("\n  No product/line/series-related custom fields found either.");
      }
    }
  } catch (err) {
    console.error("  ✗ PaintColor__c describe failed:", err instanceof Error ? err.message : err);
  }

  console.log("\n✓ Done.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
