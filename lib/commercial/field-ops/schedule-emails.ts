import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * R10 - schedule-email settings. Two things live here:
 *  1. Internal recipients (office: Stephanie/Brendan/...) who get the FULL
 *     weekly schedule summary.
 *  2. Per-employee opt-out lives on commercial_employees.schedule_email_opt_out
 *     (everyone gets their personal schedule by default). Managed via the
 *     employees lib; this file just reads the roster for the toggle UI.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ScheduleEmailRecipient = {
  id: string;
  email: string;
  label: string | null;
  active: boolean;
  created_at: string;
};

export async function listScheduleRecipients(): Promise<ScheduleEmailRecipient[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_schedule_email_recipients")
    .select("id, email, label, active, created_at")
    .eq("active", true)
    .order("created_at");
  return (data ?? []) as ScheduleEmailRecipient[];
}

export async function addScheduleRecipient(
  email: string,
  label: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const e = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return { ok: false, error: "Enter a valid email." };
  const sb = commercialDb();
  // Reactivate if it exists but was removed; else insert.
  const { data: existing } = await sb
    .from("commercial_schedule_email_recipients")
    .select("id, active")
    .eq("email", e)
    .maybeSingle();
  if (existing) {
    const { error } = await sb
      .from("commercial_schedule_email_recipients")
      .update({ active: true, label: (label ?? "").trim() || null })
      .eq("id", (existing as { id: string }).id);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const { error } = await sb
    .from("commercial_schedule_email_recipients")
    .insert({ email: e, label: (label ?? "").trim() || null });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function removeScheduleRecipient(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_schedule_email_recipients")
    .update({ active: false })
    .eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
