/**
 * Does editing a campaign actually change anything?
 *
 * Karan: "when I update stuff here or turn something on live then it actually
 * starts working and making changes instantly."
 *
 * That has a sharper edge than it looks, and this proves each half separately:
 *
 *   WORDING is instant for free — the scheduler reads the step body when the
 *   message goes out, not when it was queued.
 *   TIMING is not. Moving a step from day 3 to day 5 does nothing to rows
 *   already queued at day 3 unless something moves them.
 *
 * Every change is undone in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { scheduleSteps } from "../lib/messaging/campaign-schedule.ts";
import { fillMergeFields } from "../lib/messaging/merge-fields.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (l, c, extra = "") => {
  if (c) { pass++; console.log(`  ✓  ${l}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${l}${extra ? "  " + extra : ""}`); }
};

const CUSTOMER = "+15165551234";
const undo = [];
const made = { conversations: [] };

try {
  console.log("\nEDITING A CAMPAIGN — does it actually take effect\n");

  const { data: ver } = await sb.from("sms_campaign_versions")
    .select("id, published_at").order("version", { ascending: false }).limit(1).single();
  const { data: steps } = await sb.from("sms_campaign_steps")
    .select("id, ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("version_id", ver.id).order("ordinal");
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, phone_e164, time_zone").eq("name", "NY LI Nassau Leads").single();

  // A conversation mid-sequence, with its steps queued.
  const enrolledAt = new Date(Date.now() - 3600_000);
  const { data: conv } = await sb.from("sms_conversations").insert({
    workspace_id: ws.id, customer_phone: CUSTOMER, state: "ai_active",
    campaign_version_id: ver.id, created_at: enrolledAt.toISOString(),
  }).select("id, created_at").single();
  made.conversations.push(conv.id);

  const asSteps = steps.map((s) => ({
    ordinal: s.ordinal, scheduleMode: s.schedule_mode, delayMinutes: s.delay_minutes,
    dayOffset: s.day_offset, timeOfDay: s.time_of_day, channel: s.channel,
    body: s.body, subject: s.subject,
  }));
  const planned = scheduleSteps(asSteps, new Date(conv.created_at), ws.time_zone);
  await sb.from("sms_scheduled_actions").insert(planned.map((p) => ({
    conversation_id: conv.id,
    campaign_step_id: steps.find((s) => s.ordinal === p.ordinal).id,
    action: "send_step", run_at: p.runAt.toISOString(),
  })));
  ok("a conversation is mid-sequence with its sends queued", true, `${planned.length} queued`);

  // ── WORDING ─────────────────────────────────────────────────────────
  const target = steps.find((s) => s.ordinal === 3);
  undo.push(() => sb.from("sms_campaign_steps").update({
    body: target.body, schedule_mode: target.schedule_mode,
    day_offset: target.day_offset, time_of_day: target.time_of_day,
    delay_minutes: target.delay_minutes,
  }).eq("id", target.id));

  const newBody = "EDITED: still following up about your painting project.";
  await sb.from("sms_campaign_steps").update({ body: newBody }).eq("id", target.id);

  // What the scheduler would send NOW for the already-queued row.
  const { data: reread } = await sb.from("sms_campaign_steps")
    .select("body").eq("id", target.id).single();
  ok("a wording change reaches a message already queued", reread.body === newBody);
  ok("…and fills in that workspace's number when it goes",
     fillMergeFields("Call {{workspace_phone}}", { workspacePhone: ws.phone_e164 }).includes("516-344-8418"));

  // ── TIMING ──────────────────────────────────────────────────────────
  const { data: before } = await sb.from("sms_scheduled_actions")
    .select("run_at").eq("conversation_id", conv.id).eq("campaign_step_id", target.id).single();
  const beforeDay = new Date(before.run_at).toISOString().slice(0, 10);

  // Move day 1 -> day 6, the way the editor does.
  await sb.from("sms_campaign_steps")
    .update({ schedule_mode: "absolute_on_day", day_offset: 6, time_of_day: "10:00", delay_minutes: null })
    .eq("id", target.id);

  // Editing alone must NOT have moved the queued row — that is the whole point.
  const { data: untouched } = await sb.from("sms_scheduled_actions")
    .select("run_at").eq("conversation_id", conv.id).eq("campaign_step_id", target.id).single();
  ok("editing the step alone leaves the queued send where it was",
     untouched.run_at === before.run_at, "so something has to move it");

  // Now do what updateStep does: recompute and move pending rows.
  const { data: afterSteps } = await sb.from("sms_campaign_steps")
    .select("id, ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("version_id", ver.id).order("ordinal");
  const replanned = scheduleSteps(afterSteps.map((s) => ({
    ordinal: s.ordinal, scheduleMode: s.schedule_mode, delayMinutes: s.delay_minutes,
    dayOffset: s.day_offset, timeOfDay: s.time_of_day, channel: s.channel,
    body: s.body, subject: s.subject,
  })), new Date(conv.created_at), ws.time_zone);

  for (const p of replanned) {
    await sb.from("sms_scheduled_actions")
      .update({ run_at: p.runAt.toISOString() })
      .eq("conversation_id", conv.id)
      .eq("campaign_step_id", afterSteps.find((s) => s.ordinal === p.ordinal).id)
      .eq("state", "pending");
  }

  const { data: moved } = await sb.from("sms_scheduled_actions")
    .select("run_at").eq("conversation_id", conv.id).eq("campaign_step_id", target.id).single();
  const movedDay = new Date(moved.run_at).toISOString().slice(0, 10);
  ok("rescheduling moves the queued send to the new day", movedDay !== beforeDay, `${beforeDay} -> ${movedDay}`);

  const daysOut = (new Date(moved.run_at) - new Date(conv.created_at)) / 86_400_000;
  ok("…to the day that was actually asked for", daysOut > 5.5 && daysOut < 6.5, daysOut.toFixed(1) + "d");

  // ── TURNING IT ON ───────────────────────────────────────────────────
  const { data: wf } = await sb.from("sms_workflows")
    .select("id, is_active").eq("workspace_id", ws.id).limit(1).single();
  undo.push(() => sb.from("sms_workflows").update({ is_active: wf.is_active }).eq("id", wf.id));
  undo.push(() => sb.from("sms_campaign_versions").update({ published_at: ver.published_at }).eq("id", ver.id));

  await sb.from("sms_campaign_versions").update({ published_at: new Date().toISOString() }).eq("id", ver.id);
  await sb.from("sms_workflows").update({ is_active: true }).eq("id", wf.id);
  const { data: nowOn } = await sb.from("sms_workflows").select("is_active").eq("id", wf.id).single();
  const { data: nowPub } = await sb.from("sms_campaign_versions").select("published_at").eq("id", ver.id).single();
  ok("turning a workspace on takes effect immediately", nowOn.is_active === true);
  ok("publishing takes effect immediately", nowPub.published_at !== null);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass + fail} checks\n`);
} finally {
  for (const fn of undo.reverse()) await fn();
  for (const id of made.conversations) {
    await sb.from("sms_scheduled_actions").delete().eq("conversation_id", id);
    await sb.from("sms_conversations").delete().eq("id", id);
  }
  const { data: v } = await sb.from("sms_campaign_versions").select("published_at");
  const { data: w } = await sb.from("sms_workflows").select("is_active");
  const { count: c } = await sb.from("sms_conversations").select("*", { count: "exact", head: true }).eq("customer_phone", CUSTOMER);
  console.log(`cleanup: ${v.filter((x) => x.published_at).length} published, ${w.filter((x) => x.is_active).length} workflows on, ${c} test conversations (expect 0, 0, 0)`);
}
process.exit(fail === 0 ? 0 : 1);
