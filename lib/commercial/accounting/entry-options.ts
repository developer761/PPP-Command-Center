import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import type { SearchableOption } from "@/components/commercial/searchable-select";

/**
 * What Mary picks from when she records something in Accounting.
 *
 * One read for all three forms. Every list is searchable rather than a native
 * dropdown — 35 open invoices, 132 jobs and 44 vendors are each past the point
 * where scrolling works, and she is typing a name she already knows.
 */
export type AccountingEntryOptions = {
  /** Invoices with money still on them — you cannot pay a settled one. */
  openInvoices: SearchableOption[];
  jobs: SearchableOption[];
  vendors: SearchableOption[];
  /** Who has been paid for labor before, so the common ones are one tap. */
  payees: SearchableOption[];
};

export async function getAccountingEntryOptions(): Promise<AccountingEntryOptions> {
  const sb = commercialDb();

  const [opps, invoices, vendorRows, laborSpend] = await Promise.all([
    paginateAll<{
      id: string;
      account_id: string;
      title: string | null;
      client_name: string | null;
      title_override: string | null;
      title_override_mode: string | null;
      property_street: string | null;
      status: string;
    }>(() =>
      sb
        .from("commercial_opportunities")
        .select("id, account_id, title, client_name, title_override, title_override_mode, property_street, status")
        .is("deleted_at", null)
        .order("id", { ascending: true })
    ),
    paginateAll<{ id: string; invoice_number: string; opportunity_id: string | null; balance_cents: number; status: string }>(() =>
      sb
        .from("commercial_invoices")
        .select("id, invoice_number, opportunity_id, balance_cents, status")
        .is("deleted_at", null)
        .gt("balance_cents", 0)
        .order("id", { ascending: true })
    ),
    sb
      .from("commercial_vendors")
      .select("id, name")
      .is("deleted_at", null)
      .then((r) => (r.data ?? []) as { id: string; name: string | null }[]),
    paginateAll<{ vendor: string | null; category: string | null }>(() =>
      sb
        .from("commercial_project_purchases")
        .select("vendor, category")
        .eq("category", "labor")
        .is("deleted_at", null)
        .order("id", { ascending: true })
    ),
  ]);

  const { data: accounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(opps.map((o) => o.account_id))]);
  const acct = new Map(((accounts ?? []) as { id: string; company_name: string | null }[]).map((a) => [a.id, a.company_name]));
  const nameOf = new Map(
    opps.map((o) => [o.id, derivedOppName({ ...o, title: o.title ?? "" }, acct.get(o.account_id) ?? null)] as const)
  );

  // Live work first: a payment or a purchase almost always belongs to a job
  // that is running, and 56 closed jobs above them is 56 rows of scrolling.
  const rank = (status: string) =>
    status === "in_progress" ? 0 : status === "billing" ? 1 : status === "pre_construction" ? 2 : status === "post_sale_closed" ? 4 : 3;

  const jobs: SearchableOption[] = [...opps]
    .sort((a, b) => rank(a.status) - rank(b.status) || (nameOf.get(a.id) ?? "").localeCompare(nameOf.get(b.id) ?? ""))
    .map((o) => ({
      value: o.id,
      label: nameOf.get(o.id) ?? "Job",
      hint: acct.get(o.account_id) ?? undefined,
      group: o.status === "post_sale_closed" ? "Closed" : "Live jobs",
    }));

  /**
   * AIA CERTIFICATES BELONG IN THIS LIST TOO.
   *
   * Stephanie 2026-09-23: *"when I went into record the payment, it didn't
   * show up on the list because it was billed as AIA. Even on the open AIA's."*
   *
   * The picker read `commercial_invoices` and nothing else, so a job billed by
   * progress certificate — which is how Tomco bills most commercial work — had
   * nothing to select. The money had been received and there was no way to say
   * so from the screen whose entire job is saying so.
   *
   * Grouped rather than merged: an invoice and a G702 are different documents
   * and the person picking one knows which they are looking for. The value is
   * prefixed `aia:` so the action can tell the two ledgers apart — an id alone
   * cannot, and guessing wrong would post a payment into the wrong table.
   */
  const openInvoices: SearchableOption[] = invoices
    .sort((a, b) => Number(b.balance_cents) - Number(a.balance_cents))
    .map((i) => ({
      value: i.id,
      label: `${i.invoice_number} · ${i.opportunity_id ? nameOf.get(i.opportunity_id) ?? "Job" : "Job"}`,
      hint: `${formatCentsFull(Number(i.balance_cents))} outstanding`,
      group: "Invoices",
    }));

  const openAia = await listOpenAiaForPayment(nameOf);
  openInvoices.push(...openAia);

  const vendors: SearchableOption[] = (vendorRows ?? [])
    .filter((v) => (v.name ?? "").trim())
    .map((v) => ({ value: (v.name ?? "").trim(), label: (v.name ?? "").trim() }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const payeeCount = new Map<string, number>();
  for (const p of laborSpend) {
    const name = (p.vendor ?? "").trim();
    if (name) payeeCount.set(name, (payeeCount.get(name) ?? 0) + 1);
  }
  const payees: SearchableOption[] = [...payeeCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ value: name, label: name, hint: `${n} payment${n === 1 ? "" : "s"}` }));

  return { openInvoices, jobs, vendors, payees };
}

/**
 * Issued AIA applications with money still outstanding on them.
 *
 * "Outstanding" is G702 line 6 (Total Earned Less Retainage) minus what has
 * been recorded against that certificate — the same definition the application
 * screen shows, so the two never disagree about what is owed.
 *
 * Tolerates the payments table not existing yet: before migration
 * 20260924090000 is applied every certificate simply reads as fully
 * outstanding, which is what it was before payments could be recorded at all.
 */
async function listOpenAiaForPayment(
  nameOf: Map<string, string>,
): Promise<SearchableOption[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_aia_applications")
    .select("id, opportunity_id, application_number, status")
    // SUBMITTED ONLY.
    //
    // A 'paid' certificate has nothing outstanding by definition, and the ones
    // marked paid before payment records existed carry NO payment rows — so
    // "billed minus recorded" reads as fully outstanding and invites recording
    // the money a second time. On AIREF Building #1 that offered Application 2
    // at $66,833.31 outstanding when the job already counts it as collected:
    // one click from double-counting it.
    .in("status", ["submitted", "paid"])
    .is("deleted_at", null)
    .order("application_number", { ascending: true });
  if (error || !data) return [];

  const issued = data as {
    id: string;
    opportunity_id: string;
    application_number: number;
    status: string;
  }[];
  // Every ISSUED application is needed for the cumulative maths below — line 6
  // carries every prior period, so a certificate's own amount is the step up
  // from the one before it whatever ITS status is. Filtering the paid ones out
  // of this list made Application 3 on AIREF read $141,962.49 instead of
  // $75,129.18: the whole job instead of the period.
  const rows = issued.filter((r) => r.status === "submitted");
  if (rows.length === 0) return [];

  const [{ resolveG702 }, { listAiaPaymentsByApplication, sumAiaPayments }] = await Promise.all([
    import("@/lib/commercial/aia/db"),
    import("@/lib/commercial/aia/payments"),
  ]);
  const paymentsByApp = await listAiaPaymentsByApplication(rows.map((r) => r.id));

  const out: SearchableOption[] = [];
  for (const r of rows) {
    const g702 = await resolveG702(r.id);
    const billed = Math.round(g702?.totalEarnedLessRetainageCents ?? 0);
    if (billed <= 0) continue;
    // Line 6 is CUMULATIVE — it carries every prior period — so what THIS
    // certificate added is the step up from the one before it. Using line 6
    // raw would ask for the whole job on every application.
    const prior = issued
      .filter((x) => x.opportunity_id === r.opportunity_id && x.application_number < r.application_number)
      .pop();
    const priorBilled = prior
      ? Math.round((await resolveG702(prior.id))?.totalEarnedLessRetainageCents ?? 0)
      : 0;
    const thisPeriod = Math.max(0, billed - priorBilled);
    const paid = sumAiaPayments(paymentsByApp.get(r.id) ?? []);
    const outstanding = thisPeriod - paid;
    if (outstanding <= 0) continue;
    out.push({
      value: `aia:${r.id}`,
      label: `AIA No. ${r.application_number} · ${nameOf.get(r.opportunity_id) ?? "Job"}`,
      hint: `${formatCentsFull(outstanding)} outstanding`,
      group: "AIA certificates",
    });
  }
  return out;
}
