/**
 * One-time cleanup — wipe the sandbox SF refresh token + instance URL from the
 * Supabase system_credentials table so the next Reconnect cleanly authorizes
 * against production (the sandbox refresh token is invalid for the production
 * Connected App).
 *
 * Run: npx tsx scripts/clear-sandbox-sf-creds.ts
 */

import { readFileSync } from "fs";
const envText = readFileSync(".env.local", "utf-8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import { createClient } from "@supabase/supabase-js";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } }
  );

  const keys = ["sf_refresh_token", "sf_instance_url", "sf_connected_at"];
  const { data: before } = await sb
    .from("system_credentials")
    .select("key, value")
    .in("key", keys);
  console.log(`Before:`, before?.map((r) => `${r.key}=${r.value.slice(0, 40)}…`));

  const { error } = await sb.from("system_credentials").delete().in("key", keys);
  if (error) {
    console.error("Failed:", error);
    process.exit(1);
  }
  console.log("Cleared. Next Reconnect on /dashboard/integrations will OAuth fresh against production.");
}

main().catch((e) => { console.error(e); process.exit(1); });
