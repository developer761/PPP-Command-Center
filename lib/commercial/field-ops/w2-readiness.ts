import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { currentCostRatesForEmployees } from "./rates";

/**
 * Is W-2 payroll ready to run, and what is still missing?
 *
 * Tomco 2026-09-24: *"Going over payroll with Mary and it looks like we need to
 * update the way that's done. With our W2 employees."*
 *
 * Every one of the 24 crew records is `worker_type = 'sub'` today, so the
 * payroll export — which is W-2 only by construction — can never produce a
 * row. Switching people over is a data change, and it has two failure modes
 * that are both silent:
 *
 *  1. FLIPPED WITH NO RATE. Job cost stops coming from what was paid out and
 *     starts coming from hours × rate. With no rate that is ZERO, so margins
 *     jump overnight and nothing on screen explains it. The employees page
 *     already warns about this; the number belongs where the money is read too.
 *
 *  2. FLIPPED AND STILL PAID AS A SUB. The two cost models are deliberately
 *     never summed — the rate is the base wage and the payout is 1.11× it, the
 *     same money counted once. An employee who keeps receiving labor payouts is
 *     costed TWICE on every job they touch, and the total still looks plausible
 *     because both halves are real.
 *
 * Nothing detected the second one. This does, and it reports zero honestly
 * rather than claiming readiness: with no W-2 employees at all the answer is
 * "not started", which is different from "ready".
 */

export type W2Readiness = {
  /** Active crew flagged as W-2. Zero means payroll cannot produce anything. */
  w2Count: number;
  /** Active crew still set up as subcontractors. */
  subCount: number;
  /** W-2 people with no cost rate — their hours cost $0 in job P&L. */
  missingRate: { id: string; name: string }[];
  /**
   * W-2 people who ALSO have labor payouts recorded against them. Every job
   * they touched is costed twice. The amount is what has been paid out to that
   * name, so the size of the problem is visible, not just its existence.
   */
  doubleCounted: { id: string; name: string; payoutCents: number; payments: number }[];
  /** Pay periods defined. Zero is fine — the export snaps to whole weeks. */
  payPeriodCount: number;
};

export async function getW2Readiness(): Promise<W2Readiness> {
  const sb = commercialDb();

  const { data: empRows, error: empErr } = await sb
    .from("commercial_employees")
    .select("id, display_name, worker_type, active");
  if (empErr) {
    console.error("[field-ops/w2-readiness] employee read failed:", empErr.message);
    return { w2Count: 0, subCount: 0, missingRate: [], doubleCounted: [], payPeriodCount: 0 };
  }
  const employees = (empRows ?? []) as {
    id: string;
    display_name: string;
    worker_type: string | null;
    active: boolean;
  }[];
  const active = employees.filter((e) => e.active);
  const w2 = active.filter((e) => e.worker_type === "w2");

  const rates = await currentCostRatesForEmployees(w2.map((e) => e.id));
  const missingRate = w2
    .filter((e) => !rates.has(e.id))
    .map((e) => ({ id: e.id, name: e.display_name }));

  // Labor payouts are recorded against a VENDOR NAME, not an employee id — the
  // money goes to a labor company. So the overlap is matched on the name the
  // roster shows, which is exactly the name the payment carries for the
  // "Tomco Labor - X" crew.
  const purchases = await paginateAll<{ vendor: string | null; amount_cents: number | null }>(() =>
    sb
      .from("commercial_project_purchases")
      .select("vendor, amount_cents")
      // BOTH kinds of labor. A person paid once as a sub and once through
      // payroll is the overlap this exists to find, and it would miss exactly
      // that if it only looked at one category.
      .in("category", ["labor", "employee_labor"])
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  );
  const paidTo = new Map<string, { cents: number; n: number }>();
  for (const p of purchases) {
    const name = (p.vendor ?? "").trim();
    if (!name) continue;
    const cur = paidTo.get(name) ?? { cents: 0, n: 0 };
    cur.cents += Number(p.amount_cents ?? 0);
    cur.n += 1;
    paidTo.set(name, cur);
  }
  const doubleCounted = findDoubleCounted(
    w2.map((e) => ({ id: e.id, name: e.display_name })),
    paidTo,
  );

  const { count: payPeriodCount } = await sb
    .from("commercial_pay_periods")
    .select("id", { count: "exact", head: true });

  return {
    w2Count: w2.length,
    subCount: active.length - w2.length,
    missingRate,
    doubleCounted,
    payPeriodCount: payPeriodCount ?? 0,
  };
}

/**
 * Which W-2 employees are ALSO being paid as subs — the overlap that costs a
 * job twice.
 *
 * Pure, and exported, because the live answer is currently an empty list: no
 * one is flagged W-2 yet, so a check run against production cannot show this
 * working and cannot show it failing either. A detector nobody has seen fire
 * is a guess, so the behaviour is pinned here instead.
 *
 * Matched on the roster NAME because a labor payout records a vendor, not an
 * employee id — the money goes to a labor company. Trimmed and
 * case-insensitive: "Tomco Labor - Greg" on the roster and "tomco labor - greg"
 * on a payment are the same man, and a costing error that hinges on
 * capitalisation is not one anybody would find.
 */
export function findDoubleCounted(
  w2: { id: string; name: string }[],
  paidTo: Map<string, { cents: number; n: number }>,
): { id: string; name: string; payoutCents: number; payments: number }[] {
  const byLower = new Map<string, { cents: number; n: number }>();
  for (const [name, v] of paidTo) {
    const k = name.trim().toLowerCase();
    const cur = byLower.get(k) ?? { cents: 0, n: 0 };
    byLower.set(k, { cents: cur.cents + v.cents, n: cur.n + v.n });
  }
  return w2
    .map((e) => {
      const hit = byLower.get(e.name.trim().toLowerCase());
      return hit ? { id: e.id, name: e.name, payoutCents: hit.cents, payments: hit.n } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.payoutCents - a.payoutCents);
}
