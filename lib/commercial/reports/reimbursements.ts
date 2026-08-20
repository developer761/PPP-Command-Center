import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { etDateOf } from "@/lib/date-et";

/**
 * REIMBURSEMENTS — what the company owes its own people.
 *
 * "Tomco Reimbursements This Week" is one of Alex's thirteen reports. In
 * Salesforce these are Payment In rows with a memo ("Reimbursed for material
 * purchased"), which means the report can list what was PAID and can never tell
 * anyone what is still OWED. That is the half worth having: nobody chases the
 * company for $40 of caulk, they just remember it.
 *
 * So the report leads with what's outstanding, per person, oldest first — and
 * the settled list is underneath, which is the view his report shows.
 *
 * ⚠️ ASSUMPTION, worth one line of correction if it's wrong: a reimbursement
 * here is somebody fronting money for a job (a purchase they're owed back for),
 * not money a GC pays Tomco back for material. His data reads as the former
 * ("SHOP", "material purchased") and the former is the one that can go
 * un-tracked; if he means the latter, that's a payment-in classification and a
 * different (smaller) build.
 */

export type ReimbursementRow = {
  purchaseId: string;
  /** Who fronted the money. */
  person: string;
  purchasedYmd: string;
  amountCents: number;
  category: string;
  description: string | null;
  /** The job it was for, if any. */
  jobName: string | null;
  opportunityId: string | null;
  accountName: string | null;
  settledYmd: string | null;
  /** Days since the purchase — how long they've been out of pocket. */
  ageDays: number;
  /** The receipt, when one was attached. */
  hasReceipt: boolean;
  href: string | null;
};

export type ReimbursementPerson = {
  person: string;
  owedCents: number;
  count: number;
  /** Days the oldest unsettled item has been waiting. */
  oldestDays: number;
};

export type ReimbursementsReport = {
  /** Still owed, oldest first. */
  owed: ReimbursementRow[];
  /** Paid back inside the window. */
  settled: ReimbursementRow[];
  owedCents: number;
  settledCents: number;
  byPerson: ReimbursementPerson[];
  /** Owed with no receipt attached — the ones that will be argued about. */
  noReceiptCount: number;
  peopleOptions: string[];
  filtered: boolean;
  generatedAt: string;
};

export type ReimbursementFilters = {
  /** Applies to the SETTLED list (when it was paid back) — see the note below. */
  fromYmd?: string;
  toYmd?: string;
  person?: string;
};

/**
 * Split, total and rank. Pure, so the money is testable.
 *
 * The period filter deliberately applies to the SETTLED list only. What is
 * still owed is owed regardless of which week you're looking at, and hiding a
 * four-month-old debt because you picked "this week" is how it stays unpaid —
 * the same reasoning that keeps the receivables book on All time by default.
 */
export function summarizeReimbursements(
  allRows: ReimbursementRow[],
  filters: ReimbursementFilters = {},
  nowMs = Date.now()
): ReimbursementsReport {
  const { fromYmd, toYmd, person } = filters;
  const filtered = !!(fromYmd || toYmd || person);

  const byPerson = (r: ReimbursementRow) => !person || r.person === person;

  const owed = allRows
    .filter((r) => !r.settledYmd && byPerson(r))
    .sort((a, b) => a.purchasedYmd.localeCompare(b.purchasedYmd));

  const settled = allRows
    .filter((r) => {
      if (!r.settledYmd || !byPerson(r)) return false;
      if (fromYmd && r.settledYmd < fromYmd) return false;
      if (toYmd && r.settledYmd > toYmd) return false;
      return true;
    })
    .sort((a, b) => (b.settledYmd ?? "").localeCompare(a.settledYmd ?? ""));

  const people = new Map<string, ReimbursementPerson>();
  for (const r of owed) {
    const cur = people.get(r.person) ?? { person: r.person, owedCents: 0, count: 0, oldestDays: 0 };
    cur.owedCents += r.amountCents;
    cur.count += 1;
    cur.oldestDays = Math.max(cur.oldestDays, r.ageDays);
    people.set(r.person, cur);
  }

  return {
    owed,
    settled,
    owedCents: owed.reduce((n, r) => n + r.amountCents, 0),
    settledCents: settled.reduce((n, r) => n + r.amountCents, 0),
    // Most owed first — that's who to pay.
    byPerson: [...people.values()].sort((a, b) => b.owedCents - a.owedCents),
    noReceiptCount: owed.filter((r) => !r.hasReceipt).length,
    peopleOptions: [...new Set(allRows.map((r) => r.person))].sort((a, b) => a.localeCompare(b)),
    filtered,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

function daysBetweenEt(fromYmd: string, nowMs: number): number {
  const nowEt = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ny, nm, nd] = nowEt.split("-").map(Number);
  return Math.max(
    0,
    Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
  );
}

export async function getReimbursementsReport(
  filters: ReimbursementFilters = {},
  nowMs = Date.now()
): Promise<ReimbursementsReport> {
  const sb = commercialDb();
  const opps = await listCommercialOpportunities({ includeArchived: true });
  const oppById = new Map(opps.map((o) => [o.id, o] as const));
  const acctIds = [...new Set(opps.map((o) => o.account_id))];
  const nameById = new Map<string, string>();
  if (acctIds.length > 0) {
    const { data } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", acctIds);
    for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
      nameById.set(a.id, a.company_name ?? "—");
    }
  }

  const rows = await paginateAll<{
    id: string;
    opportunity_id: string | null;
    category: string | null;
    vendor: string | null;
    amount_cents: number | null;
    purchased_at: string | null;
    description: string | null;
    receipt_document_id: string | null;
    reimburse_to: string | null;
    reimbursed_at: string | null;
  }>(() =>
    sb
      .from("commercial_project_purchases")
      .select(
        "id, opportunity_id, category, vendor, amount_cents, purchased_at, description, receipt_document_id, reimburse_to, reimbursed_at"
      )
      .is("deleted_at", null)
      // Only reimbursements — an ordinary company purchase has no `reimburse_to`.
      .not("reimburse_to", "is", null)
      .order("purchased_at", { ascending: true })
      .order("id", { ascending: true })
  );

  const out: ReimbursementRow[] = [];
  for (const p of rows) {
    const person = p.reimburse_to?.trim();
    if (!person || !p.amount_cents) continue;
    const purchasedYmd = p.purchased_at ? etDateOf(p.purchased_at) : null;
    if (!purchasedYmd) continue;
    const opp = p.opportunity_id ? oppById.get(p.opportunity_id) : null;
    const accountName = opp ? nameById.get(opp.account_id) ?? null : null;
    out.push({
      purchaseId: p.id,
      person,
      purchasedYmd,
      amountCents: p.amount_cents,
      category: p.category ?? "other",
      // Vendor is the useful description here — "Aboffs, $40" tells you what it
      // was; the free-text note is the fallback.
      description: p.vendor?.trim() || p.description?.trim() || null,
      jobName: opp ? derivedOppName(opp, accountName) : null,
      opportunityId: p.opportunity_id,
      accountName,
      settledYmd: p.reimbursed_at ? etDateOf(p.reimbursed_at) : null,
      ageDays: daysBetweenEt(purchasedYmd, nowMs),
      hasReceipt: !!p.receipt_document_id,
      href: p.opportunity_id
        ? `/commercial/opportunities/${p.opportunity_id}?tab=transactions`
        : null,
    });
  }

  return summarizeReimbursements(out, filters, nowMs);
}

/** Mark a reimbursement paid back (or un-mark it). */
export async function setReimbursementSettled(
  purchaseId: string,
  settled: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ reimbursed_at: settled ? new Date().toISOString() : null })
    .eq("id", purchaseId);
  return error
    ? { ok: false, error: "Couldn't update that reimbursement. Please try again." }
    : { ok: true };
}
