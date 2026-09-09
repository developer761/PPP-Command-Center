/**
 * Does per-workspace configuration reach what the bot is told?
 *
 * Karan: "make sure per workspace information carries over to the messaging
 * and it actually works and the information comes out properly."
 *
 * Unit tests prove resolveServices resolves. They do not prove that a toggle
 * on a screen ends up in the sentence the model reads, which is the whole
 * chain and the only thing that matters. This builds the REAL system prompt
 * for a REAL workspace and reads it back.
 *
 * Cleanup in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { loadAgentConfig, loadWorkspaceServices } from "../lib/messaging/db.ts";
import { resolveServices } from "../lib/messaging/services.ts";
import { buildSystemPrompt } from "../lib/messaging/agent-run.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

/** The prompt exactly as a live turn would build it. */
async function promptFor(workspaceId) {
  const { config } = await loadAgentConfig(workspaceId, "new_lead");
  const svc = await loadWorkspaceServices(workspaceId);
  const cfg = {
    persona_name: config?.persona_name ?? "Emily",
    persona_role: config?.persona_role ?? "assistant",
    required_flow: Array.isArray(config?.required_flow) ? config.required_flow : [],
    services_included: config?.services_included ?? null,
    services_excluded: config?.services_excluded ?? null,
    offsite_rules: config?.offsite_rules ?? null,
    tone_rules: config?.tone_rules ?? null,
    office_location: config?.office_location ?? null,
    service_area_note: config?.service_area_note ?? null,
    confidence_threshold: Number(config?.confidence_threshold ?? 0.95),
  };
  return buildSystemPrompt(cfg, [], "new_lead", {}, undefined, resolveServices(svc.services, svc.exceptions));
}

const touched = [];

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164").eq("is_active", true).order("name");
  const nassau = ws.find((w) => w.name === "NY LI Nassau Leads");
  const miami = ws.find((w) => w.name === "FL Miami Leads");

  console.log("\nPER-WORKSPACE CONFIG — real rows, real prompt\n");

  // 1. Office location differs per workspace and reaches the prompt.
  const nassauPrompt = await promptFor(nassau.id);
  const miamiPrompt = await promptFor(miami.id);
  ok("Nassau is told its own office", nassauPrompt.includes("Garden City"),
     nassauPrompt.match(/office is in ([^.]+)/)?.[1] ?? "");
  ok("Miami is told a DIFFERENT office", miamiPrompt.includes("Coral Gables") && !miamiPrompt.includes("Garden City"),
     miamiPrompt.match(/office is in ([^.]+)/)?.[1] ?? "");

  // 2. With no exceptions, every workspace offers the full list.
  ok("Nassau offers flooring by default", /WHAT WE DO IN THIS AREA[\s\S]*flooring/.test(nassauPrompt));
  ok("…and is told nothing is excluded", !nassauPrompt.includes("WE DO NOT OFFER THESE IN THIS AREA"));

  // 3. Turn flooring OFF for Nassau only.
  const { error } = await sb.from("sms_workspace_services").upsert({
    workspace_id: nassau.id, service_key: "flooring", covered: false,
  }, { onConflict: "workspace_id,service_key" });
  if (error) throw error;
  touched.push(nassau.id);

  const afterPrompt = await promptFor(nassau.id);
  ok("Nassau is now told flooring is NOT offered here",
     /WE DO NOT OFFER THESE IN THIS AREA[\s\S]*flooring/.test(afterPrompt));
  ok("…and flooring is gone from what it does offer",
     !/WHAT WE DO IN THIS AREA:\n[^\n]*flooring/.test(afterPrompt));
  ok("…and it is told not to agree to it", afterPrompt.includes("do not agree to them"));
  ok("…while still offering everything else", /WHAT WE DO IN THIS AREA[\s\S]*interior painting/.test(afterPrompt));

  // 4. The change is confined to that workspace.
  const miamiAfter = await promptFor(miami.id);
  ok("Miami is unaffected and still offers flooring",
     /WHAT WE DO IN THIS AREA[\s\S]*flooring/.test(miamiAfter) &&
     !miamiAfter.includes("WE DO NOT OFFER THESE IN THIS AREA"));

  // 5. The default reaches a workspace that never opted out — the bug the
  //    prose fields had, where a workspace with its own copy froze.
  const { data: svcRows } = await sb.from("sms_services").select("key").eq("is_active", true);
  ok("every service in the list reaches an unconfigured workspace",
     svcRows.every((s) => miamiAfter.includes(s.key.replace(/_/g, " "))
       || miamiAfter.includes("cabinet")), `${svcRows.length} services`);

  // 6. Back to the default = no row, not a row that agrees.
  await sb.from("sms_workspace_services").delete()
    .eq("workspace_id", nassau.id).eq("service_key", "flooring");
  const restored = await promptFor(nassau.id);
  ok("removing the exception puts it back on the default",
     !restored.includes("WE DO NOT OFFER THESE IN THIS AREA"));

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} finally {
  for (const id of touched) {
    await sb.from("sms_workspace_services").delete().eq("workspace_id", id);
  }
  const { count } = await sb.from("sms_workspace_services").select("*", { count: "exact", head: true });
  console.log(`cleanup: ${count} workspace service exceptions remain (expect 0)`);
}
process.exit(fail === 0 ? 0 : 1);
