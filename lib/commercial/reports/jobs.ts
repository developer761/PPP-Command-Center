import "server-only";

/**
 * The Jobs report — data loading.
 *
 * TWO surfaces, one set of definitions:
 *
 *  · `getJobsOverviewRows()` — every job, in ONE batch. Built on `listProjects`,
 *    the same source the Job-costs report and the Projects index already use, so
 *    a job's line here ties out with every rollup above it. Emphatically NOT a
 *    query per job: the Signatures report shipped with that shape and took
 *    seconds on a few dozen rows.
 *
 *  · `getJobReport(oppId, range)` — everything about ONE job. The money block
 *    comes from `getProjectFinancials` + `dealMargin`, which is EXACTLY what
 *    app/commercial/opportunities/[id]/page.tsx renders. Same helper, both
 *    callers — so the report and the deal page cannot disagree. Every other
 *    section is the existing per-tool reader (invoices, AIA, COs, purchases,
 *    crew, proposals, e-sign, documents, notes), each caught on its own so a
 *    single broken section degrades to a named warning rather than a 500.
 *
 * Nothing in this file re-derives money. If a figure is wrong, it is wrong in
 * the shared helper and wrong everywhere — which is the point.
 */

import { listAllProjects } from "./all-projects";
import { derivedOppName, getCommercialOpportunity, type CommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { getProjectFinancials, dealMargin, marginFrom, type ProjectFinancials, type DealMargin } from "@/lib/commercial/projects/financials";
import { listCommercialInvoices, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { listAiaApplications, aiaBillingRollupBulk, type AiaApplication } from "@/lib/commercial/aia/db";
import { listChangeOrders, type CommercialChangeOrder } from "@/lib/commercial/change-orders/db";
import { listPurchasesForProject, laborByWorkerForProject, type CommercialProjectPurchase, type LaborByWorker } from "@/lib/commercial/purchases/db";
import { fieldOpsCrewDetailForOpp, type CrewDetailForOpp } from "@/lib/commercial/field-ops/labor-cost";
import { listProposalsForOpp, type CommercialProposal } from "@/lib/commercial/proposals/db";
import { listSignatureRequestsForProposal, type SignatureRequest } from "@/lib/commercial/esign/db";
import { listDocumentsForParent, type CommercialDocument } from "@/lib/commercial/documents/db";
import { listAccountNotes, type AccountNoteWithAuthor } from "@/lib/commercial/account-notes";
import { listOpportunityTeam, type OpportunityAssignmentPerson } from "@/lib/commercial/opportunities/assignments";
import { commercialDb } from "@/lib/commercial/db";
import {
  jobAddressLine,
  jobDate,
  jobStatusGroup,
  round2,
  spendByCategory,
  spendByVendor,
  spendTotal,
  withinPeriod,
  type CategorySpendRow,
  type JobsReportRow,
  type VendorSpendRow,
} from "./jobs-rows";

// ─── Overview: every job, one batch ─────────────────────────────────────────

/**
 * EVERY deal — pre-sale bids included, closed jobs included, archived excluded.
 *
 * Deliberately NOT filtered the way the Job-costs report filters (it drops rows
 * with no contract, no cost and no billing to avoid padding a cost table). This
 * page's first job is to let somebody FIND a job and open its report, and a job
 * you can't find because it has no money on it yet is the one people go looking
 * for.
 */
export async function getJobsOverviewRows(): Promise<JobsReportRow[]> {
  const projects = await listAllProjects();

  // RETAINAGE, and only retainage, comes from somewhere else.
  //
  // `ProjectRow.retainageHeldCents` is the retainage on a deal's LATEST
  // application — drafts included. `getProjectFinancials` (and therefore the
  // deal page, and therefore this report's own per-job page) uses the latest
  // ISSUED one, via aiaBillingRollup. On a job with App 3 in prep over an
  // issued App 2, those are different numbers, and the list would have
  // disagreed with the page it links to.
  //
  // aiaBillingRollupBulk is the batched twin of the function the deal page
  // already uses — same `lineCompletedStoredCents`, same per-line retainage,
  // same `aiaBilledCollectedFrom` — so this is the identical figure, two
  // queries for the whole set. The wider ProjectRow inconsistency is left
  // alone: it is platform-wide, pre-dates this report, and quietly changing
  // what "retainage held" means on the dashboard is not a thing to do inside a
  // new feature.
  const aiaByOpp = await aiaBillingRollupBulk(projects.map((p) => p.opp.id)).catch((err) => {
    console.error("[reports/jobs] AIA rollup failed — retainage will read 0:", err);
    return new Map<string, { retainageHeldCents: number }>();
  });

  return projects.map((p) => {
    const o = p.opp;
    const m = marginFrom(p.billedContractCents, p.costsCents);
    const d = jobDate(o);
    return {
      oppId: o.id,
      accountId: p.accountId,
      accountName: p.accountName || "Unassigned account",
      jobName: derivedOppName(o, p.accountName),
      projectNumber: o.project_number,
      dealNumber: o.deal_number,
      address: jobAddressLine(o),
      status: o.status,
      subStatus: o.sub_status,
      group: jobStatusGroup(o),
      jobYmd: d.ymd,
      jobYmdIsDecided: d.isDecided,
      contractCents: p.contractToDateCents,
      hasContract: p.contractToDateCents > 0,
      billedCents: p.billedContractCents,
      collectedCents: p.paidCents,
      openBalanceCents: p.outstandingCents,
      retainageHeldCents: aiaByOpp.get(o.id)?.retainageHeldCents ?? 0,
      costCents: p.costsCents,
      marginCents: m.cents,
      marginPct: m.pct,
      marginProvisional: m.provisional,
      laborHours: p.laborHours,
      unratedHours: p.laborUnratedHours,
      invoiceCount: p.invoiceCount,
      pendingCoCount: p.pendingCoCount,
    } satisfies JobsReportRow;
  });
}

// ─── One job: everything ────────────────────────────────────────────────────

export type JobPeriod = { fromYmd: string; toYmd: string; label: string } | null;

export type { VendorSpendRow, CategorySpendRow };

export type JobProposalRow = {
  proposal: CommercialProposal;
  signatures: SignatureRequest[];
};

export type JobReport = {
  opp: CommercialOpportunity;
  accountId: string;
  accountName: string;
  jobName: string;
  address: string | null;
  group: ReturnType<typeof jobStatusGroup>;
  /** Whole-job money. NEVER narrowed by the period filter — a contract and an
   *  open balance are positions, not events in a window. */
  financials: ProjectFinancials | null;
  margin: DealMargin | null;
  /** The window applied to the itemised sections below; null = whole job. */
  period: JobPeriod;
  invoices: CommercialInvoice[];
  aiaApps: AiaApplication[];
  changeOrders: CommercialChangeOrder[];
  purchases: CommercialProjectPurchase[];
  byCategory: CategorySpendRow[];
  byVendor: VendorSpendRow[];
  /** In-house W-2 crew, from time entries. Narrowed by the period. */
  crew: CrewDetailForOpp;
  /** Manual subcontract-labor purchases — a DIFFERENT pot from `crew`. */
  subLabor: LaborByWorker[];
  proposals: JobProposalRow[];
  documents: CommercialDocument[];
  notes: AccountNoteWithAuthor[];
  team: OpportunityAssignmentPerson[];
  /** Sections whose query failed — named out loud instead of reading as empty. */
  failed: string[];
};

/** A section that fails costs one section, and says so. */
async function section<T>(name: string, fallback: T, failed: string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`[reports/jobs] ${name} failed:`, err);
    failed.push(name);
    return fallback;
  }
}

const ymd = (iso: string | null | undefined): string | null => (iso ? String(iso).slice(0, 10) : null);

export async function getJobReport(oppId: string, period: JobPeriod): Promise<JobReport | null> {
  const opp = await getCommercialOpportunity(oppId);
  if (!opp) return null;

  const from = period?.fromYmd ?? null;
  const to = period?.toYmd ?? null;
  const keep = (iso: string | null | undefined) => withinPeriod(ymd(iso), from, to);
  const failed: string[] = [];

  const [accountName, financials, invoices, aiaApps, changeOrders, purchases, crew, subLabor, proposalRows, documents, notes, team] =
    await Promise.all([
      section("GC", "", failed, async () => {
        const { data } = await commercialDb()
          .from("commercial_accounts")
          .select("company_name")
          .eq("id", opp.account_id)
          .maybeSingle();
        return ((data as { company_name: string } | null)?.company_name ?? "").trim();
      }),
      section<ProjectFinancials | null>("Money", null, failed, () => getProjectFinancials(oppId)),
      section<CommercialInvoice[]>("Invoices", [], failed, async () =>
        // An invoice belongs to the day it was ISSUED; a draft has no issue date
        // yet, so it is placed by when it was created rather than dropped.
        (await listCommercialInvoices({ opportunityId: oppId })).filter((i) => keep(i.issued_at ?? i.created_at))
      ),
      section<AiaApplication[]>("AIA applications", [], failed, async () =>
        (await listAiaApplications(oppId)).filter((a) => keep(a.period_to ?? a.frozen_at ?? a.created_at))
      ),
      section<CommercialChangeOrder[]>("Change orders", [], failed, async () =>
        (await listChangeOrders(oppId)).filter((c) => keep(c.decided_at ?? c.sent_at ?? c.created_at))
      ),
      section<CommercialProjectPurchase[]>("Costs", [], failed, async () =>
        (await listPurchasesForProject(oppId)).filter((p) => keep(p.purchased_at))
      ),
      section<CrewDetailForOpp>(
        "Crew labor",
        { workers: [], days: [], totalHours: 0, costCents: 0, unratedHours: 0 },
        failed,
        () => fieldOpsCrewDetailForOpp(oppId, period ? { fromYmd: period.fromYmd, toYmd: period.toYmd } : null)
      ),
      // Subcontract-labor purchases are already period-filtered via `purchases`
      // below for the cost tables; this per-worker roll-up is whole-job, and the
      // UI labels it so.
      section<LaborByWorker[]>("Subcontract labor", [], failed, () => laborByWorkerForProject(oppId)),
      section<JobProposalRow[]>("Proposals", [], failed, async () => {
        const props = (await listProposalsForOpp(oppId)).filter((p) => keep(p.sent_at ?? p.created_at));
        // N over the proposals of ONE job (typically 1–5), not over all jobs.
        return Promise.all(
          props.map(async (proposal) => ({
            proposal,
            signatures: await listSignatureRequestsForProposal(proposal.id).catch(() => [] as SignatureRequest[]),
          }))
        );
      }),
      section<CommercialDocument[]>("Documents", [], failed, async () => {
        // A job's files are filed under BOTH parent types depending on which
        // tool uploaded them; showing one is showing half the paperwork.
        const [a, b] = await Promise.all([
          listDocumentsForParent("opportunity", oppId),
          listDocumentsForParent("project", oppId).catch(() => [] as CommercialDocument[]),
        ]);
        const seen = new Set<string>();
        return [...a, ...b]
          .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
          .filter((d) => keep(d.uploaded_at ?? d.created_at))
          .sort((x, y) => String(y.uploaded_at ?? "").localeCompare(String(x.uploaded_at ?? "")));
      }),
      section<AccountNoteWithAuthor[]>("Notes", [], failed, async () =>
        // Account notes carry the deal they came from; only this job's belong here.
        (await listAccountNotes(opp.account_id))
          .filter((n) => n.source_opportunity_id === oppId)
          .filter((n) => keep(n.created_at))
      ),
      section<OpportunityAssignmentPerson[]>("Team", [], failed, () => listOpportunityTeam(oppId)),
    ]);

  return {
    opp,
    accountId: opp.account_id,
    accountName: accountName || "Unassigned account",
    jobName: derivedOppName(opp, accountName),
    address: jobAddressLine(opp),
    group: jobStatusGroup(opp),
    financials,
    margin: financials ? dealMargin(financials) : null,
    period,
    invoices,
    aiaApps,
    changeOrders,
    purchases,
    byCategory: spendByCategory(purchases),
    byVendor: spendByVendor(purchases),
    crew,
    subLabor,
    proposals: proposalRows,
    documents,
    notes,
    team,
    failed,
  };
}

// The cost roll-ups are pure, so they live in ./jobs-rows with the rest of the
// testable arithmetic. Re-exported here because this is where callers of the
// job report expect to find them.
export { spendByCategory, spendByVendor, spendTotal, round2 };
