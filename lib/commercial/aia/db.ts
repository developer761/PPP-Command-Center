/**
 * AIA billing data layer (Phase H). Service-role only — callers are server
 * actions that have passed assertCommercialAccess. Applications live on the
 * post-sale opportunity (the Project), like Change Orders + invoices.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { netApprovedChangeOrderCents, listChangeOrders } from "@/lib/commercial/change-orders/db";
import { listProposalsForOpp, listLineItemsForProposal } from "@/lib/commercial/proposals/db";
import { paginateAll } from "@/lib/commercial/paginate";
import {
  computeG702,
  aiaBilledCollectedFrom,
  lineCompletedStoredCents,
  pickContractBaseCents,
  isAiaChangeOrderLine,
  DEFAULT_RETAINAGE_PCT,
  type AiaG702,
  type AiaApplicationStatus,
  contractProposalCents,
  type ContractProposalRow,
} from "./constants";

export type AiaApplication = {
  id: string;
  opportunity_id: string;
  account_id: string;
  application_number: number;
  period_from: string | null;
  period_to: string | null;
  original_contract_cents: number;
  /** True once a person typed the contract sum here — see migration 130. */
  original_contract_is_manual: boolean;
  /**
   * G702 lines 1 and 2 as they stood when this certificate was ISSUED.
   *
   * Null while the application is a draft, and null on applications that predate
   * migration 128 — those still compute live, which the UI says out loud rather
   * than hiding.
   */
  contract_sum_frozen_cents: number | null;
  net_change_orders_frozen_cents: number | null;
  frozen_at: string | null;
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
  /**
   * Set when this row represents an approved change order.
   *
   * Matching was done on `item_no` ('CO-001'), which the operator can rename —
   * and a renamed row got re-inserted on the next sync, double-counting a change
   * order on a live certificate. The foreign key can't be typed over.
   */
  change_order_id: string | null;
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

/**
 * Retainage held on a job, as of its latest application.
 *
 * AIA line 5 is cumulative, so "held" is whatever the newest application says
 * — not a sum across applications, which would count the same withholding
 * once per pay period.
 *
 * The number is built by `computeG702`, the same function the printed G702 and
 * the Projects list use, so the deal page, the list and the PDF a GC receives
 * cannot disagree. Latest = highest application_number regardless of status,
 * matching the Projects list exactly. (A draft therefore counts. That is
 * arguably generous — the GC hasn't seen it — but one platform-wide number
 * beats two defensible ones.)
 */
export async function retainageHeldForOpportunity(opportunityId: string): Promise<number> {
  const apps = await listAiaApplications(opportunityId);
  if (apps.length === 0) return 0;
  const latest = apps.reduce((a, b) => (b.application_number > a.application_number ? b : a));
  const lines = await listAiaLineItems(latest.id);
  if (lines.length === 0) return 0;
  const { computeG702 } = await import("./constants");
  return computeG702({
    originalContractCents: latest.original_contract_cents,
    netChangeOrdersCents: 0, // irrelevant to line 5 — retainage is per-line off completed work
    retainagePct: latest.retainage_pct,
    lines,
    previousCertificatesCents: 0,
  }).retainageCents;
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
        // AIA invariant: G702 line 1 (Original Contract Sum) == Σ G703 BASE
        // scheduled values. When the contract was auto-defaulted (from the bid
        // midpoint) AND a schedule got seeded, snap the contract to the schedule
        // total so the certificate reconciles (otherwise % complete could exceed
        // 100% + the balance-to-finish go negative). An explicitly-provided
        // contract wins.
        //
        // EXCLUDE change-order rows: line 1 is the ORIGINAL contract, COs are
        // line 2 (Net change by Change Orders). Snapping to the full SOV (which
        // now carries one row per approved CO) put the COs on both lines, so
        // line 3 (Contract Sum to Date) double-counted every change order on a
        // deal without a sent proposal, with no user action (audit M2).
        if (contractWasDefaulted) {
          const lines = await listAiaLineItems(appRow.id);
          const baseSovTotal = lines
            .filter((l) => !isAiaChangeOrderLine(l))
            .reduce((s, l) => s + Math.round(l.scheduled_value_cents), 0);
          if (baseSovTotal > 0 && baseSovTotal !== appRow.original_contract_cents) {
            await sb
              .from("commercial_aia_applications")
              .update({ original_contract_cents: baseSovTotal })
              .eq("id", appRow.id);
            appRow.original_contract_cents = baseSovTotal;
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
          change_order_id: l.change_order_id ?? null,
        }));
        // Any change order approved SINCE the prior application has to join the
        // schedule of values here. This branch used to return without ever
        // reaching the change-order block below, so App 2 inherited App 1's
        // sheet verbatim: every CO approved between them showed up in line 2 of
        // the cover sheet and nowhere in the continuation sheet underneath it.
        // App 2 was born not adding up, before any freeze was involved.
        const carried = new Set(
          priorLines.map((l) => l.change_order_id).filter((x): x is string => !!x)
        );
        // Rows seeded BEFORE the foreign key existed carry a null id and are
        // identifiable only by the `CO-001` naming the seed used — migration 128
        // added the column with no backfill. Without this they get copied
        // forward verbatim AND re-appended, so App 2's schedule counts every
        // legacy change order twice. The partial unique index can't catch it
        // either, since it only covers non-null ids.
        const carriedNumbers = new Set(
          priorLines
            .map((l) => /^CO-0*(\d+)$/i.exec(l.item_no ?? "")?.[1])
            .filter((x): x is string => !!x)
        );
        const sinceCOs = (await listChangeOrders(app.opportunity_id)).filter(
          (c) =>
            c.status === "approved" &&
            !carried.has(c.id) &&
            !carriedNumbers.has(String(c.co_number))
        );
        let carryNo = rows.length + 1;
        for (const co of sinceCOs) {
          rows.push({
            application_id: app.id,
            position: carryNo * 1000,
            item_no: `CO-${String(co.co_number).padStart(3, "0")}`,
            description: `Change Order ${co.co_number}: ${co.title}`.slice(0, 500),
            // NOT clamped at zero — a deduct CO is a real credit line.
            scheduled_value_cents: Math.round(Number(co.amount_cents)),
            from_previous_cents: 0,
            this_period_cents: 0,
            materials_stored_cents: 0,
            change_order_id: co.id,
          });
          carryNo += 1;
        }
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
  const rows: Array<{
    application_id: string;
    position: number;
    item_no: string;
    description: string;
    scheduled_value_cents: number;
    from_previous_cents: number;
    this_period_cents: number;
    materials_stored_cents: number;
    change_order_id: string | null;
  }> = sov.map((li, i) => ({
    application_id: app.id,
    position: (i + 1) * 1000,
    item_no: String(i + 1),
    change_order_id: null,
    description:
      ([li.product_name, li.description].filter((x) => x && String(x).trim()).join(" — ") || "Line of work").slice(0, 500),
    scheduled_value_cents: Math.max(0, Math.round(Number(li.quantity) * li.unit_price_cents)),
    from_previous_cents: 0,
    this_period_cents: 0,
    materials_stored_cents: 0,
  }));

  // Reconcile the schedule of values so its total FOOTS to the G702 contract
  // ladder — otherwise the two AIA sheets sent to the GC don't match:
  //  (#2) a proposal final-price override makes total_cents != Σ(qty × price),
  //       so G702 line 1 (= the override) would diverge from the G703 scheduled
  //       column. SCALE each line proportionally to the contract sum — standard
  //       AIA practice for a lump-sum contract, and it keeps every scheduled
  //       value NON-NEGATIVE (grid + rollups clamp to ≥0), so an override
  //       DISCOUNT can't produce an invalid negative "credit" row.
  //  (#12) approved change orders feed G702 line 2 but weren't in the G703, so
  //       Σ scheduled_value != Contract Sum to Date (line 3). Add one SOV line per
  //       approved CO. (App 2+ copy these forward via the carry-forward seed.)
  const rawSum = rows.reduce((s, r) => s + r.scheduled_value_cents, 0);
  const contractCents = Math.round(Number(seedProposal.total_cents ?? 0));
  if (contractCents > 0 && rawSum > 0 && contractCents !== rawSum) {
    let acc = 0;
    rows.forEach((r, i) => {
      if (i === rows.length - 1) {
        r.scheduled_value_cents = Math.max(0, contractCents - acc); // last line absorbs rounding
      } else {
        r.scheduled_value_cents = Math.max(0, Math.round((r.scheduled_value_cents * contractCents) / rawSum));
        acc += r.scheduled_value_cents;
      }
    });
  }
  let nextNo = rows.length + 1;
  const approvedCOsAll = (await listChangeOrders(app.opportunity_id)).filter((c) => c.status === "approved");
  // Skip COs already billed on a live invoice — seeding one onto the schedule
  // of values charges the GC a second time for the same change (see the same
  // guard in reconcileDraftChangeOrderRows). A void/soft-deleted invoice
  // doesn't count as billed, so those COs still belong here.
  const seedPointedIds = [
    ...new Set(
      approvedCOsAll
        .map((c) => (c as { invoiced_invoice_id?: string | null }).invoiced_invoice_id)
        .filter(Boolean)
    ),
  ] as string[];
  const seedLiveInvoiceIds = new Set<string>();
  if (seedPointedIds.length > 0) {
    const { data: invRows } = await sb
      .from("commercial_invoices")
      .select("id, status, deleted_at")
      .in("id", seedPointedIds);
    for (const r of (invRows ?? []) as { id: string; status: string; deleted_at: string | null }[]) {
      if (r.status !== "void" && !r.deleted_at) seedLiveInvoiceIds.add(r.id);
    }
  }
  const approvedCOs = approvedCOsAll.filter((c) => {
    const invId = (c as { invoiced_invoice_id?: string | null }).invoiced_invoice_id;
    return !(invId && seedLiveInvoiceIds.has(invId));
  });
  for (const co of approvedCOs) {
    rows.push({
      application_id: app.id,
      position: nextNo * 1000,
      item_no: `CO-${String(co.co_number).padStart(3, "0")}`,
      description: `Change Order ${co.co_number}: ${co.title}`.slice(0, 500),
      // NOT clamped at zero. `amount_cents` is signed and negative means a
      // deduct — clamping made the whole batch insert fail the column's old
      // >= 0 CHECK, and the failure was swallowed, so the operator got an
      // application with a completely blank schedule of values and no error.
      scheduled_value_cents: Math.round(Number(co.amount_cents)),
      from_previous_cents: 0,
      this_period_cents: 0,
      materials_stored_cents: 0,
      change_order_id: co.id,
    });
    nextNo += 1;
  }
  await sb.from("commercial_aia_line_items").insert(rows);
}

/**
 * Keep a DRAFT application's schedule of values in step with the deal's approved
 * change orders.
 *
 * The G703 is seeded once, at creation. A change order approved AFTER that hit
 * G702 line 2 (netCO is computed live) but never got a G703 row, so the
 * certificate's two sheets stopped footing — line 3 (Contract Sum to Date) sat
 * above the G703 grand total by the new CO's amount on the document the GC
 * receives (audit F2). App 2+ pick up "COs since the prior app" via the
 * carry-forward seed; App 1 (and any single draft) had no such catch-up.
 *
 * Only ever touches a DRAFT: an ISSUED certificate freezes lines 1+2 at issue
 * and must never restate, so this is a no-op for anything else. Idempotent —
 * appends a row per approved CO not already present, and removes a CO row ONLY
 * when its CO is no longer approved AND nothing has been billed against it (a
 * row with billing is left for a human, since deleting it would drop money the
 * certificate already reported).
 */
export async function reconcileDraftChangeOrderRows(applicationId: string): Promise<void> {
  const app = await getAiaApplication(applicationId);
  if (!app || app.status !== "draft") return;
  const [lines, cos] = await Promise.all([
    listAiaLineItems(applicationId),
    listChangeOrders(app.opportunity_id),
  ]);
  const approved = cos.filter((c) => c.status === "approved");
  const approvedById = new Set(approved.map((c) => c.id));
  const approvedByNo = new Set(approved.map((c) => String(c.co_number)));

  const coRows = lines.filter((l) => isAiaChangeOrderLine(l));
  const presentIds = new Set<string>();
  const presentNos = new Set<string>();
  for (const l of coRows) {
    if (l.change_order_id) presentIds.add(l.change_order_id);
    const m = /^CO-0*(\d+)$/i.exec(l.item_no ?? "");
    if (m) presentNos.add(m[1]);
  }

  const sb = commercialDb();

  // Which invoices pointed at by a CO are void or soft-deleted — those don't
  // count as "already billed", so the CO legitimately belongs on the G703.
  const pointedInvoiceIds = [
    ...new Set(
      approved
        .map((c) => (c as { invoiced_invoice_id?: string | null }).invoiced_invoice_id)
        .filter(Boolean)
    ),
  ] as string[];
  const voidedOrDeletedInvoiceIds = new Set<string>();
  if (pointedInvoiceIds.length > 0) {
    const { data: invRows } = await sb
      .from("commercial_invoices")
      .select("id, status, deleted_at")
      .in("id", pointedInvoiceIds);
    for (const r of (invRows ?? []) as { id: string; status: string; deleted_at: string | null }[]) {
      if (r.status === "void" || r.deleted_at) voidedOrDeletedInvoiceIds.add(r.id);
    }
    // An id that resolved to no row at all is a dangling pointer — treat it as
    // not-billed so the CO still reaches the certificate.
    for (const id of pointedInvoiceIds) {
      if (!(invRows ?? []).some((r) => (r as { id: string }).id === id)) {
        voidedOrDeletedInvoiceIds.add(id);
      }
    }
  }

  // 1. Append approved COs that have no row yet.
  //
  // EXCLUDE COs already billed on a live invoice. The double-bill guard was
  // one-directional: `dealHasIssuedAia` warns when you tick a CO onto an
  // invoice for a deal that already has an AIA certificate, but nothing
  // stopped the reverse — a CO invoiced and sent to the GC then got seeded
  // onto the G703 as well, and G702 line 3 certified it a second time. The
  // GC receives two charges for the same change, and the deal's billed total
  // exceeds its own contract sum.
  const billedElsewhere = new Set(
    approved
      .filter((c) => {
        const invId = (c as { invoiced_invoice_id?: string | null }).invoiced_invoice_id;
        return Boolean(invId) && !voidedOrDeletedInvoiceIds.has(invId!);
      })
      .map((c) => c.id)
  );
  const missing = approved.filter(
    (c) => !presentIds.has(c.id) && !presentNos.has(String(c.co_number)) && !billedElsewhere.has(c.id)
  );
  if (missing.length > 0) {
    let pos = lines.reduce((m, l) => Math.max(m, l.position ?? 0), 0) + 1000;
    const rows = missing.map((co) => {
      const r = {
        application_id: applicationId,
        position: pos,
        item_no: `CO-${String(co.co_number).padStart(3, "0")}`,
        description: `Change Order ${co.co_number}: ${co.title}`.slice(0, 500),
        // Signed — a deduct CO is a real negative credit line.
        scheduled_value_cents: Math.round(Number(co.amount_cents)),
        from_previous_cents: 0,
        this_period_cents: 0,
        materials_stored_cents: 0,
        change_order_id: co.id,
      };
      pos += 1000;
      return r;
    });
    // UPSERT, and CHECK the error. This runs from a page render, so two people
    // opening the same draft certificate (or a render racing the PDF export)
    // both computed the same missing rows. Migration 128's unique index on
    // (application_id, change_order_id) then aborted the loser's WHOLE batch —
    // and the result was discarded, so the G703 silently rendered with the CO
    // rows missing while G702 line 2 still counted them. The certificate the GC
    // receives didn't foot, with nothing on screen to say why.
    const { error: insErr } = await sb
      .from("commercial_aia_line_items")
      .upsert(rows, { onConflict: "application_id,change_order_id", ignoreDuplicates: true });
    if (insErr) {
      console.error(
        `[commercial/aia] reconcileDraftChangeOrderRows: failed to add ${rows.length} change-order line(s) to application ${applicationId}: ${insErr.message}`
      );
    }
  }

  // 2. Remove CO rows whose CO is no longer approved AND carries no billing.
  for (const l of coRows) {
    const noMatch = /^CO-0*(\d+)$/i.exec(l.item_no ?? "");
    const stillApproved =
      (l.change_order_id ? approvedById.has(l.change_order_id) : false) ||
      (noMatch ? approvedByNo.has(noMatch[1]) : false);
    const billed =
      l.from_previous_cents + l.this_period_cents + l.materials_stored_cents !== 0;
    if (!stillApproved && !billed) {
      await sb
        .from("commercial_aia_line_items")
        .delete()
        .eq("id", l.id)
        .eq("application_id", applicationId);
    }
  }
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

  // ISSUING freezes G702 lines 1 and 2 onto the application.
  //
  // Both were recomputed on every read — line 1 from the live contract ladder,
  // line 2 from the live approved-change-order sum — while the G703 schedule of
  // values underneath them was written once and frozen. So approving a change
  // order next month moved line 3 (= 1 + 2) away from the G703 grand total, and
  // a certificate the GC already has a printed copy of quietly restated its
  // contract sum, percent complete and balance to finish.
  //
  // Computed BEFORE the status write, while the application is still a draft,
  // so `resolveG702` returns the live figures we mean to capture.
  if (patch.status !== undefined && patch.status !== "draft" && before.status === "draft") {
    const issued = await resolveG702(id);
    if (issued) {
      next.contract_sum_frozen_cents = issued.originalContractCents;
      next.net_change_orders_frozen_cents = issued.netChangeOrdersCents;
      next.frozen_at = new Date().toISOString();
    }
  }
  // Reopening to draft releases it. The guard above already refuses this when a
  // later application carries it forward, so the only certificates that get here
  // are ones nobody downstream depends on — and a draft is meant to track the
  // deal again.
  if (patch.status === "draft" && before.status !== "draft") {
    next.contract_sum_frozen_cents = null;
    next.net_change_orders_frozen_cents = null;
    next.frozen_at = null;
  }

  // Only a CHANGED value counts as hand-typed.
  //
  // The settings form posts every field on every autosave, so `!== undefined`
  // meant editing the period or the retainage silently flagged the contract as
  // manual — pinning the platform-wide contract to whatever this application
  // happened to store, above the won proposal. That is the same divergence
  // migrations 127/128 exist to prevent, reintroduced from the other side, and
  // it defeated migration 130's whole premise of a flag rather than a guess.
  if (
    patch.original_contract_cents !== undefined &&
    Number(patch.original_contract_cents) !== Number(before.original_contract_cents)
  ) {
    next.original_contract_is_manual = true;
  }
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
  let { data: updated, error } = await sb
    .from("commercial_aia_applications")
    .update(next)
    .eq("id", id)
    .eq("status", before.status)
    .is("deleted_at", null)
    .select(COLS)
    .maybeSingle();
  // Pre-migration-128/130 safety net, same reasoning as the opportunities
  // update: issuing an application writes the freeze columns, so a deploy that
  // lands ahead of the migration would fail every submit outright. Drop the new
  // columns and retry once — an unfrozen certificate is the behaviour that
  // existed before, a rejected submit is not.
  if (error && /contract_sum_frozen_cents|net_change_orders_frozen_cents|frozen_at|original_contract_is_manual/i.test(error.message)) {
    console.warn(
      "[commercial/aia] applications table is missing a freeze column — run migrations 128 and 130. Writing without them."
    );
    delete next.contract_sum_frozen_cents;
    delete next.net_change_orders_frozen_cents;
    delete next.frozen_at;
    delete next.original_contract_is_manual;
    ({ data: updated, error } = await sb
      .from("commercial_aia_applications")
      .update(next)
      .eq("id", id)
      .eq("status", before.status)
      .is("deleted_at", null)
      .select(COLS)
      .maybeSingle());
  }
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

/** Completion columns clamped to the direction the line can actually move. */
function clampCompletionToSign(line: {
  scheduled_value_cents?: number | null;
  from_previous_cents?: number | null;
  this_period_cents?: number | null;
  materials_stored_cents?: number | null;
}): {
  from_previous_cents: number;
  this_period_cents: number;
  materials_stored_cents: number;
} {
  const credit = Math.round(line.scheduled_value_cents ?? 0) < 0;
  const fit = (v: number) => (credit ? Math.min(0, v) : Math.max(0, v));
  return {
    from_previous_cents: fit(Math.round(line.from_previous_cents ?? 0)),
    this_period_cents: fit(Math.round(line.this_period_cents ?? 0)),
    materials_stored_cents: fit(Math.round(line.materials_stored_cents ?? 0)),
  };
}

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
    // Not clamped — an operator entering a credit line means it.
    scheduled_value_cents: Math.round(line.scheduled_value_cents ?? 0),
    // Completion follows the sign of the line: a normal line can't be billed
    // negative, a CREDIT line (a deductive change order) can only be billed
    // negative. Clamping everything at zero left a deduct row permanently at 0,
    // so the descoped work came off the contract sum but never off the amount
    // completed — and the job billed past 100%.
    ...clampCompletionToSign(line),
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
  //
  // BASE SOV only — line 1 is the ORIGINAL contract; the CO rows are line 2 and
  // are added back as `netCO` below. Feeding a CO-inclusive SOV to the ladder
  // made a deal with no sent proposal fall back to (base + COs) for line 1 while
  // netCO added the COs AGAIN on line 2, so line 3 double-counted them on the
  // customer-facing G702 (audit M2).
  const sovTotalCents = lines
    .filter((l) => !isAiaChangeOrderLine(l))
    .reduce((sum, l) => sum + Math.round(l.scheduled_value_cents), 0);

  // A certificate that has been issued is a document the GC is holding a printed
  // copy of. Once frozen, lines 1 and 2 come from the application itself and
  // stop tracking anything — approving a change order next month must not
  // restate a payment application already sent, and must not push line 3 away
  // from the G703 total underneath it.
  //
  // Only a DRAFT tracks live, which is what keeps a certificate being prepared
  // in step with the deal.
  if (app.status !== "draft" && app.frozen_at && app.contract_sum_frozen_cents != null) {
    return computeG702({
      originalContractCents: Number(app.contract_sum_frozen_cents) || 0,
      netChangeOrdersCents: Number(app.net_change_orders_frozen_cents ?? 0) || 0,
      retainagePct: app.retainage_pct,
      lines,
      previousCertificatesCents,
    });
  }

  const effectiveOriginalCents = pickContractBaseCents({
    hasBillingApp: true,
    originalContractCents: app.original_contract_cents,
    manualContractCents: app.original_contract_is_manual ? app.original_contract_cents : 0,
    sovTotalCents,
    acceptedProposalCents: ladder.acceptedProposalCents,
    acceptedSnapshotCents: ladder.acceptedSnapshotCents,
    latestProposalCents: ladder.latestProposalCents,
    pendingProposalCents: ladder.pendingProposalCents,
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
 * A deal's AIA billing collapsed into { billed, collected } so the deal
 * financials can include it (Phase D — AIA was a separate ledger invisible to
 * the P&L, so an AIA-billed job read "$0 billed" everywhere).
 *
 * `hasAia` distinguishes "no AIA applications" (leave the invoice-only figures
 * alone) from "AIA billed $0" (a real, if unusual, state). Definitions live in
 * `aiaBilledCollectedFrom`. Pre-tax throughout (the contract + invoice subtotals
 * this reconciles with are pre-tax).
 */
export async function aiaBillingRollup(
  opportunityId: string
): Promise<{
  billedCents: number;
  collectedCents: number;
  /** Currently-payable receivable: G702 line 6 minus collected. Excludes
   *  retainage by design — see aiaBilledCollectedFrom. */
  dueNowCents: number;
  /** Held back until close-out. Real money, just not yet due. */
  retainageHeldCents: number;
  hasAia: boolean;
}> {
  const apps = await listAiaApplications(opportunityId); // ordered by application_number asc
  const issued = apps.filter((a) => a.status === "submitted" || a.status === "paid");
  if (issued.length === 0)
    return {
      billedCents: 0,
      collectedCents: 0,
      dueNowCents: 0,
      retainageHeldCents: 0,
      hasAia: false,
    };

  // Billed = latest ISSUED app's Total Completed & Stored; collected = latest
  // PAID app's Total Earned Less Retainage. Both cumulative lines off one app.
  const latestIssued = issued[issued.length - 1];
  const paidApps = apps.filter((a) => a.status === "paid");
  const latestPaid = paidApps.length > 0 ? paidApps[paidApps.length - 1] : null;

  const [latestIssuedG702, latestPaidG702] = await Promise.all([
    resolveG702(latestIssued.id),
    latestPaid && latestPaid.id !== latestIssued.id
      ? resolveG702(latestPaid.id)
      : Promise.resolve(null),
  ]);
  // If the latest issued app IS the latest paid app, reuse its G702.
  const latestPaidResolved =
    latestPaid == null ? null : latestPaid.id === latestIssued.id ? latestIssuedG702 : latestPaidG702;

  const { billedCents, collectedCents, dueNowCents, retainageHeldCents } = aiaBilledCollectedFrom({
    latestIssued: latestIssuedG702,
    latestPaid: latestPaidResolved,
  });
  return { billedCents, collectedCents, dueNowCents, retainageHeldCents, hasAia: true };
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
): Promise<{
  acceptedProposalCents: number;
  acceptedSnapshotCents: number;
  latestProposalCents: number;
  pendingProposalCents: number;
  bidMidCents: number;
}> {
  const sb = commercialDb();
  const [{ data: oppRow }, { data: propRows }] = await Promise.all([
    sb
      .from("commercial_opportunities")
      .select("bid_value_low_cents, bid_value_high_cents, accepted_contract_cents")
      .eq("id", opportunity_id)
      .maybeSingle(),
    sb
      .from("commercial_proposals")
      .select("total_cents, status, revision_number")
      .eq("opportunity_id", opportunity_id)
      .is("deleted_at", null)
      .order("id", { ascending: true }),
  ]);
  const o = oppRow as {
    bid_value_low_cents: number | null;
    bid_value_high_cents: number | null;
    accepted_contract_cents?: number | string | null;
  } | null;
  const acceptedSnapshotCents = Number(o?.accepted_contract_cents ?? 0) || 0;
  const bidMidCents =
    o?.bid_value_low_cents != null && o?.bid_value_high_cents != null
      ? Math.round((o.bid_value_low_cents + o.bid_value_high_cents) / 2)
      : o?.bid_value_low_cents ?? o?.bid_value_high_cents ?? 0;
  const { acceptedProposalCents, latestProposalCents, pendingProposalCents } = contractProposalCents(
    (propRows ?? []) as ContractProposalRow[]
  );
  return {
    acceptedProposalCents,
    acceptedSnapshotCents,
    latestProposalCents,
    pendingProposalCents,
    bidMidCents,
  };
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
      .select("id, original_contract_cents, original_contract_is_manual")
      .eq("opportunity_id", opportunity_id)
      .is("deleted_at", null)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
    contractLadderInputs(opportunity_id),
  ]);
  const app = appRow as {
    id: string;
    original_contract_cents: number;
    original_contract_is_manual: boolean;
  } | null;
  let sovTotalCents = 0;
  if (app) {
    const lines = await listAiaLineItems(app.id);
    // EXCLUDE change-order rows — this is the ORIGINAL contract base, and every
    // caller adds `netApprovedChangeOrderCents` on top of what comes back. The
    // two sibling paths already filter them (`resolveG702`, `listProjects`);
    // this one didn't, so a CO counted twice: once inside the SOV total and
    // once again when the caller added net COs. That inflated the deal's
    // contract-to-date, its margin-vs-contract, and the "revised contract sum"
    // printed on the change-order PDF the GC signs. (audit M2, third site)
    sovTotalCents = lines
      .filter((l) => !isAiaChangeOrderLine(l))
      .reduce((s, l) => s + Math.round(l.scheduled_value_cents), 0);
  }
  return pickContractBaseCents({
    hasBillingApp: !!app,
    originalContractCents: app?.original_contract_cents ?? 0,
    manualContractCents: app?.original_contract_is_manual ? app.original_contract_cents : 0,
    sovTotalCents,
    acceptedProposalCents: ladder.acceptedProposalCents,
    acceptedSnapshotCents: ladder.acceptedSnapshotCents,
    latestProposalCents: ladder.latestProposalCents,
    pendingProposalCents: ladder.pendingProposalCents,
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

// ── Bulk AIA billing rollup ────────────────────────────────────────────────

export type AiaRollupEntry = {
  billedCents: number;
  collectedCents: number;
  /** Currently payable: G702 line 6 minus collected. Excludes retainage. */
  dueNowCents: number;
  retainageHeldCents: number;
  hasAia: true;
  /** The latest ISSUED application — what a statement / aging row cites. */
  latestIssuedId: string;
  latestIssuedNumber: number;
  latestIssuedFrozenAt: string | null;
  latestIssuedPeriodTo: string | null;
};

/**
 * The same rollup as {@link aiaBillingRollup}, for MANY opportunities, in two
 * queries total.
 *
 * The per-opportunity version fans out: `listAiaApplications` plus up to two
 * `resolveG702` calls, each of which is several more round-trips. Calling it in
 * a loop — which the AR aging report, the AR statement and the account rollup
 * all did after AIA was folded into them — meant a page load issuing roughly
 * `5 × (number of opportunities)` SEQUENTIAL queries. At 200 live
 * opportunities that is over a thousand, one after another, before the report
 * renders. It worked on the handful of rows in the test data and would have
 * fallen over on a real book of business.
 *
 * Two queries here regardless of N: applications for every requested
 * opportunity, then line items for the latest-issued + latest-paid apps only.
 * The math is the SHARED `lineCompletedStoredCents` per-line rule and the pure
 * `aiaBilledCollectedFrom`, so figures stay penny-identical to the deal page
 * and the printed certificate — this is a batching change, not a second
 * definition.
 *
 * Opportunities with no issued application are simply absent from the map.
 */
export async function aiaBillingRollupBulk(
  opportunityIds: string[]
): Promise<Map<string, AiaRollupEntry>> {
  const out = new Map<string, AiaRollupEntry>();
  const ids = [...new Set(opportunityIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const sb = commercialDb();
  const apps = await paginateAll<{
    id: string;
    opportunity_id: string;
    application_number: number;
    status: string;
    retainage_pct: number;
    frozen_at: string | null;
    period_to: string | null;
  }>(() =>
    sb
      .from("commercial_aia_applications")
      .select("id, opportunity_id, application_number, status, retainage_pct, frozen_at, period_to")
      .in("opportunity_id", ids)
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  if (apps.length === 0) return out;

  // Highest application_number wins, matching listAiaApplications' ordering.
  type App = (typeof apps)[number];
  const latestIssued = new Map<string, App>();
  const latestPaid = new Map<string, App>();
  for (const a of apps) {
    if (a.status === "submitted" || a.status === "paid") {
      const cur = latestIssued.get(a.opportunity_id);
      if (!cur || a.application_number > cur.application_number) latestIssued.set(a.opportunity_id, a);
    }
    if (a.status === "paid") {
      const cur = latestPaid.get(a.opportunity_id);
      if (!cur || a.application_number > cur.application_number) latestPaid.set(a.opportunity_id, a);
    }
  }
  if (latestIssued.size === 0) return out;

  const wantedAppIds = [
    ...new Set([
      ...[...latestIssued.values()].map((a) => a.id),
      ...[...latestPaid.values()].map((a) => a.id),
    ]),
  ];
  const pctByApp = new Map<string, number>();
  for (const a of [...latestIssued.values(), ...latestPaid.values()]) {
    pctByApp.set(a.id, Math.min(100, Math.max(0, a.retainage_pct)));
  }

  const lines = await paginateAll<{
    application_id: string;
    scheduled_value_cents: number;
    from_previous_cents: number;
    this_period_cents: number;
    materials_stored_cents: number;
  }>(() =>
    sb
      .from("commercial_aia_line_items")
      .select("application_id, scheduled_value_cents, from_previous_cents, this_period_cents, materials_stored_cents")
      .in("application_id", wantedAppIds)
      .order("id", { ascending: true })
  );

  const completedByApp = new Map<string, number>();
  const retainageByApp = new Map<string, number>();
  for (const l of lines) {
    const done = lineCompletedStoredCents(l);
    completedByApp.set(l.application_id, (completedByApp.get(l.application_id) ?? 0) + done);
    // Retainage summed PER LINE at the app's rate — the same way computeG702 and
    // the G703 sheet do it, so rounding lands on the same penny.
    const pct = pctByApp.get(l.application_id) ?? 0;
    retainageByApp.set(
      l.application_id,
      (retainageByApp.get(l.application_id) ?? 0) + Math.round((done * pct) / 100)
    );
  }

  for (const [oppId, issued] of latestIssued) {
    const issuedCompleted = completedByApp.get(issued.id) ?? 0;
    const issuedRetainage = retainageByApp.get(issued.id) ?? 0;
    const paid = latestPaid.get(oppId);
    const paidCompleted = paid ? completedByApp.get(paid.id) ?? 0 : 0;
    const paidRetainage = paid ? retainageByApp.get(paid.id) ?? 0 : 0;

    const { billedCents, collectedCents, dueNowCents, retainageHeldCents } =
      aiaBilledCollectedFrom({
        latestIssued: {
          totalCompletedStoredCents: issuedCompleted,
          totalEarnedLessRetainageCents: issuedCompleted - issuedRetainage,
        },
        latestPaid: paid
          ? { totalEarnedLessRetainageCents: paidCompleted - paidRetainage }
          : null,
      });

    out.set(oppId, {
      billedCents,
      collectedCents,
      dueNowCents,
      retainageHeldCents,
      hasAia: true,
      latestIssuedId: issued.id,
      latestIssuedNumber: issued.application_number,
      latestIssuedFrozenAt: issued.frozen_at,
      latestIssuedPeriodTo: issued.period_to,
    });
  }
  return out;
}
