/**
 * Port readiness, against the real database.
 *
 * The numbers are being ported to AWS. The dangerous half-hour is the one
 * where a number is live, a workflow gets switched on, and Kate's Hatch
 * opt-out export still has not been imported — every person who told Hatch to
 * stop would be textable, and an empty suppression list cannot refuse anybody.
 *
 * So this checks the rail with the real gate and the real table, and then
 * prints where every live workspace stands. It sends nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { gatedSend } from "../lib/messaging/gate.ts";
import { gateDeps, clearSuppressionListCache } from "../lib/messaging/gate-deps.ts";
import { transportChoice } from "../lib/messaging/transport-config.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

// Area code 999 is reserved and assigned to nobody.
const PROBE = "+19992220188";
const MIDDAY = new Date(new Date().toISOString().slice(0, 10) + "T16:00:00.000Z");
let added = false;

try {
  console.log(`\nPORT READINESS — real schema\n`);

  const { count: optOuts } = await sb.from("sms_opt_outs").select("*", { count: "exact", head: true });
  // The whole row: the gate reads quiet hours and the weekend policy off it,
  // and a workspace missing them has no sendable hour at all — which is how
  // this script threw "check quiet-hours config" at a perfectly good config.
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164, is_active, autosend_enabled, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends")
    .eq("is_active", true).order("name");
  const { data: flows } = await sb.from("sms_workflows").select("workspace_id, is_active, campaign_id");

  /* ── The rail ───────────────────────────────────────────────── */
  const workspace = ws[0];
  const send = () => gatedSend(
    { workspace, to: "+19992220189", body: "This is Precision Painting Plus. Reply STOP to opt out.", agent: "campaign", now: MIDDAY },
    gateDeps(sb),
  );

  clearSuppressionListCache();
  const withEmptyList = await send();
  if ((optOuts ?? 0) === 0) {
    ok("with no opt-out list loaded, the gate refuses every send",
       !withEmptyList.ok && withEmptyList.reason === "suppression_list_empty", JSON.stringify(withEmptyList));
  } else {
    ok(`the opt-out list is loaded (${optOuts} rows), so the rail is satisfied`,
       withEmptyList.ok || withEmptyList.reason !== "suppression_list_empty", JSON.stringify(withEmptyList));
  }

  // A list with something in it lifts the rail. Written and removed here.
  if ((optOuts ?? 0) === 0) {
    const { error } = await sb.from("sms_opt_outs").insert({
      phone_e164: PROBE, channel: "sms", source: "manual", opted_out_at: new Date().toISOString(),
    });
    if (error) throw new Error(`could not write a probe opt-out: ${error.message}`);
    added = true;
    clearSuppressionListCache();
    const withList = await send();
    ok("with a list, sending is allowed again", withList.ok, JSON.stringify(withList));

    const toTheSuppressed = await gatedSend(
      { workspace, to: PROBE, body: "This is Precision Painting Plus. Reply STOP to opt out.", agent: "campaign", now: MIDDAY },
      gateDeps(sb),
    );
    ok("and the person on the list is still refused",
       !toTheSuppressed.ok && toTheSuppressed.reason === "suppressed", JSON.stringify(toTheSuppressed));
  }

  /* ── Where each workspace stands ────────────────────────────── */
  const bad = ws.filter((w) => !w.phone_e164 || !/^\+1[2-9]\d{9}$/.test(w.phone_e164));
  ok("every live workspace has a usable US number", bad.length === 0, bad.map((w) => w.name).join(", "));
  const numbers = ws.map((w) => w.phone_e164);
  ok("no two workspaces share a number", new Set(numbers).size === numbers.length);

  const onFlows = (flows ?? []).filter((f) => f.is_active);
  ok("no workflow is switched on yet (nothing enters a campaign)", onFlows.length === 0,
     onFlows.length ? `${onFlows.length} active` : "");
  const autosend = ws.filter((w) => w.autosend_enabled);
  ok("autosend is off everywhere (every reply waits for a person)", autosend.length === 0,
     autosend.map((w) => w.name).join(", "));

  const t = transportChoice();
  console.log(`\n  carrier, as this machine sees it: ${t.live ? "LIVE — messages reach real phones" : "off — " + t.why}`);
  console.log(`  opt-outs loaded: ${optOuts}`);
  console.log(`\n  live workspaces (${ws.length}), in porting order — Nassau first:`);
  const order = [...ws].sort((a, b) => (a.name.includes("Nassau") ? -1 : b.name.includes("Nassau") ? 1 : a.name.localeCompare(b.name)));
  for (const w of order) {
    const mine = (flows ?? []).filter((f) => f.workspace_id === w.id);
    console.log(`    ${w.phone_e164}  ${w.name.padEnd(22)} workflows: ${mine.length} (${mine.filter((f) => f.is_active).length} on)  autosend: ${w.autosend_enabled ? "ON" : "off"}`);
  }

} catch (err) {
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (added) await sb.from("sms_opt_outs").delete().eq("phone_e164", PROBE);
  clearSuppressionListCache();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
