/**
 * Enrolment and lead intake against the real database.
 *
 * enrolLead had never run against the database: nothing called it. It wrote
 * consent_basis 'inbound_inquiry', which the CHECK refuses, so the first real
 * lead would have failed at the conversation insert. This builds a throwaway
 * workspace, campaign and active workflow, enrols through the real code, and
 * checks what landed: the conversation, every step queued, and an opener
 * 2-5 minutes after the lead was created.
 *
 * Nothing is sent: this only schedules. Everything it creates is deleted in
 * finally (the workspace cascades to its campaign, workflow and conversations).
 */
import { createClient } from "@supabase/supabase-js";
import { enrolLeadWith } from "../lib/messaging/enrol-core.ts";
import { processPendingLeads } from "../lib/messaging/lead-poll.ts";
import { TICK_SECONDS } from "../lib/messaging/reply-delay.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

const stamp = Date.now();
let wsId = null;
let ruleSetId = null;
const inboundIds = [];

try {
  console.log(`\nENROLMENT — real schema\n`);

  // Area code 999 is reserved and assigned to nobody.
  const { data: ws, error: wsErr } = await sb.from("sms_sub_accounts").insert({
    name: `E2E Enrol ${stamp}`, phone_e164: "+19992220190", time_zone: "America/New_York", is_active: true,
  }).select("id").single();
  if (wsErr) throw new Error(`workspace: ${wsErr.message}`);
  wsId = ws.id;

  const { data: camp } = await sb.from("sms_campaigns").insert({
    name: `E2E campaign ${stamp}`, workspace_id: wsId, trigger_event: "sf_lead_created",
  }).select("id").single();
  const { data: ver } = await sb.from("sms_campaign_versions").insert({
    campaign_id: camp.id, version: 1, published_at: new Date().toISOString(),
  }).select("id").single();
  const { error: stErr } = await sb.from("sms_campaign_steps").insert([
    { version_id: ver.id, ordinal: 1, schedule_mode: "at_launch", channel: "sms",
      body: "Hello, this is Precision Painting Plus. Reply STOP to opt out." },
    { version_id: ver.id, ordinal: 2, schedule_mode: "delay_after_last", delay_minutes: 30, channel: "sms",
      body: "Just checking in." },
  ]);
  if (stErr) throw new Error(`steps: ${stErr.message}`);
  // A workflow needs an entry rule: an empty rule set matches nothing on
  // purpose, or an empty audience form would enrol every lead in Salesforce.
  const { data: rs, error: rsErr } = await sb.from("sms_rule_sets").insert({
    name: `E2E entry ${stamp}`, kind: "entry",
  }).select("id").single();
  if (rsErr) throw new Error(`rule set: ${rsErr.message}`);
  ruleSetId = rs.id;
  await sb.from("sms_rules").insert({ rule_set_id: rs.id, ordinal: 1, field: "RecordType", operator: "in", values: ["Web Inquiry", "Phone Inquiry"] });
  const { data: wf, error: wfErr } = await sb.from("sms_workflows").insert({
    name: `E2E workflow ${stamp}`, campaign_id: camp.id, workspace_id: wsId, is_active: true, entry_rules_id: rs.id,
  }).select("id").single();
  if (wfErr) throw new Error(`workflow: ${wfErr.message}`);

  /* ── A lead goes in ─────────────────────────────────────────── */
  const created = new Date(Date.now() - 60_000); // Salesforce created it a minute ago
  const res = await enrolLeadWith(sb, {
    workspaceId: wsId, customerPhone: "(999) 222-0191", customerName: "Test Lead",
    sfLeadId: `E2E-${stamp}`,
    // CONSENT, because since 2026-10-11 a lead without it does not enrol at
    // all. This record carried no SMS_Opt_In__c, so every case below failed on
    // the consent gate rather than on the thing it was written to check — the
    // gate working, but it turned this script into one rule tested four times.
    // The refusals get their own cases at the end, where they belong.
    record: { RecordType: "Web Inquiry", SMS_Opt_In__c: "Opt-In (Verified)" },
    leadCreatedAt: created,
  });
  ok("a lead enrols through the real code", res.ok, res.ok ? "" : res.reason);

  if (res.ok) {
    const { data: conv } = await sb.from("sms_conversations")
      .select("consent_basis, state, campaign_version_id, sms_consent_value, sms_consent_seen_at")
      .eq("id", res.conversationId).single();
    ok("the conversation is stored with a consent basis the database accepts",
       conv?.consent_basis === "inquiry" && conv?.state === "ai_active");

    /**
     * The evidence, against the real columns. Migration 20261011160000 added
     * these and the insert names them, so this also proves schema and code
     * agree — the exact failure that would otherwise wait for the first real
     * lead, which is what this whole script exists to prevent.
     */
    ok("what Salesforce said about consent is recorded verbatim",
       conv?.sms_consent_value === "Opt-In (Verified)", `got ${JSON.stringify(conv?.sms_consent_value)}`);
    ok("and stamped with when we read it", !!conv?.sms_consent_seen_at);

    const { data: acts } = await sb.from("sms_scheduled_actions")
      .select("run_at, campaign_step_id, action").eq("conversation_id", res.conversationId).order("run_at");
    ok("every step is queued", acts?.length === 2, `${acts?.length ?? 0} queued`);
    const opener = (new Date(acts[0].run_at).getTime() - created.getTime()) / 1000;
    ok("the opener goes 2-5 minutes after Salesforce created the lead",
       opener >= 120 && opener + TICK_SECONDS <= 300, `${opener}s after creation`);
    const gap = (new Date(acts[1].run_at).getTime() - new Date(acts[0].run_at).getTime()) / 60_000;
    ok("the follow-up stacks 30 minutes on the opener", gap === 30, `${gap} min`);

    /* ── The same person again ────────────────────────────────── */
    const again = await enrolLeadWith(sb, {
      workspaceId: wsId, customerPhone: "999-222-0191", sfLeadId: `E2E-${stamp}-dup`,
      record: { RecordType: "Web Inquiry", SMS_Opt_In__c: "Opt-In (Verified)" },
      leadCreatedAt: new Date(),
    });
    const { count } = await sb.from("sms_scheduled_actions").select("*", { count: "exact", head: true })
      .eq("conversation_id", res.conversationId);
    ok("a duplicate lead is not texted the campaign twice", again.ok && again.alreadyLive && count === 2);
  }

  /* ── A workspace with nothing switched on ───────────────────── */
  await sb.from("sms_workflows").update({ is_active: false }).eq("id", wf.id);
  const off = await enrolLeadWith(sb, {
    // Consent supplied so this reaches the workflow check. Without it the
    // refusal came back about consent and this case silently stopped testing
    // workflows at all — a green-looking assertion about the wrong rule.
    workspaceId: wsId, customerPhone: "999-222-0192",
    record: { SMS_Opt_In__c: "Opt-In (Verified)" }, leadCreatedAt: new Date(),
  });
  ok("with no active workflow it refuses, and says why", !off.ok && /no active workflow/.test(off.reason ?? ""), off.ok ? "" : off.reason);

  /* ── Consent, against the real database ─────────────────────── */
  /**
   * The gap Twilio rejected the A2P campaign over on 2026-10-10: SMS_Opt_In__c
   * was read only to STOP a conversation, never to decide whether to start
   * one. These two cases are the whole reason enrolment now refuses first.
   *
   * The workflow is switched OFF at this point, which makes them sharper than
   * they look: if the consent gate ever stopped running, these would come back
   * refused for "no active workflow" instead and the reason check would catch
   * it. A refusal alone would not — both outcomes are `!ok`.
   */
  await sb.from("sms_workflows").update({ is_active: true }).eq("id", wf.id);

  const noConsent = await enrolLeadWith(sb, {
    workspaceId: wsId, customerPhone: "999-222-0193",
    record: { RecordType: "Web Inquiry" }, leadCreatedAt: new Date(),
  });
  ok("a lead with NO recorded consent does not enrol",
     !noConsent.ok && /no SMS consent is recorded/.test(noConsent.reason ?? ""),
     noConsent.ok ? "IT ENROLLED" : noConsent.reason);

  const optedOut = await enrolLeadWith(sb, {
    workspaceId: wsId, customerPhone: "999-222-0194",
    record: { RecordType: "Web Inquiry", SMS_Opt_In__c: "Opt-Out" }, leadCreatedAt: new Date(),
  });
  ok("a lead who opted out does not enrol",
     !optedOut.ok && /opted out/i.test(optedOut.reason ?? ""),
     optedOut.ok ? "IT ENROLLED" : optedOut.reason);

  /** Neither refusal may leave anything behind. */
  const { count: leftovers } = await sb.from("sms_conversations")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", wsId).in("customer_phone", ["+19992220193", "+19992220194"]);
  ok("a refused lead leaves no conversation behind", leftovers === 0, `${leftovers} found`);

  /* ── Intake records a lead it cannot text, with the reason ──── */
  const { count: otherPending } = await sb.from("sf_lead_inbound")
    .select("*", { count: "exact", head: true }).eq("status", "pending");
  if ((otherPending ?? 0) > 0) {
    console.log(`  -  skipped the intake check: ${otherPending} real lead(s) are pending and this must not process them`);
  } else {
    const { data: row } = await sb.from("sf_lead_inbound").insert({
      sf_record_id: `E2E-NOPHONE-${stamp}`, arrived_via: "manual",
      payload: { Id: `E2E-NOPHONE-${stamp}`, Name: "No Phone", LeadSource: "Meta", State: "NY" },
    }).select("id").single();
    inboundIds.push(row.id);
    const out = await processPendingLeads(sb);
    const { data: after } = await sb.from("sf_lead_inbound").select("status, triage_reason").eq("id", row.id).single();
    ok("a lead with no phone goes to triage with its reason", after.status === "triage" && /no_contactable_phone/.test(after.triage_reason ?? ""),
       `${after.status}: ${after.triage_reason}`);
    ok("and is counted", out.triaged === 1);
  }

} catch (err) {
  fail++;
  console.log(`  ✗  stopped early: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (inboundIds.length) await sb.from("sf_lead_inbound").delete().in("id", inboundIds);
  if (wsId) {
    await sb.from("sms_conversations").delete().eq("workspace_id", wsId);
    await sb.from("sms_workflows").delete().eq("workspace_id", wsId);
    await sb.from("sms_campaigns").delete().eq("workspace_id", wsId);
    await sb.from("sms_sub_accounts").delete().eq("id", wsId);
  }
  // After the workflow: entry_rules_id is ON DELETE RESTRICT.
  if (ruleSetId) await sb.from("sms_rule_sets").delete().eq("id", ruleSetId);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
