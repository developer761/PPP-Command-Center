import "server-only";

/**
 * Crew burdened cost rates (commercial_employee_rates) — the read/write side for
 * the Crew page. Effective-dated so history stays accurate: setting a new rate
 * closes the current one (effective_to = yesterday) and opens a new window from
 * today, rather than overwriting. Powers Option A's field-ops labor costing.
 *
 * Cost rate = BURDENED hourly cost (wage + taxes + overhead) — NOT the pay rate.
 * Admin-only writes (gated at the call site).
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { etTodayIso } from "@/lib/date-et";

/** The current ($/hr, cents) cost rate for each employee (effective today), or
 *  absent from the map when none is on file. One query for the crew list. */
export async function currentCostRatesForEmployees(employeeIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const today = etTodayIso();
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_employee_rates")
    .select("employee_id, cost_rate_cents, effective_from, effective_to")
    .in("employee_id", ids)
    .lte("effective_from", today)
    .order("effective_from", { ascending: false });
  const rows = (data ?? []) as { employee_id: string; cost_rate_cents: number; effective_from: string; effective_to: string | null }[];
  for (const r of rows) {
    if (out.has(r.employee_id)) continue; // newest-first → first hit is current
    if (r.effective_to == null || r.effective_to >= today) out.set(r.employee_id, r.cost_rate_cents);
  }
  return out;
}

export async function currentCostRate(employeeId: string): Promise<number | null> {
  const m = await currentCostRatesForEmployees([employeeId]);
  return m.get(employeeId) ?? null;
}

/**
 * Set an employee's burdened hourly cost rate from today forward. Closes any
 * open rate window (effective_to = yesterday) so exactly one rate is ever
 * effective on a given day; a same-day re-set replaces today's row instead of
 * stacking. Returns {ok} / {error}.
 */
export async function setCostRate(
  employeeId: string,
  costRateCents: number,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(costRateCents) || costRateCents < 0) return { ok: false, error: "Enter a valid cost rate (0 or more)." };
  if (costRateCents > 100_000_00) return { ok: false, error: "That cost rate looks too high — enter dollars/hour." };
  const sb = commercialDb();
  const today = etTodayIso();

  // A row already opened TODAY → update it in place (no zero-length windows).
  const { data: todays } = await sb
    .from("commercial_employee_rates")
    .select("*")
    .eq("employee_id", employeeId)
    .eq("effective_from", today)
    .maybeSingle();
  if (todays) {
    const before = todays;
    const { data: updated, error } = await sb
      .from("commercial_employee_rates")
      .update({ cost_rate_cents: costRateCents, effective_to: null })
      .eq("id", (todays as { id: string }).id)
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_employee_rates", (todays as { id: string }).id, before, updated, actorUserId);
    return { ok: true };
  }

  // Close the currently-open window (if any) at yesterday.
  const yesterday = new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  await sb
    .from("commercial_employee_rates")
    .update({ effective_to: yesterday })
    .eq("employee_id", employeeId)
    .is("effective_to", null)
    .lte("effective_from", today);

  const { data: inserted, error } = await sb
    .from("commercial_employee_rates")
    .insert({ employee_id: employeeId, cost_rate_cents: costRateCents, rate_type: "hourly", effective_from: today, effective_to: null })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_employee_rates", (inserted as { id: string }).id, inserted, actorUserId);
  return { ok: true };
}
