/**
 * AIA billing data layer (Phase H). Service-role only — callers are server
 * actions that have passed assertCommercialAccess. Applications live on the
 * post-sale opportunity (the Project), like Change Orders + invoices.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { netApprovedChangeOrderCents } from "@/lib/commercial/change-orders/db";
import { listProposalsForOpp, listLineItemsForProposal } from "@/lib/commercial/proposals/db";
import {
  computeG702,
  pickContractBaseCents,
  DEFAULT_RETAINAGE_PCT,
  type AiaG702,
  type AiaApplicationStatus,
} from "./constants";

export type AiaApplication = {
  id: string;
  opportunity_id: string;
  account_id: string;
  application_number: number;
  period_from: string | null;
  period_to: string | null;
  original_contract_cents: number;
  retainage_pct: number;
  status: AiaApplicationStatus;
  notes: string | null;
  created_by_user_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AiaLineItem = {
  id: string;
  application_id: string;
  position: number;
  item_no: string | null;
  description: string;
  scheduled_value_cents: number;
  from_previous_cents: number;
  this_period_cents: number;
  materials_stored_cents: number;
  created_at: string;
  updated_at: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const COLS = "*";

export async function listAiaApplications(opportunityId: string): Promise<AiaApplication[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_applications")
    .select(COLS)
    .eq("opportunity_id", opportunityId)
    .is("deleted_at", null)
    .order("application_number", { ascending: true });
  return (data ?? []) as AiaApplication[];
}

export async function getAiaApplication(id: string): Promise<AiaApplication | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_applications")
    .select(COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as AiaApplication | null) ?? null;
}

export async function listAiaLineItems(applicationId: string): Promise<AiaLineItem[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_line_items")
    .select(COLS)
    .eq("application_id", applicationId)
    .order("position", { ascending: true });
  return (data ?? []) as AiaLineItem[];
}

export type CreateAiaApplicationInput = {
  opportunity_id: string;
  original_contract_cents?: number;
  retainage_pct?: number;
  period_from?: string | null;
  period_to?: string | null;
  created_by_user_id: string;
};

/**
 * Create an application. account_id + the post-sale gate come from the opp
 * (never trusted from the caller). application_number is max+1; the UNIQUE
 * constraint catches an insert race, retried once.
 */
export async function createAiaApplication(
  input: CreateAiaApplicationInput
): Promise<Result<AiaApplication>> {
  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at, status, sub_status, bid_value_low_cents, bid_value_high_cents")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || (opp as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "opportunity_not_found" };
  }
  const row = opp as {
    account_id: string;
    status: string | null;
    sub_status: string | null;
    bid_value_low_cents: number | null;
    bid_value_high_cents: number | null;
  };
  // No Won-gate (Karan 2026-08: AIA billing is available on every deal — the UI
  // exposes it on bids too; a bid simply has no applications yet).
  // Default the original contract to the deal's bid midpoint when not given.
  // (low ?? high ?? 0 — a high-only bid must not default to $0; matches the
  // other bid-mid helpers.)
  const bidMid =
    row.bid_value_low_cents != null && row.bid_value_high_cents != null
      ? Math.round((row.bid_value_low_cents + row.bid_value_high_cents) / 2)
      : row.bid_value_low_cents ?? row.bid_value_high_cents ?? 0;
  const contractWasDefaulted = input.original_contract_cents == null;
  const original = Math.max(0, Math.round(input.original_contract_cents ?? bidMid));
  const retainage =
    typeof input.retainage_pct === "number" && input.retainage_pct >= 0 && input.retainage_pct <= 100
      ? input.retainage_pct
      : DEFAULT_RETAINAGE_PCT;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: last } = await sb
      .from("commercial_aia_applications")
      .select("application_number")
      .eq("opportunity_id", input.opportunity_id)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const application_number = ((last as { application_number: number } | null)?.application_number ?? 0) + 1;
    const { data: inserted, error } = await sb
      .from("commercial_aia_applications")
      .insert({
        opportunity_id: input.opportunity_id,
        account_id: row.account_id,
        application_number,
        original_contract_cents: original,
        retainage_pct: retainage,
        period_from: input.period_from ?? null,
        period_to: input.period_to ?? null,
        status: "draft",
        created_by_user_id: input.created_by_user_id,
      })
      .select(COLS)
      .maybeSingle();
    if (!error && inserted) {
      const appRow = inserted as AiaApplication;
      await logInsert("commercial_aia_applications", appRow.id, appRow, input.created_by_user_id);
      // Seed the schedule of values so nobody retypes the contract breakdown:
      // first application → from the deal's latest proposal; later ones → carry
      // the prior application forward. Best-effort — a seed failure never blocks
      // the create (the operator can add lines manually).
      try {
        await seedAiaScheduleOfValues(appRow);
        // AIA invariant: G702 line 1 (contract sum) == Σ G703 scheduled values.
        // When the contract was auto-defaulted (from the bid midpoint) AND a
        // schedule got seeded, snap the contract to the schedule total so the
        // certificate reconciles (otherwise % complete could exceed 100% + the
        // balance-to-finish go negative). An explicitly-provided contract wins.
        if (contractWasDefaulted) {
          const lines = await listAiaLineItems(appRow.id);
          const sovTotal = lines.reduce((s, l) => s + Math.max(0, Math.round(l.scheduled_value_cents)), 0);
          if (sovTotal > 0 && sovTotal !== appRow.original_contract_cents) {
            await sb
              .from("commercial_aia_applications")
              .update({ original_contract_cents: sovTotal })
              .eq("id", appRow.id);
            appRow.original_contract_cents = sovTotal;
          }
        }
      } catch (e) {
        console.warn("[aia] schedule-of-values seed failed:", e instanceof Error ? e.message : String(e));
      }
      return { ok: true, value: appRow };
    }
    if (error && (error as { code?: string }).code === "23505") continue;
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  return { ok: false, error: "Couldn't assign an application number — please try again." };
}

/**
 * Seed a new application's G703 schedule of values.
 *  - Application 2+ → carry the immediately-prior live application forward:
 *    same lines + scheduled values, with "from previous" pre-filled with what
 *    was already completed+stored, and this-period reset to 0.
 *  - Application 1 → from the deal's latest proposal revision (each non-alternate
 *    line becomes a schedule-of-values row; scheduled value = qty × unit price).
 * No-op if there's nothing to seed from.
 */
async function seedAiaScheduleOfValues(app: AiaApplication): Promise<void> {
  const sb = commercialDb();

  if (app.application_number > 1) {
    const { data: prior } = await sb
      .from("commercial_aia_applications")
      .select("id")
      .eq("opportunity_id", app.opportunity_id)
      .lt("application_number", app.application_number)
      .is("deleted_at", null)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prior) {
      const priorLines = await listAiaLineItems((prior as { id: string }).id);
      if (priorLines.length > 0) {
        const rows = priorLines.map((l, i) => ({
          application_id: app.id,
          position: (i + 1) * 1000,
          item_no: l.item_no,
          description: l.description,
          scheduled_value_cents: l.scheduled_value_cents,
          // Everything completed/stored through the prior period becomes this
          // period's starting "from previous".
          from_previous_cents: l.from_previous_cents + l.this_period_cents + l.materials_stored_cents,
          this_period_cents: 0,
          materials_stored_cents: 0,
        }));
        await sb.from("commercial_aia_line_items").insert(rows);
        return;
      }
    }
    // No prior lines — fall through to the proposal seed.
  }

  const proposals = await listProposalsForOpp(app.opportunity_id);
  if (proposals.length === 0) return;
  // Seed from the WON proposal (the signed contract that drives G702 line 1), so
  // the G703 schedule-of-values total can't diverge from the contract sum. Fall
  // back to the latest revision when nothing is won yet — the same ladder as
  // pickContractBaseCents (won -> latest).
  const seedProposal = proposals.find((p) => p.status === "won") ?? proposals[0];
  const items = await listLineItemsForProposal(seedProposal.id);
  const sov = items.filter((li) => !li.is_alternate);
  if (sov.length === 0) return;
  const rows = sov.map((li, i) => ({
    application_id: app.id,
    position: (i + 1) * 1000,
    item_no: String(i + 1),
    description:
      ([li.product_name, li.description].filter((x) => x && String(x).trim()).join(" — ") || "Line of work").slice(0, 500),
    scheduled_value_cents: Math.max(0, Math.round(Number(li.quantity) * li.unit_price_cents)),
    from_previous_cents: 0,
    this_period_cents: 0,
    materials_stored_cents: 0,
  }));
  await sb.from("commercial_aia_line_items").insert(rows);
}

export async function updateAiaApplication(
  id: string,
  patch: Partial<Pick<AiaApplication, "period_from" | "period_to" | "original_contract_cents" | "retainage_pct" | "status" | "notes">>,
  userId: string
): Promise<Result<AiaApplication>> {
  const before = await getAiaApplication(id);
  if (!before) return { ok: false, error: "not_found" };
  // An ISSUED certificate (submitted/paid) is immutable except for its own
  // status — editing its contract/retainage/period would silently restate a
  // document already sent to the GC (and, via the line-6 carry-forward, a
  // downstream certificate too). Only a status-only patch is allowed on a
  // non-draft app.
  const isStatusOnly =
    patch.status !== undefined &&
    patch.period_from === undefined &&
    patch.period_to === undefined &&
    patch.original_contract_cents === undefined &&
    patch.retainage_pct === undefined &&
    patch.notes === undefined;
  if (!isStatusOnly && before.status !== "draft") {
    return { ok: false, error: "This application has been issued — reopen it to Draft before editing." };
  }
  // Block a status DOWNGRADE when a later application carries this one forward:
  // reopening a certified period would over-bill the next application.
  if (patch.status !== undefined && STATUS_RANK[patch.status] < STATUS_RANK[before.status]) {
    if (await laterApplicationExists(before.opportunity_id, before.application_number)) {
      return { ok: false, error: "A later application depends on this one — delete the later drafts before reopening it." };
    }
  }
  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.period_from !== undefined) next.period_from = patch.period_from;
  if (patch.period_to !== undefined) next.period_to = patch.period_to;
  if (patch.original_contract_cents !== undefined) {
    next.original_contract_cents = Math.max(0, Math.round(patch.original_contract_cents));
  }
  if (patch.retainage_pct !== undefined) {
    const p = Number(patch.retainage_pct);
    if (!Number.isFinite(p) || p < 0 || p > 100) return { ok: false, error: "Retainage must be between 0 and 100%." };
    next.retainage_pct = p;
  }
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.notes !== undefined) next.notes = patch.notes?.slice(0, 4000) ?? null;

  const sb = commercialDb();
  // 2026-07-29 re-audit fix (TOCTOU): compare-and-swap on the status we read,
  // so a concurrent "Submit application" can't interleave with an edit and
  // land a change on a certificate that just became issued.
  const { data: updated, error } = await sb
    .from("commercial_aia_applications")
    .update(next)
    .eq("id", id)
    .eq("status", before.status)
    .is("deleted_at", null)
    .select(COLS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "This application changed status in another tab — reload and try again." };
  const appRow = updated as AiaApplication;
  await logUpdate("commercial_aia_applications", id, before, appRow, userId);
  return { ok: true, value: appRow };
}

const STATUS_RANK: Record<AiaApplicationStatus, number> = { draft: 0, submitted: 1, paid: 2 };

/** True when a live application with a HIGHER number exists on the project —
 *  i.e. a later period may carry this one forward as a previous certificate. */
async function laterApplicationExists(opportunityId: string, applicationNumber: number): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_applications")
    .select("id")
    .eq("opportunity_id", opportunityId)
    .gt("application_number", applicationNumber)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return !!data;
}

export async function deleteAiaApplication(id: string, userId: string): Promise<Result<true>> {
  const before = await getAiaApplication(id);
  if (!before) return { ok: false, error: "not_found" };
  // Only a DRAFT can be deleted — an issued certificate has been sent to the GC
  // and (unless it's the last one) a later application carries it forward.
  if (before.status !== "draft") {
    return { ok: false, error: "Issued applications can't be deleted. Reopen to Draft first (only possible if no later application depends on it)." };
  }
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_aia_applications")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_aia_applications", id, before, userId);
  return { ok: true, value: true };
}

// ── G703 line items ──

export async function upsertAiaLineItem(
  applicationId: string,
  line: Partial<AiaLineItem> & { id?: string },
  actorUserId?: string
): Promise<Result<AiaLineItem>> {
  // Line items can only change while the application is a Draft — editing an
  // issued certificate's schedule of values would restate a document already
  // sent to the GC (and any downstream certificate).
  const app = await getAiaApplication(applicationId);
  if (!app) return { ok: false, error: "not_found" };
  if (app.status !== "draft") {
    return { ok: false, error: "This application has been issued — reopen it to Draft to edit line items." };
  }
  const sb = commercialDb();
  const payload = {
    application_id: applicationId,
    item_no: line.item_no ?? null,
    description: (line.description ?? "").slice(0, 500),
    scheduled_value_cents: Math.max(0, Math.round(line.scheduled_value_cents ?? 0)),
    from_previous_cents: Math.max(0, Math.round(line.from_previous_cents ?? 0)),
    this_period_cents: Math.max(0, Math.round(line.this_period_cents ?? 0)),
    materials_stored_cents: Math.max(0, Math.round(line.materials_stored_cents ?? 0)),
    updated_at: new Date().toISOString(),
    ...(line.position !== undefined ? { position: line.position } : {}),
  };
  if (line.id) {
    const { data, error } = await sb
      .from("commercial_aia_line_items")
      .update(payload)
      .eq("id", line.id)
      .eq("application_id", applicationId)
      .select(COLS)
      .maybeSingle();
    if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
    // 2026-07-29 re-audit fix: the G703 schedule of values IS the dollar
    // breakdown of a payment certificate — every change now leaves a trail.
    await logUpdate("commercial_aia_line_items", line.id, line, data, actorUserId ?? null);
    return { ok: true, value: data as AiaLineItem };
  }
  const { data, error } = await sb
    .from("commercial_aia_line_items")
    .insert(payload)
    .select(COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "insert_failed" };
  await logInsert("commercial_aia_line_items", (data as AiaLineItem).id, data, actorUserId ?? null);
  return { ok: true, value: data as AiaLineItem };
}

export async function deleteAiaLineItem(id: string, applicationId: string, actorUserId?: string): Promise<Result<true>> {
  const app = await getAiaApplication(applicationId);
  if (!app) return { ok: false, error: "not_found" };
  if (app.status !== "draft") {
    return { ok: false, error: "This application has been issued — reopen it to Draft to edit line items." };
  }
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_aia_line_items")
    .select(COLS)
    .eq("id", id)
    .eq("application_id", applicationId)
    .maybeSingle();
  const { error } = await sb
    .from("commercial_aia_line_items")
    .delete()
    .eq("id", id)
    .eq("application_id", applicationId);
  if (error) return { ok: false, error: error.message };
  // 2026-07-29 re-audit fix: log the deletion of an SOV line.
  if (before) await logDelete("commercial_aia_line_items", id, before, actorUserId ?? null);
  return { ok: true, value: true };
}

/**
 * Resolve the computed G702 certificate for an application: pulls the app's
 * inputs, its G703 lines, the live net approved change orders (Phase G), and
 * the "previous certificates" carry-forward (the immediately-prior SUBMITTED/
 * PAID application's Total Earned Less Retainage — line 6). Depth-guarded so a
 * corrupt chain can't recurse forever.
 */
export async function resolveG702(applicationId: string, _depth = 0): Promise<AiaG702 | null> {
  const app = await getAiaApplication(applicationId);
  if (!app) return null;
  const [lines, netCO, ladder] = await Promise.all([
    listAiaLineItems(applicationId),
    netApprovedChangeOrderCents(app.opportunity_id),
    contractLadderInputs(app.opportunity_id),
  ]);
  const previousCertificatesCents = _depth > 100 ? 0 : await priorCertificateCents(app, _depth);
  // In AIA, the G703 scheduled-value column totals to the contract sum (G702
  // line 1). The contract base follows the SAME shared ladder the Projects card
  // + deal P&L use — won proposal first, else latest proposal, else the AIA
  // original / SOV total — so the certificate's "Original Contract Sum" can't
  // diverge from every other surface for the same deal (2026-08 money audit #2:
  // cards showed $500k while the G702 sent to the GC showed a stale $450k).
  const sovTotalCents = lines.reduce((sum, l) => sum + Math.max(0, Math.round(l.scheduled_value_cents)), 0);
  const effectiveOriginalCents = pickContractBaseCents({
    hasBillingApp: true,
    originalContractCents: app.original_contract_cents,
    sovTotalCents,
    acceptedProposalCents: ladder.acceptedProposalCents,
    latestProposalCents: ladder.latestProposalCents,
    bidMidCents: ladder.bidMidCents,
  });
  return computeG702({
    originalContractCents: effectiveOriginalCents,
    netChangeOrdersCents: netCO,
    retainagePct: app.retainage_pct,
    lines,
    previousCertificatesCents,
  });
}

/**
 * The proposal-ladder + bid inputs for a deal's contract base — fetched the SAME
 * way by getEffectiveContractBaseCents (cards / P&L / Change Orders) AND
 * resolveG702 (the G702 certificate's "Original Contract Sum"), so no surface
 * can drift from another (2026-08 money audit #2). The signed proposal IS the
 * contract: WON first, else the LATEST proposal (highest revision), with a
 * deterministic id order so a max-revision TIE resolves identically everywhere.
 */
async function contractLadderInputs(
  opportunity_id: string
): Promise<{ acceptedProposalCents: number; latestProposalCents: number; bidMidCents: number }> {
  const sb = commercialDb();
  const [{ data: oppRow }, { data: propRows }] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("bid_value_low_cents, bid_value_high_cents")
      .eq("id", opportunity_id)
      .maybeSingle(),
    sb
      .from("commercial_proposals")
      .select("total_cents, status, revision_number")
      .eq("opportunity_id", opportunity_id)
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  ]);
  const o = oppRow as { bid_value_low_cents: number | null; bid_value_high_cents: number | null } | null;
  const bidMidCents =
    o?.bid_value_low_cents != null && o?.bid_value_high_cents != null
      ? Math.round((o.bid_value_low_cents + o.bid_value_high_cents) / 2)
      : o?.bid_value_low_cents ?? o?.bid_value_high_cents ?? 0;
  let acceptedProposalCents = 0;
  let latestProposalCents = 0;
  let latestRev = -1;
  for (const r of (propRows ?? []) as { total_cents: number; status: string; revision_number: number }[]) {
    if (r.status === "won") acceptedProposalCents = Math.max(acceptedProposalCents, Number(r.total_cents));
    if (r.revision_number > latestRev) {
      latestRev = r.revision_number;
      latestProposalCents = Number(r.total_cents);
    }
  }
  return { acceptedProposalCents, latestProposalCents, bidMidCents };
}

/**
 * The effective contract base for ONE deal, via the shared ladder — so the
 * Change Orders page's "contract to date" reconciles with the AIA G702, the
 * Projects card, and the Account 360 production KPIs. Approved COs add on top.
 */
export async function getEffectiveContractBaseCents(opportunity_id: string): Promise<number> {
  const sb = commercialDb();
  const [{ data: appRow }, ladder] = await Promise.all([
    sb
      .from("commercial_aia_applications")
      .select("id, original_contract_cents")
      .eq("opportunity_id", opportunity_id)
      .is("deleted_at", null)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    contractLadderInputs(opportunity_id),
  ]);
  const app = appRow as { id: string; original_contract_cents: number } | null;
  let sovTotalCents = 0;
  if (app) {
    const lines = await listAiaLineItems(app.id);
    sovTotalCents = lines.reduce((s, l) => s + Math.max(0, Math.round(l.scheduled_value_cents)), 0);
  }
  return pickContractBaseCents({
    hasBillingApp: !!app,
    originalContractCents: app?.original_contract_cents ?? 0,
    sovTotalCents,
    acceptedProposalCents: ladder.acceptedProposalCents,
    latestProposalCents: ladder.latestProposalCents,
    bidMidCents: ladder.bidMidCents,
  });
}

/** The prior issued application's Total Earned Less Retainage (line 6). */
async function priorCertificateCents(app: AiaApplication, depth: number): Promise<number> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_applications")
    .select("id, application_number")
    .eq("opportunity_id", app.opportunity_id)
    .lt("application_number", app.application_number)
    .in("status", ["submitted", "paid"])
    .is("deleted_at", null)
    .order("application_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prior = data as { id: string } | null;
  if (!prior) return 0;
  const g = await resolveG702(prior.id, depth + 1);
  return g?.totalEarnedLessRetainageCents ?? 0;
}
