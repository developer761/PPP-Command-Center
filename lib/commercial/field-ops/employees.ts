import "server-only";

import { createHash } from "crypto";
import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * R10 Field Ops - the crew master (commercial_employees).
 *
 * IDs are keys, names are labels (design principle #1): every employee has an
 * immutable UUID; display names change without breaking any history. Employees
 * are never hard-deleted - deactivate (active=false) so timesheet history holds.
 * Each carries a rotating magic_link_token (their personal schedule + clock
 * link) minted at create.
 */

export const WORKER_TYPES = ["w2", "sub", "temp"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const EMPLOYEE_ROLES = ["foreman", "painter", "taper", "laborer", "apprentice"] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export const PAY_TYPES = ["hourly", "daily", "salary"] as const;
export type PayType = (typeof PAY_TYPES)[number];

export function workerTypeLabel(t: WorkerType): string {
  return { w2: "W-2 employee", sub: "Subcontractor", temp: "Temp" }[t];
}
export function employeeRoleLabel(r: EmployeeRole): string {
  return { foreman: "Foreman", painter: "Painter", taper: "Taper", laborer: "Laborer", apprentice: "Apprentice" }[r];
}

export type CommercialEmployee = {
  id: string;
  first_name: string;
  last_name: string | null;
  display_name: string;
  worker_type: WorkerType;
  role: EmployeeRole;
  pay_type: PayType;
  default_daily_hours: number;
  phone: string | null;
  email: string | null;
  sort_order: number;
  active: boolean;
  start_date: string | null;
  end_date: string | null;
  schedule_email_opt_out: boolean;
  preferred_language: "en" | "es";
  external_ref: string | null;
  /** Migration 125 — the Commercial login this employee signs in as (crew
   *  self-service). NULL for the majority, who have no login. Resolved ONLY
   *  via getEmployeeForUser; never matched by email. */
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

// user_id MUST be in this list — without it the column comes back undefined and
// every scoped crew query silently resolves to "no employee linked".
//
// It also arrived in migration 125, which is applied separately from a deploy.
// Selecting a column the DB doesn't have yet is a hard 42703 that takes the
// whole Field Ops crew page down, so the readers below fall back to
// EMPLOYEE_COLS_LEGACY on that one error. A missing column then degrades to
// "no crew logins are linked" — which is TRUE until the migration runs — rather
// than an error page on a screen that has nothing to do with the crew role.
export const EMPLOYEE_COLS =
  "id, first_name, last_name, display_name, worker_type, role, pay_type, default_daily_hours, phone, email, sort_order, active, start_date, end_date, schedule_email_opt_out, preferred_language, external_ref, user_id, created_at, updated_at";

/** Pre-migration-125 column list (no user_id). */
const EMPLOYEE_COLS_LEGACY = EMPLOYEE_COLS.replace(", user_id", "");

/** True when Postgres says a column is missing (42703). */
function isMissingColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

export async function listEmployees(opts?: { includeInactive?: boolean }): Promise<CommercialEmployee[]> {
  const sb = commercialDb();
  const run = async (cols: string) => {
    let q = sb.from("commercial_employees").select(cols).order("sort_order").order("display_name");
    if (!opts?.includeInactive) q = q.eq("active", true);
    return q;
  };
  let { data, error } = await run(EMPLOYEE_COLS);
  if (isMissingColumn(error)) {
    // Migration 125 hasn't run on this database yet. Serve the roster without
    // the link rather than 500 the page.
    console.warn("[field-ops/employees] user_id column missing — run migration 125");
    ({ data, error } = await run(EMPLOYEE_COLS_LEGACY));
  }
  if (error) {
    console.warn("[field-ops/employees] list failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as CommercialEmployee[];
}

export async function getEmployee(id: string): Promise<CommercialEmployee | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_employees").select(EMPLOYEE_COLS).eq("id", id).maybeSingle();
  return (data as CommercialEmployee | null) ?? null;
}

export type CreateEmployeeInput = {
  first_name: string;
  last_name?: string | null;
  display_name?: string | null;
  worker_type?: WorkerType;
  role?: EmployeeRole;
  pay_type?: PayType;
  default_daily_hours?: number;
  phone?: string | null;
  email?: string | null;
  sort_order?: number;
  preferred_language?: "en" | "es";
  actor_user_id: string;
};

export async function createEmployee(
  input: CreateEmployeeInput
): Promise<{ ok: true; employee: CommercialEmployee } | { ok: false; error: string }> {
  const first = (input.first_name ?? "").trim();
  if (!first) return { ok: false, error: "First name is required." };
  const display = (input.display_name ?? "").trim() || [first, (input.last_name ?? "").trim()].filter(Boolean).join(" ");

  const sb = commercialDb();
  // Default sort_order to the end of the list so new crew append as a new column.
  let sortOrder = input.sort_order;
  if (sortOrder == null) {
    const { data: last } = await sb
      .from("commercial_employees")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    sortOrder = ((last as { sort_order?: number } | null)?.sort_order ?? 0) + 10;
  }

  const { data, error } = await sb
    .from("commercial_employees")
    .insert({
      first_name: first,
      last_name: (input.last_name ?? "").trim() || null,
      display_name: display,
      worker_type: input.worker_type ?? "w2",
      role: input.role ?? "painter",
      pay_type: input.pay_type ?? "hourly",
      default_daily_hours: input.default_daily_hours ?? 8,
      phone: (input.phone ?? "").trim() || null,
      email: (input.email ?? "").trim().toLowerCase() || null,
      sort_order: sortOrder,
      preferred_language: input.preferred_language ?? "en",
      magic_link_token: globalThis.crypto.randomUUID().replace(/-/g, ""),
    })
    .select(EMPLOYEE_COLS)
    .single();
  if (error) return { ok: false, error: error.message };
  const employee = data as CommercialEmployee;
  await logInsert("commercial_employees", employee.id, employee, input.actor_user_id);
  return { ok: true, employee };
}

export type UpdateEmployeeInput = {
  first_name?: string;
  last_name?: string | null;
  display_name?: string;
  worker_type?: WorkerType;
  role?: EmployeeRole;
  pay_type?: PayType;
  default_daily_hours?: number;
  phone?: string | null;
  email?: string | null;
  sort_order?: number;
  preferred_language?: "en" | "es";
  schedule_email_opt_out?: boolean;
  active?: boolean;
};

export async function updateEmployee(
  id: string,
  patch: UpdateEmployeeInput,
  actorUserId: string
): Promise<{ ok: true; employee: CommercialEmployee } | { ok: false; error: string }> {
  const before = await getEmployee(id);
  if (!before) return { ok: false, error: "Employee not found." };

  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.first_name !== undefined) next.first_name = patch.first_name.trim();
  if (patch.last_name !== undefined) next.last_name = (patch.last_name ?? "").trim() || null;
  if (patch.display_name !== undefined) {
    // Never save a blank display name — fall back to first+last, then the prior
    // name (create auto-fills the same way; edit previously allowed empty).
    const dn = patch.display_name.trim();
    next.display_name =
      dn ||
      [(patch.first_name ?? before.first_name ?? "").trim(), (patch.last_name ?? before.last_name ?? "").trim()].filter(Boolean).join(" ") ||
      before.display_name;
  }
  if (patch.worker_type !== undefined) next.worker_type = patch.worker_type;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.pay_type !== undefined) next.pay_type = patch.pay_type;
  if (patch.default_daily_hours !== undefined) next.default_daily_hours = patch.default_daily_hours;
  if (patch.phone !== undefined) next.phone = (patch.phone ?? "").trim() || null;
  if (patch.email !== undefined) next.email = (patch.email ?? "").trim().toLowerCase() || null;
  if (patch.sort_order !== undefined) next.sort_order = patch.sort_order;
  if (patch.preferred_language !== undefined) next.preferred_language = patch.preferred_language;
  if (patch.schedule_email_opt_out !== undefined) next.schedule_email_opt_out = patch.schedule_email_opt_out;
  if (patch.active !== undefined) next.active = patch.active;

  const sb = commercialDb();
  const { data, error } = await sb.from("commercial_employees").update(next).eq("id", id).select(EMPLOYEE_COLS).single();
  if (error) return { ok: false, error: error.message };
  const employee = data as CommercialEmployee;
  await logUpdate("commercial_employees", id, before, employee, actorUserId);

  // Opting a crew member out (or deactivating/firing them) must cancel any
  // clock-in nudges already queued at Resend for their upcoming shifts —
  // otherwise the opted-out/fired worker still gets pinged (audit round 3).
  const optedOut = patch.schedule_email_opt_out === true && !before.schedule_email_opt_out;
  const deactivated = patch.active === false && before.active;
  if (optedOut || deactivated) {
    const { todayEtIso } = await import("./schedule");
    const { resetClockReminder } = await import("./schedule-email-send");
    const { data: logs } = await sb
      .from("commercial_schedule_email_log")
      .select("work_date")
      .eq("employee_id", id)
      .eq("kind", "clock_reminder")
      .gte("work_date", todayEtIso());
    for (const l of (logs ?? []) as { work_date: string }[]) {
      await resetClockReminder(id, String(l.work_date).slice(0, 10)).catch(() => undefined);
    }
  }

  // Deactivating someone takes them OFF the upcoming schedule.
  //
  // Only the email nudges were being cancelled — the assignments themselves
  // stayed, and the schedule reads don't filter on `active`. So a crew member
  // who had been let go kept appearing on next week's jobs, counted toward
  // headcount and scheduled hours, with nothing marking them inactive. A
  // manager could dispatch someone who no longer works here, or read labor
  // numbers that included them.
  //
  // Only FUTURE work is cancelled. Past assignments are history — they are what
  // the hours and payroll were built from, and rewriting them would change what
  // someone was paid for work they actually did.
  if (deactivated) {
    // Revoke the shop-floor PIN too. The magic link and the crew login both
    // filter on `active`, but the PIN is checked against a stored hash and was
    // left in place — the one credential that outlived the deactivation.
    const { error: pinErr } = await sb
      .from("commercial_employees")
      .update({ clock_pin_hash: null })
      .eq("id", id);
    if (pinErr) {
      console.warn(`[field-ops/employees] could not clear the clock PIN for ${id}:`, pinErr.message);
    }
    const { todayEtIso } = await import("./schedule");
    const { error: cancelErr } = await sb
      .from("commercial_assignments")
      .update({ status: "cancelled" })
      .eq("employee_id", id)
      .gte("work_date", todayEtIso())
      .neq("status", "cancelled");
    if (cancelErr) {
      console.warn(
        `[field-ops/employees] could not clear future shifts for ${id}:`,
        cancelErr.message
      );
    }
  }
  return { ok: true, employee };
}

/** Clock Station PIN — a shop-floor convenience credential (buddy-punch guard on
 *  a trusted shared device), NOT a security secret. Hashed with the employee id
 *  as salt. */
function pinHash(id: string, pin: string): string {
  return createHash("sha256").update(`${id}:${pin}`).digest("hex");
}

export async function setEmployeePin(
  id: string,
  pin: string,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = (pin ?? "").trim();
  if (!/^\d{4}$/.test(clean)) return { ok: false, error: "PIN must be 4 digits." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_employees")
    .update({ clock_pin_hash: pinHash(id, clean), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_employees", id, { clock_pin_hash: "***" }, { clock_pin_hash: "set" }, actorUserId);
  return { ok: true };
}

export async function verifyEmployeePin(id: string, pin: string): Promise<boolean> {
  const clean = (pin ?? "").trim();
  if (!/^\d{4}$/.test(clean)) return false;
  const sb = commercialDb();
  const { data } = await sb.from("commercial_employees").select("clock_pin_hash").eq("id", id).eq("active", true).maybeSingle();
  const stored = (data as { clock_pin_hash?: string | null } | null)?.clock_pin_hash;
  if (!stored) return false;
  return stored === pinHash(id, clean);
}

/** Which employees have a PIN set (for the Clock Station picker). */
export async function listClockablePins(): Promise<Set<string>> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_employees").select("id").eq("active", true).not("clock_pin_hash", "is", null);
  return new Set((data ?? []).map((r) => (r as { id: string }).id));
}
