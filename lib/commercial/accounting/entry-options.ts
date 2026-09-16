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

  const openInvoices: SearchableOption[] = invoices
    .sort((a, b) => Number(b.balance_cents) - Number(a.balance_cents))
    .map((i) => ({
      value: i.id,
      label: `${i.invoice_number} · ${i.opportunity_id ? nameOf.get(i.opportunity_id) ?? "Job" : "Job"}`,
      hint: `${formatCentsFull(Number(i.balance_cents))} outstanding`,
    }));

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
