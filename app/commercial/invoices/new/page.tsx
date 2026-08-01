/**
 * `/commercial/invoices/new?opp=<uuid>` — New invoice, IN the Invoices section.
 *
 * Karan 2026-08: creating a new invoice from the Invoices list used to redirect
 * into the Account → deal → Invoices tab (a jarring context yank). Now the
 * Invoices section has its OWN new-invoice page that renders the SAME builder the
 * deal tab uses (one consistent experience, two separate homes). After create it
 * returns to the Invoices list for that deal — never teleports to the account.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { isWon } from "@/lib/commercial/opportunities/constants";
import { listProposalsForOpp } from "@/lib/commercial/proposals/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { DealNewInvoiceForm } from "../../accounts/[id]/page";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string; error?: string; created?: string }>;

export default async function NewInvoicePage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Pick a deal first"));
  }
  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Deal not found"));
  }
  // Past the Won line — a project in delivery can still be invoiced.
  const billable =
    isWon(opp!) ||
    opp!.status === "pre_construction" ||
    opp!.status === "in_progress" ||
    opp!.status === "billing" ||
    opp!.status === "post_sale_closed";
  if (!billable) {
    redirect("/commercial/invoices?error=" + encodeURIComponent("Only Won deals can be invoiced"));
  }

  const account = await getCommercialAccount(opp!.account_id);
  const [proposals, invoices] = await Promise.all([
    listProposalsForOpp(opp!.id),
    listCommercialInvoices({ opportunityId: opp!.id }),
  ]);
  const dealName = derivedOppName(opp!, account?.company_name ?? "");
  // Create (and errors) return to THIS page — so the flow never leaves the
  // Invoices section: success shows a confirm banner + a link to the deal's
  // invoices, errors re-show the form. (This page's path starts with
  // /commercial/invoices, which the create action whitelists.)
  const returnTo = `/commercial/invoices/new?opp=${opp!.id}`;
  const dealInvoicesHref = `/commercial/invoices?opportunity_id=${opp!.id}`;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <Link
        href="/commercial/invoices"
        className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[44px]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
        Back to Invoices
      </Link>
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">New invoice</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{dealName}{account ? ` · ${account.company_name}` : ""}</p>
      </div>
      {sp.created === "1" ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800">
          <span className="inline-flex items-center gap-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3" /></svg>
            Invoice created.
          </span>
          <Link href={dealInvoicesHref} className="text-[12px] font-semibold underline shrink-0 min-h-[44px] inline-flex items-center">View this deal&rsquo;s invoices →</Link>
        </div>
      ) : null}
      {sp.error ? (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">{sp.error}</div>
      ) : null}
      <DealNewInvoiceForm
        accountId={opp!.account_id}
        oppId={opp!.id}
        propertyZip={opp!.property_zip ?? null}
        proposals={proposals}
        invoices={invoices}
        returnTo={returnTo}
      />
    </div>
  );
}
