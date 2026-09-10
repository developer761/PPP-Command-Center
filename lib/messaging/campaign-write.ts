"use server";

/**
 * Editing a campaign, and having the change actually take effect.
 *
 * The page promises "changing a follow-up delay is an edit, not a deploy", and
 * that promise has a sharper edge than it looks. There are three different
 * kinds of change here and only two of them are automatic:
 *
 *   WORDING is instant for free. The scheduler reads the step body when the
 *   message is about to go out, not when it was queued, so a typo fixed now is
 *   fixed for every conversation already mid-sequence.
 *
 *   TIMING is NOT instant on its own. Moving a step from day 3 to day 5 does
 *   nothing to the sends already queued at day 3 — they are rows with a
 *   run_at. So changing timing reschedules them, which is the only reading of
 *   the promise that is true.
 *
 *   TURNING IT ON only affects who enters next. Nobody already in the
 *   sequence changes, and nobody who was skipped gets retrospectively added.
 *
 * Every one of these says how many live conversations it touched, because a
 * change that quietly rewrote what forty people are about to receive should
 * not feel the same as one that touched nothing.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { scheduleSteps, parseTimeOfDay, type CampaignStep } from "./campaign-schedule";
import { unresolvedFields, isKnownMergeField } from "./merge-fields";

export type StepEdit = {
  body?: string;
  subject?: string | null;
  scheduleMode?: "at_launch" | "delay_after_last" | "absolute_on_day";
  delayMinutes?: number | null;
  dayOffset?: number | null;
  timeOfDay?: string | null;
};

export type EditOutcome =
  | { ok: true; liveConversationsAffected: number; rescheduled: number }
  | { ok: false; error: string };

export async function updateStep(input: { stepId: string; edit: StepEdit }): Promise<EditOutcome> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: step } = await sb.from("sms_campaign_steps")
    .select("id, version_id, ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("id", input.stepId).maybeSingle();
  if (!step) return { ok: false, error: "That message no longer exists." };

  const e = input.edit;
  const next = {
    body: e.body ?? step.body,
    subject: e.subject !== undefined ? e.subject : step.subject,
    schedule_mode: e.scheduleMode ?? step.schedule_mode,
    delay_minutes: e.delayMinutes !== undefined ? e.delayMinutes : step.delay_minutes,
    day_offset: e.dayOffset !== undefined ? e.dayOffset : step.day_offset,
    time_of_day: e.timeOfDay !== undefined ? e.timeOfDay : step.time_of_day,
  };

  if (!next.body.trim()) return { ok: false, error: "A message cannot be empty." };

  // A placeholder nothing fills would be refused by the gate at send time,
  // which means a message that silently never goes out. Better to refuse the
  // edit than to accept it and have it fail four days later.
  const unknown = [...new Set(unresolvedFields(next.body))].filter((f) => !isKnownMergeField(f));
  if (unknown.length) {
    return { ok: false, error: `Nothing fills in ${unknown.map((f) => `{{${f}}}`).join(", ")}, so this message would never send.` };
  }
  if (step.channel === "email" && !next.subject?.trim()) {
    return { ok: false, error: "An email needs a subject line." };
  }

  // The schema enforces the shape of each mode; getting it wrong here would
  // surface as a constraint violation with no explanation, so it is checked
  // where it can be explained.
  if (next.schedule_mode === "at_launch") {
    next.delay_minutes = null; next.day_offset = null; next.time_of_day = null;
  } else if (next.schedule_mode === "delay_after_last") {
    if (next.delay_minutes === null || next.delay_minutes < 0) {
      return { ok: false, error: "Say how long after the last message this should go." };
    }
    next.day_offset = null; next.time_of_day = null;
  } else {
    if (next.day_offset === null || next.day_offset < 0) return { ok: false, error: "Say which day this should go on." };
    if (parseTimeOfDay(next.time_of_day) === null) return { ok: false, error: "That is not a time this understands." };
    next.delay_minutes = null;
  }

  const timingChanged =
    next.schedule_mode !== step.schedule_mode ||
    next.delay_minutes !== step.delay_minutes ||
    next.day_offset !== step.day_offset ||
    next.time_of_day !== step.time_of_day;

  const { error } = await sb.from("sms_campaign_steps").update(next).eq("id", step.id);
  if (error) return { ok: false, error: error.message };

  // Who is mid-sequence on this version right now.
  const { data: live } = await sb.from("sms_conversations")
    .select("id, created_at, workspace_id, sms_sub_accounts(time_zone)")
    .eq("campaign_version_id", step.version_id).neq("state", "ended");
  const liveConversationsAffected = (live ?? []).length;

  if (!timingChanged) {
    // Wording is already live everywhere: the scheduler reads the body when
    // the message goes out, not when it was queued.
    return { ok: true, liveConversationsAffected, rescheduled: 0 };
  }

  // Timing changed, so the rows already queued have to move or the edit is a
  // lie for everybody currently in the sequence.
  const { data: allSteps } = await sb.from("sms_campaign_steps")
    .select("id, ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("version_id", step.version_id).order("ordinal");

  const asSteps: CampaignStep[] = (allSteps ?? []).map((s) => ({
    ordinal: s.ordinal, scheduleMode: s.schedule_mode as CampaignStep["scheduleMode"],
    delayMinutes: s.delay_minutes, dayOffset: s.day_offset, timeOfDay: s.time_of_day,
    channel: s.channel as "sms" | "email", body: s.body, subject: s.subject,
  }));
  const idOf = new Map((allSteps ?? []).map((s) => [s.ordinal, s.id]));

  let rescheduled = 0;
  for (const c of live ?? []) {
    const tz = (c.sms_sub_accounts as unknown as { time_zone: string } | null)?.time_zone ?? "America/New_York";
    const planned = scheduleSteps(asSteps, new Date(c.created_at), tz);
    for (const p of planned) {
      const stepId = idOf.get(p.ordinal);
      if (!stepId) continue;
      // Only rows that have not gone yet. A message already sent cannot be
      // unsent by moving its schedule.
      const { data: moved } = await sb.from("sms_scheduled_actions")
        .update({ run_at: p.runAt.toISOString(), updated_at: new Date().toISOString() })
        .eq("conversation_id", c.id).eq("campaign_step_id", stepId).eq("state", "pending")
        .select("id");
      rescheduled += moved?.length ?? 0;
    }
  }

  return { ok: true, liveConversationsAffected, rescheduled };
}

/** Turn a workspace's copy of a campaign on or off. Affects who enters NEXT. */
export async function setWorkflowActive(input: { workflowId: string; active: boolean }): Promise<
  { ok: true; alreadyEnrolled: number } | { ok: false; error: string }
> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: wf } = await sb.from("sms_workflows")
    .select("id, workspace_id, campaign_id").eq("id", input.workflowId).maybeSingle();
  if (!wf) return { ok: false, error: "That workflow no longer exists." };

  if (input.active) {
    // Turning on a campaign with nothing published would enrol people into a
    // sequence with no messages: a conversation that opens and says nothing.
    const { data: published } = await sb.from("sms_campaign_versions")
      .select("id").eq("campaign_id", wf.campaign_id).not("published_at", "is", null).limit(1).maybeSingle();
    if (!published) return { ok: false, error: "Publish the sequence first — there are no messages to send yet." };
  }

  const { error } = await sb.from("sms_workflows")
    .update({ is_active: input.active, updated_at: new Date().toISOString() })
    .eq("id", input.workflowId);
  if (error) return { ok: false, error: error.message };

  // Switching OFF does not stop anybody already in the sequence. Saying so is
  // the difference between a pause and what people assume a pause is.
  const { count } = await sb.from("sms_conversations")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", wf.workspace_id).neq("state", "ended");

  return { ok: true, alreadyEnrolled: count ?? 0 };
}

export async function setVersionPublished(input: { versionId: string; published: boolean }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  if (input.published) {
    const { data: steps } = await sb.from("sms_campaign_steps")
      .select("id, channel, body, subject").eq("version_id", input.versionId);
    if (!steps?.length) return { ok: false, error: "There are no messages to publish." };

    for (const s of steps) {
      const unknown = [...new Set(unresolvedFields(s.body))].filter((f) => !isKnownMergeField(f));
      if (unknown.length) {
        return { ok: false, error: `A message uses ${unknown.map((f) => `{{${f}}}`).join(", ")}, which nothing fills in.` };
      }
      if (s.channel === "email" && !s.subject?.trim()) {
        return { ok: false, error: "An email in this sequence has no subject line." };
      }
    }
  }

  const { error } = await sb.from("sms_campaign_versions")
    .update({
      published_at: input.published ? new Date().toISOString() : null,
      published_by: input.published ? userId : null,
    })
    .eq("id", input.versionId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
