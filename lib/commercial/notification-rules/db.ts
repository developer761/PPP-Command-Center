import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  RULE_TRIGGERS,
  RULE_CHANNELS,
  type RuleTrigger,
  type RuleChannel,
} from "./constants";

/**
 * CRUD for custom notification rules (Block 3B). Rules are personal — scoped
 * to owner_user_id — so every mutation takes the acting user id and rejects
 * cross-owner access. Service-role client; RLS denies direct client access.
 */

export type NotificationRule = {
  id: string;
  owner_user_id: string;
  name: string;
  trigger: RuleTrigger;
  threshold_days: number;
  channel: RuleChannel;
  enabled: boolean;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
};

type Result = { ok: true } | { ok: false; error: string };
type CreateResult = { ok: true; id: string } | { ok: false; error: string };

const NAME_MAX = 80;

function validate(input: {
  name: string;
  trigger: string;
  threshold_days: number;
  channel: string;
}): string | null {
  const name = input.name.trim();
  if (!name) return "Give the alert a name.";
  if (name.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer.`;
  if (!(RULE_TRIGGERS as readonly string[]).includes(input.trigger)) return "Pick a valid trigger.";
  if (!(RULE_CHANNELS as readonly string[]).includes(input.channel)) return "Pick a valid channel.";
  if (!Number.isInteger(input.threshold_days) || input.threshold_days < 0 || input.threshold_days > 365) {
    return "Days must be a whole number between 0 and 365.";
  }
  return null;
}

/** All rules owned by a user, newest first. */
export async function listNotificationRules(ownerUserId: string): Promise<NotificationRule[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_notification_rules")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[notif-rules] list failed:", error.message);
    return [];
  }
  return (data ?? []) as NotificationRule[];
}

export async function createNotificationRule(input: {
  ownerUserId: string;
  name: string;
  trigger: string;
  threshold_days: number;
  channel: string;
}): Promise<CreateResult> {
  const err = validate(input);
  if (err) return { ok: false, error: err };
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_notification_rules")
    .insert({
      owner_user_id: input.ownerUserId,
      name: input.name.trim(),
      trigger: input.trigger,
      threshold_days: input.threshold_days,
      channel: input.channel,
      enabled: true,
    })
    .select("id")
    .single();
  if (error || !data) {
    // Don't leak the raw Postgres message (e.g. a missing-table error before
    // the migration is applied) — log it, show a friendly line.
    console.error("[notif-rules] create failed:", error?.message);
    return { ok: false, error: "Couldn't create the alert. Please try again." };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** Enable/disable — owner-scoped. */
export async function setNotificationRuleEnabled(input: {
  ownerUserId: string;
  ruleId: string;
  enabled: boolean;
}): Promise<Result> {
  const sb = commercialDb();
  const { error, count } = await sb
    .from("commercial_notification_rules")
    .update({ enabled: input.enabled, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", input.ruleId)
    .eq("owner_user_id", input.ownerUserId);
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: "Alert not found." };
  return { ok: true };
}

/** Delete — owner-scoped. Fires cascade via FK. */
export async function deleteNotificationRule(input: {
  ownerUserId: string;
  ruleId: string;
}): Promise<Result> {
  const sb = commercialDb();
  const { error, count } = await sb
    .from("commercial_notification_rules")
    .delete({ count: "exact" })
    .eq("id", input.ruleId)
    .eq("owner_user_id", input.ownerUserId);
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: "Alert not found." };
  return { ok: true };
}
