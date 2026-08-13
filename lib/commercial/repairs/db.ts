import "server-only";
import { POST_SALE_STATUSES } from "@/lib/commercial/opportunities/constants";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate } from "@/lib/commercial/audit-log";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { etDateOf } from "@/lib/date-et";

/**
 * Historical data repairs — the rows three bug fixes could not safely touch.
 *
 * F1, F2 and the decided_at cluster each stopped a defect from recurring, but
 * each left behind rows already carrying a wrong number. In all three cases the
 * correct value is recoverable from history — and in all three, SQL guessing at
 * it would silently rewrite a figure on a document a customer signed. So the
 * proposal is computed here and a person approves it, one row at a time.
 *
 * Every repair states its confidence. `exact` means the old value was read back
 * from an immutable log; `derived` means it was reconstructed from data that is
 * usually but not always right. Nothing is applied automatically.
 */

export type RepairConfidence = "exact" | "derived";

export type RepairRow = {
  id: string;
  label: string;
  sublabel: string | null;
  current: string;
  proposed: string;
  confidence: RepairConfidence;
  note: string | null;
  /** False when history doesn't hold the answer — shown, but not approvable. */
  applicable: boolean;
  /**
   * The machine values the repair would write.
   *
   * Kept separate from `proposed`, which is prose for a person to read. Parsing
   * the display string back into numbers works right up until someone changes a
   * currency format or a date order, and then it writes a wrong figure quietly.
   */
  apply?: Record<string, string | number>;
};

const money = (cents: number | null | undefined): string =>
  cents == null
    ? "—"
    : `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

// ── Repair 1 — the signed contract a re-quote erased (F1) ──────────────────

/**
 * Deals that were won, whose winning proposal was later superseded by a
 * revision, so nothing records what was actually signed.
 *
 * The true figure survives in the audit log: `updateProposalStatus` writes a
 * before/after pair on every flip, and the row where a proposal went from `won`
 * to `superseded` carries the won total in its `before_json`. That is the signed
 * contract, read back rather than inferred — hence `exact`.
 */
export async function findContractRepairs(): Promise<RepairRow[]> {
  const sb = commercialDb();
  const { data: oppRows } = await sb
    .from("commercial_opportunities")
    .select("id, title, project_number, account_id, status, sub_status, accepted_contract_cents")
    .is("deleted_at", null)
    .is("accepted_contract_cents", null)
    .in("status", ["pre_sale_closed", ...POST_SALE_STATUSES]);
  const opps = (oppRows ?? []) as Array<{
    id: string;
    title: string | null;
    project_number: number | null;
    account_id: string;
    status: string;
    sub_status: string | null;
  }>;
  // A lost bid was never signed; nothing to recover.
  const candidates = opps.filter((o) => !(o.status === "pre_sale_closed" && o.sub_status === "lost"));
  if (candidates.length === 0) return [];

  const ids = candidates.map((o) => o.id);
  // Only deals with NO live won proposal are broken — the rest are already fine.
  const { data: wonRows } = await sb
    .from("commercial_proposals")
    .select("opportunity_id")
    .in("opportunity_id", ids)
    .eq("status", "won")
    .is("deleted_at", null);
  const stillHasWon = new Set((wonRows ?? []).map((r) => (r as { opportunity_id: string }).opportunity_id));

  const { data: logRows } = await sb
    .from("commercial_audit_log")
    .select("row_id, before_json, after_json, created_at")
    .eq("table_name", "commercial_proposals")
    .eq("action", "update")
    .order("created_at", { ascending: false })
    .limit(2000);

  type LogRow = { row_id: string; before_json: Record<string, unknown> | null; after_json: Record<string, unknown> | null; created_at: string };
  const wonToSuperseded = new Map<string, { proposalId: string; cents: number; at: string }>();
  for (const r of (logRows ?? []) as LogRow[]) {
    const b = r.before_json ?? {};
    const a = r.after_json ?? {};
    if (String(b.status) !== "won" || String(a.status) !== "superseded") continue;
    const oppId = String(b.opportunity_id ?? a.opportunity_id ?? "");
    if (!oppId || wonToSuperseded.has(oppId)) continue; // newest wins (ordered desc)
    wonToSuperseded.set(oppId, {
      proposalId: r.row_id,
      cents: Number(b.total_cents) || 0,
      at: String(b.approved_at ?? r.created_at),
    });
  }

  return candidates
    .filter((o) => !stillHasWon.has(o.id))
    .map((o) => {
      const found = wonToSuperseded.get(o.id);
      return {
        id: o.id,
        label: derivedOppName(o as never, null),
        sublabel: o.project_number ? `OPP-${o.project_number}` : null,
        current: "no signed contract recorded",
        proposed: found ? money(found.cents) : "not recoverable",
        confidence: "exact" as const,
        note: found
          ? `From the audit log: this deal's proposal was superseded while it read "won".`
          : "No audit-log entry shows a won proposal being superseded — set this by hand from the signed document.",
        applicable: !!found && found.cents > 0,
        apply: found
          ? {
              accepted_contract_cents: found.cents,
              accepted_contract_proposal_id: found.proposalId,
              accepted_contract_set_at: found.at,
            }
          : undefined,
      };
    });
}

export async function applyContractRepair(
  oppId: string,
  userId: string,
  approvedProposal: string
): Promise<{ ok: boolean; error?: string }> {
  const rows = await findContractRepairs();
  const row = rows.find((r) => r.id === oppId);
  if (!row || !row.applicable) return { ok: false, error: "This deal is no longer repairable — reload the page." };
  // The screen shows a figure and the button posts an id, so the apply used to
  // write whatever a FRESH computation returned — which is not necessarily what
  // the admin read and approved. If someone re-marks a proposal won between the
  // render and the click, a different contract value gets stamped under their
  // name. Refuse when the proposal has moved.
  if (row.proposed !== approvedProposal) {
    return {
      ok: false,
      error: "This deal changed while the page was open — reload and check the new figure before approving.",
    };
  }

  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("id, accepted_contract_cents")
    .eq("id", oppId)
    .maybeSingle();
  const cents = Number(row.apply?.accepted_contract_cents ?? 0);
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: "Could not read the recovered amount." };

  const { data: after, error } = await sb
    .from("commercial_opportunities")
    .update({
      accepted_contract_cents: cents,
      // Provenance — migration 127 added these so a repaired figure can be
      // traced to a document instead of appearing unexplained on the deal.
      accepted_contract_proposal_id: row.apply?.accepted_contract_proposal_id ?? null,
      accepted_contract_set_at: row.apply?.accepted_contract_set_at ?? null,
    })
    // Only if still unset — someone may have fixed it while this page was open.
    .eq("id", oppId)
    .is("accepted_contract_cents", null)
    .select("id, accepted_contract_cents")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: "Already set by someone else — reload the page." };
  await logUpdate("commercial_opportunities", oppId, before, after, userId);
  return { ok: true };
}

// ── Repair 2 — certificates issued before they could be frozen (F2) ────────

/**
 * AIA applications that were issued before certificates started locking their
 * figures, so their cover sheet still recomputes on every read.
 *
 * The figures as issued are reconstructable from the continuation sheet, which
 * WAS frozen at seed: the change-order rows sum to line 2, and the rest of the
 * sheet is line 1. That also makes line 3 foot to the sheet total, which is the
 * invariant a certificate must satisfy. `derived`, not exact — a hand-edited
 * sheet moves the answer, and only the copy actually sent to the GC is proof.
 */
export async function findCertificateRepairs(): Promise<RepairRow[]> {
  const sb = commercialDb();
  const { data: appRows } = await sb
    .from("commercial_aia_applications")
    .select("id, application_number, opportunity_id, status, original_contract_cents, frozen_at")
    .is("deleted_at", null)
    .neq("status", "draft")
    .is("frozen_at", null);
  const apps = (appRows ?? []) as Array<{
    id: string;
    application_number: number;
    opportunity_id: string;
    status: string;
    original_contract_cents: number;
  }>;
  if (apps.length === 0) return [];

  const { data: lineRows } = await sb
    .from("commercial_aia_line_items")
    .select("application_id, scheduled_value_cents, change_order_id, item_no")
    .in("application_id", apps.map((a) => a.id));
  type Line = { application_id: string; scheduled_value_cents: number; change_order_id: string | null; item_no: string | null };
  const byApp = new Map<string, { sov: number; co: number }>();
  for (const l of (lineRows ?? []) as Line[]) {
    const cents = Math.round(Number(l.scheduled_value_cents)) || 0;
    const acc = byApp.get(l.application_id) ?? { sov: 0, co: 0 };
    acc.sov += cents;
    // Rows seeded before the foreign key existed are identifiable only by the
    // 'CO-001' naming the seed used.
    if (l.change_order_id || /^CO-\d+$/i.test(l.item_no ?? "")) acc.co += cents;
    byApp.set(l.application_id, acc);
  }

  return apps.map((a) => {
    const totals = byApp.get(a.id) ?? { sov: 0, co: 0 };
    const usable = totals.sov > 0;
    return {
      id: a.id,
      label: `Application No. ${a.application_number}`,
      sublabel: a.status === "paid" ? "paid" : "submitted",
      current: "recalculates on every view",
      proposed: usable
        ? `contract ${money(totals.sov - totals.co)} + change orders ${money(totals.co)}`
        : "not recoverable",
      confidence: "derived" as const,
      note: usable
        ? "Reconstructed from the frozen schedule of values, which makes the certificate foot. Check it against the copy sent to the GC before approving."
        : "This application has no schedule of values — nothing to reconstruct from.",
      applicable: usable,
    };
  });
}

export async function applyCertificateRepair(
  appId: string,
  userId: string,
  approvedProposal: string
): Promise<{ ok: boolean; error?: string }> {
  const rows = await findCertificateRepairs();
  const row = rows.find((r) => r.id === appId);
  if (!row || !row.applicable) return { ok: false, error: "This application is no longer repairable — reload the page." };
  if (row.proposed !== approvedProposal) {
    return {
      ok: false,
      error: "This application changed while the page was open — reload and check the new figures before approving.",
    };
  }

  const sb = commercialDb();
  const { data: lineRows } = await sb
    .from("commercial_aia_line_items")
    .select("scheduled_value_cents, change_order_id, item_no")
    .eq("application_id", appId);
  let sov = 0;
  let co = 0;
  for (const l of (lineRows ?? []) as Array<{ scheduled_value_cents: number; change_order_id: string | null; item_no: string | null }>) {
    const cents = Math.round(Number(l.scheduled_value_cents)) || 0;
    sov += cents;
    if (l.change_order_id || /^CO-\d+$/i.test(l.item_no ?? "")) co += cents;
  }
  if (sov <= 0) return { ok: false, error: "No schedule of values to reconstruct from." };

  const { data: before } = await sb
    .from("commercial_aia_applications")
    .select("id, contract_sum_frozen_cents, net_change_orders_frozen_cents, frozen_at")
    .eq("id", appId)
    .maybeSingle();
  const { data: after, error } = await sb
    .from("commercial_aia_applications")
    .update({
      contract_sum_frozen_cents: sov - co,
      net_change_orders_frozen_cents: co,
      frozen_at: new Date().toISOString(),
    })
    .eq("id", appId)
    .is("frozen_at", null)
    .select("id, contract_sum_frozen_cents, net_change_orders_frozen_cents, frozen_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: "Already frozen by someone else — reload the page." };
  await logUpdate("commercial_aia_applications", appId, before, after, userId);
  return { ok: true };
}

// ── Repair 3 — win dates overwritten by close-out ──────────────────────────

/**
 * Closed jobs whose win date was overwritten when their close-out finished.
 *
 * `decided_at` on these rows currently holds the CLOSE-OUT date. The real win
 * date is in the status log — the entry where the deal moved into
 * `pre_sale_closed`. `exact` when the log holds exactly one such entry; a deal
 * that was closed, reopened and re-closed is ambiguous and is left for a person.
 */
export async function findWinDateRepairs(): Promise<RepairRow[]> {
  const sb = commercialDb();
  const { data: oppRows } = await sb
    .from("commercial_opportunities")
    .select("id, title, project_number, account_id, decided_at, closed_out_at")
    .is("deleted_at", null)
    .eq("status", "post_sale_closed")
    .is("closed_out_at", null)
    .not("decided_at", "is", null);
  const opps = (oppRows ?? []) as Array<{
    id: string;
    title: string | null;
    project_number: number | null;
    account_id: string;
    decided_at: string;
  }>;
  if (opps.length === 0) return [];

  const { data: logRows } = await sb
    .from("commercial_opportunity_status_log")
    .select("opportunity_id, to_status, changed_at, loss_reason")
    .in("opportunity_id", opps.map((o) => o.id))
    .eq("to_status", "pre_sale_closed")
    // A LOSS lands in pre_sale_closed too, and the pair only differ by
    // sub-status — which this log doesn't carry. Without this filter a deal
    // that was lost, later re-won inside the same status (a sub-status-only
    // move, so no second log row), and eventually closed out would have its
    // win dated to the day it was LOST, in another quarter, presented as exact.
    .is("loss_reason", null)
    .order("changed_at", { ascending: true });
  const wins = new Map<string, string[]>();
  for (const r of (logRows ?? []) as Array<{ opportunity_id: string; changed_at: string }>) {
    const list = wins.get(r.opportunity_id) ?? [];
    list.push(r.changed_at);
    wins.set(r.opportunity_id, list);
  }

  return opps.map((o) => {
    const entries = wins.get(o.id) ?? [];
    const one = entries.length === 1;
    // ET, not UTC. Slicing the timestamp took the UTC day, so a win recorded
    // at 19:30 ET on 31 March became 1 April — moving a win into the wrong
    // month, which is the exact defect this repair exists to remove.
    const winDate = etDateOf(entries[0] ?? null);
    return {
      id: o.id,
      label: derivedOppName(o as never, null),
      sublabel: o.project_number ? `OPP-${o.project_number}` : null,
      current: `won ${o.decided_at.slice(0, 10)} (actually the close-out date)`,
      proposed: one && winDate ? `won ${winDate} · closed out ${o.decided_at.slice(0, 10)}` : "not recoverable",
      confidence: "exact" as const,
      note: one
        ? "The status log records exactly one move into Closed, so this is the win."
        : entries.length === 0
          ? "No status-log entry for this deal reaching Closed — set the win date by hand."
          : `This deal reached Closed ${entries.length} times, so which one is the win is ambiguous — set it by hand.`,
      applicable: one && !!winDate,
      apply:
        one && winDate ? { decided_at: winDate, closed_out_at: o.decided_at.slice(0, 10) } : undefined,
    };
  });
}

export async function applyWinDateRepair(
  oppId: string,
  userId: string,
  approvedProposal: string
): Promise<{ ok: boolean; error?: string }> {
  const rows = await findWinDateRepairs();
  const row = rows.find((r) => r.id === oppId);
  if (!row || !row.applicable) return { ok: false, error: "This deal is no longer repairable — reload the page." };
  if (row.proposed !== approvedProposal) {
    return {
      ok: false,
      error: "This deal changed while the page was open — reload and check the new dates before approving.",
    };
  }
  const decidedAt = String(row.apply?.decided_at ?? "");
  const closedOutAt = String(row.apply?.closed_out_at ?? "");
  if (!decidedAt || !closedOutAt) return { ok: false, error: "Could not read the recovered dates." };

  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("id, decided_at, closed_out_at")
    .eq("id", oppId)
    .maybeSingle();
  const { data: after, error } = await sb
    .from("commercial_opportunities")
    .update({ decided_at: decidedAt, closed_out_at: closedOutAt })
    .eq("id", oppId)
    .is("closed_out_at", null)
    .select("id, decided_at, closed_out_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: "Already repaired by someone else — reload the page." };
  await logUpdate("commercial_opportunities", oppId, before, after, userId);
  return { ok: true };
}
