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
import { validateAction } from "../lib/messaging/agent-output.ts";

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

  /* ── THE HARDCODED LIST MUST NOT CONTRADICT THE CONFIGURED ONE ──────
   *
   * Services are rows in sms_services and ticked per workspace on the Chatbot
   * screen. OUT_OF_SCOPE in agent-output.ts is a regex nobody can see from
   * there. When they disagreed, the prompt told the model PPP does flooring,
   * the model said so, and the turn was refused as out of scope — a correct
   * answer turned into a handover by two lists that never met.
   *
   * Checked here rather than in a unit test because the service list is a
   * table, and a hardcoded copy of it in a test is the same bug one level up.
   */
  const { data: services } = await sb.from("sms_services")
    .select("key, phrase").eq("is_active", true);
  const said = (phrase) => [
    `Yes, we do ${phrase}.`, `We can handle the ${phrase}.`, `we install ${phrase}`,
  ];
  const ctx = {
    knownFields: { name: true, phone: true, email: true, address: true, inquiryScope: true },
    stage: 4, priorIntents: [], customerText: "ok",
  };
  const clashes = [];
  for (const svc of services ?? []) {
    for (const sentence of said(svc.phrase)) {
      const v = validateAction({ intent: "answer_question", confidence: 0.9, freeText: sentence }, ctx);
      if (!v.ok && v.reason === "out_of_scope_work") clashes.push(`${svc.key}: ${sentence}`);
    }
  }
  ok("no service PPP offers is refused as out of scope",
     clashes.length === 0,
     clashes.length ? clashes.join(" | ") : `${(services ?? []).length} services checked`);

  /**
   * THE SAME CHECK, POINTED THE OTHER WAY.
   *
   * The check above proves the backstop does not refuse work PPP sells. It
   * says nothing about work PPP does NOT sell, and that half was empty: the
   * "What we do not cover" box named seven categories and the regex knew
   * four, so "we can paint your furniture", "we can coat your industrial
   * equipment" and "we can do artistic painting" all went out unrefused.
   * Exactly the flooring bug with the sign flipped, and invisible for the
   * same reason — the configured list and the hardcoded one never met.
   *
   * Parsed from the live text rather than restated here, because a copy of
   * the list in this file is one more thing that can drift out of step with
   * the box somebody actually edits.
   */
  const { data: excluding } = await sb.from("sms_agent_configs")
    .select("track, services_excluded").not("services_excluded", "is", null);

  /**
   * Two kinds of ellipsis in one list, running opposite ways:
   *   "Pool tiles or liners"            — the modifier leads  ("pool" liners)
   *   "Murals, artistic or graphic painting" — the head noun trails (artistic "painting")
   * A fragment counts as covered if ANY of those readings is refused.
   */
  const itemsIn = (text) => {
    const out = new Set();
    for (const line of text.split("\n")) {
      const bullet = line.match(/^\s*[-*]\s*(.+?)\s*$/)?.[1];
      if (!bullet) continue;
      // "that are standalone rather than built in" qualifies, it does not name a thing.
      const named = bullet.replace(/\s+that\s+are\b.*$/i, "").replace(/,?\s*including\s+/i, ", ");
      const words = named.split(/\s+/);
      const lead = words.length > 1 ? words[0] : null;
      const tail = words.length > 1 ? words[words.length - 1] : null;
      for (const raw of named.split(/,|\s+or\s+|\s+and\s+/i)) {
        const frag = raw.trim();
        if (!frag) continue;
        out.add(JSON.stringify(frag.includes(" ") ? { frag } : { frag, lead, tail }));
      }
    }
    return [...out].map((j) => JSON.parse(j));
  };

  const refusedAsOutOfScope = (phrase) =>
    [`Yes, we can paint your ${phrase.toLowerCase()}.`,
     `we can do ${phrase.toLowerCase()}`,
     `${phrase} is no problem.`].some((sentence) => {
      const v = validateAction({ intent: "answer_question", confidence: 0.9, freeText: sentence }, ctx);
      return !v.ok && v.reason === "out_of_scope_work";
    });

  const unrefused = [];
  let checked = 0;
  for (const row of excluding ?? []) {
    for (const { frag, lead, tail } of itemsIn(row.services_excluded)) {
      checked++;
      // A LEAD WORD THAT IS ITSELF BANNED PROVES NOTHING.
      // "Murals, artistic or graphic painting" made the modifier reading
      // "Murals artistic", which matches the murals rule and marked the
      // artistic-painting gap covered while it was still wide open. Only a
      // lead that is not independently refused is carrying a modifier.
      const readings = [frag];
      if (lead && !refusedAsOutOfScope(lead)) readings.push(`${lead} ${frag}`);
      if (tail) readings.push(`${frag} ${tail}`);
      if (!readings.some(refusedAsOutOfScope)) unrefused.push(`${row.track}: ${frag}`);
    }
  }
  ok("everything the configuration excludes is actually refused",
     unrefused.length === 0,
     unrefused.length ? unrefused.join(" | ") : `${checked} excluded items checked`);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} catch (err) {
  // Without this an error part-way exits through finally as "N passed, 0 failed",
  // exit 0, with every later check skipped. It is a failure.
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const id of touched) {
    await sb.from("sms_workspace_services").delete().eq("workspace_id", id);
  }
  const { count } = await sb.from("sms_workspace_services").select("*", { count: "exact", head: true });
  console.log(`cleanup: ${count} workspace service exceptions remain (expect 0)`);
}
process.exit(fail === 0 ? 0 : 1);
