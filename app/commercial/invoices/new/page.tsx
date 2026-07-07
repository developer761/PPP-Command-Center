/**
 * `/commercial/invoices/new?opp=<uuid>` — batch invoice creator.
 *
 * Karan 2026-07-07: user picks a Won opp from the invoices list, then
 * lands here to build 1..N invoices in a single form. The row UI lives
 * in the client component <BatchInvoiceRows>; the server picks up
 * whatever `row-<id>-<field>` entries land in formData on submit.
 *
 * Each submitted row becomes:
 *   - A draft invoice with description + amount + due date + PO
 *   - Optional per-row details: payment_terms, tax_pct, customer_message, notes
 *   - A single line item (the "description" + "amount" as unit price × 1)
 *
 * Users can edit line items, tax, terms, etc. after creation from the
 * invoice detail page.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createCommercialInvoice } from "@/lib/commercial/invoices/db";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { parseDollarsToCents, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { revalidatePath } from "next/cache";
import BatchInvoiceRows from "@/components/commercial/batch-invoice-rows";

export const dynamic = "force-dynamic";

type SP = Promise<{ opp?: string; error?: string }>;

async function createBatchAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/invoices");
  const opp = await getCommercialOpportunity(opp_id);
  if (!opp) redirect("/commercial/invoices?status_error=" + encodeURIComponent("Opportunity not found"));
  if (opp!.status !== "won") {
    redirect(`/commercial/opportunities/${opp!.id}?tab=info&error=` + encodeURIComponent("Only Won opportunities can be invoiced"));
  }

  // Collect all rows from the form. The client component uses monotonic
  // row IDs (which don't have to be contiguous), so we sniff prefixes.
  const rowIds = new Set<string>();
  for (const key of formData.keys()) {
    const match = key.match(/^row-(\d+)-/);
    if (match) rowIds.add(match[1]);
  }
  const rows = Array.from(rowIds)
    .sort((a, b) => Number(a) - Number(b))
    .map((rid) => ({
      description: String(formData.get(`row-${rid}-description`) ?? "").trim(),
      amount: String(formData.get(`row-${rid}-amount`) ?? "").trim(),
      due_at: String(formData.get(`row-${rid}-due_at`) ?? "").trim(),
      po_number: String(formData.get(`row-${rid}-po_number`) ?? "").trim(),
      payment_terms: String(formData.get(`row-${rid}-payment_terms`) ?? "").trim(),
      tax_pct: String(formData.get(`row-${rid}-tax_pct`) ?? "").trim(),
      customer_message: String(formData.get(`row-${rid}-customer_message`) ?? "").trim(),
      notes: String(formData.get(`row-${rid}-notes`) ?? "").trim(),
    }))
    // Skip rows the user cleared out. A row counts as "in use" only if
    // both description AND amount are filled — otherwise there's no
    // invoice worth creating.
    .filter((r) => r.description !== "" && r.amount !== "");

  if (rows.length === 0) {
    redirect(`/commercial/invoices/new?opp=${opp_id}&error=` + encodeURIComponent("Add at least one invoice with a description + amount."));
  }

  let created = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const cents = parseDollarsToCents(row.amount);
    if (cents === null || cents <= 0) {
      errors.push(`Row "${row.description.slice(0, 30)}" has an invalid amount.`);
      continue;
    }
    const due_at =
      row.due_at && /^\d{4}-\d{2}-\d{2}$/.test(row.due_at)
        ? `${row.due_at}T16:00:00.000Z`
        : undefined;
    const tax_pct_parsed = row.tax_pct !== "" ? parseFloat(row.tax_pct) : undefined;
    const tax_pct =
      typeof tax_pct_parsed === "number" && Number.isFinite(tax_pct_parsed) && tax_pct_parsed >= 0 && tax_pct_parsed <= 100
        ? tax_pct_parsed
        : undefined;

    const result = await createCommercialInvoice({
      opportunity_id: opp!.id,
      account_id: opp!.account_id,
      created_by_user_id: user.id,
      po_number: row.po_number || undefined,
      payment_terms: row.payment_terms || undefined,
      customer_message: row.customer_message || null,
      notes: row.notes || null,
      tax_pct,
      due_at,
      line_items: [
        {
          description: row.description,
          quantity: 1,
          unit_price_cents: cents,
        },
      ],
    });
    if (!result.ok) {
      errors.push(`Failed to create invoice: ${result.error}`);
    } else {
      created += 1;
    }
  }

  revalidatePath(`/commercial/opportunities/${opp!.id}`);
  revalidatePath(`/commercial/accounts/${opp!.account_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");

  if (created === 0) {
    redirect(`/commercial/invoices/new?opp=${opp_id}&error=` + encodeURIComponent(errors[0] ?? "No invoices created."));
  }
  const flash = new URLSearchParams({
    tab: "info",
    invoices_created: String(created),
  });
  if (errors.length > 0) flash.set("invoice_errors", String(errors.length));
  redirect(`/commercial/opportunities/${opp!.id}?${flash.toString()}`);
}

export default async function NewInvoiceRoute({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const opp_id = pickFirst(sp.opp);
  const error = pickFirst(sp.error);
  if (!opp_id || !UUID_RE.test(opp_id)) {
    redirect("/commercial/invoices?status_error=" + encodeURIComponent("Pick an opportunity first"));
  }

  const opp = await getCommercialOpportunity(opp_id!);
  if (!opp) redirect("/commercial/invoices?status_error=" + encodeURIComponent("Opportunity not found"));
  if (opp!.status !== "won") {
    redirect(`/commercial/opportunities/${opp!.id}?tab=info&error=` + encodeURIComponent("Only Won opportunities can be invoiced"));
  }
  const account = await getCommercialAccount(opp!.account_id);
  const bidMidpointCents =
    opp!.bid_value_low_cents != null && opp!.bid_value_high_cents != null
      ? Math.round((opp!.bid_value_low_cents + opp!.bid_value_high_cents) / 2)
      : null;

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Back link */}
      <Link
        href="/commercial/invoices"
        className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-800 min-h-[44px] touch-manipulation -ml-1 px-1"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        All invoices
      </Link>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {/* Hero */}
      <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal">
          Bill {opp!.title}
        </h1>
        <div className="mt-1 text-[13px] text-ppp-charcoal-600 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          {account && (
            <Link
              href={`/commercial/accounts/${account.id}`}
              className="text-blue-700 hover:text-blue-800 underline underline-offset-2 font-medium"
            >
              {account.company_name}
            </Link>
          )}
          <Link
            href={`/commercial/opportunities/${opp!.id}`}
            className="text-blue-700 hover:text-blue-800 underline underline-offset-2"
          >
            View opportunity
          </Link>
          {bidMidpointCents !== null && (
            <>
              <span aria-hidden>·</span>
              <span>
                <strong className="text-ppp-charcoal">{formatCentsCompact(bidMidpointCents)}</strong> mid-range contract value
              </span>
            </>
          )}
        </div>
        <p className="mt-3 text-[13px] text-ppp-charcoal-500">
          Start with one row and add more if you're progress-billing. Each row becomes a separate draft with its own due date + invoice number.
        </p>
      </header>

      <form action={createBatchAction}>
        <input type="hidden" name="opp_id" value={opp!.id} />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-bold text-ppp-charcoal">Invoices to create</h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              Description + amount + due date is the minimum. Open "More details" per row to add notes, terms, tax, or a customer message.
            </p>
          </div>
          <BatchInvoiceRows />
          <div className="px-4 py-4 border-t border-ppp-charcoal-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-[12px] text-ppp-charcoal-500">
              Rows without a description + amount are skipped. You can edit each invoice after it's created.
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Link
                href="/commercial/invoices"
                className="inline-flex items-center px-4 py-2 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
              >
                Cancel
              </Link>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
              >
                Create invoices
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
