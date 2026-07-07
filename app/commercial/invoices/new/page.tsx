/**
 * `/commercial/invoices/new?opp=<uuid>` — batch invoice creator.
 *
 * Karan 2026-07-07: user picks a Won opp from the invoices list, then
 * lands here to build 1-N invoices in a single form. Each row = one
 * draft invoice with description + amount + due date + optional PO.
 * Submit creates them all as drafts and returns to the opp detail page
 * where the InvoicesPanel shows them with progress bars.
 *
 * Server-side rules:
 *   - Only Won opps can be invoiced (redirects with error otherwise)
 *   - Empty rows are skipped
 *   - Each invoice gets a unique `PPP-INV-####` number via the sequence
 *   - Line item created from the row's description + amount as a single
 *     lump-sum entry ("Progress payment" style). Users can edit the
 *     line item on the detail page after create.
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
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { revalidatePath } from "next/cache";

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

  // Collect all rows from the form. Each row has description/amount/due_at
  // indexed by row number. Empty rows (no description AND no amount) skip.
  const rowIndexes = new Set<string>();
  for (const key of formData.keys()) {
    const match = key.match(/^row-(\d+)-/);
    if (match) rowIndexes.add(match[1]);
  }
  const rows = Array.from(rowIndexes)
    .sort((a, b) => Number(a) - Number(b))
    .map((idx) => ({
      description: String(formData.get(`row-${idx}-description`) ?? "").trim(),
      amount: String(formData.get(`row-${idx}-amount`) ?? "").trim(),
      due_at: String(formData.get(`row-${idx}-due_at`) ?? "").trim(),
      po_number: String(formData.get(`row-${idx}-po_number`) ?? "").trim(),
    }))
    .filter((r) => r.description !== "" || r.amount !== "");

  if (rows.length === 0) {
    redirect(`/commercial/invoices/new?opp=${opp_id}&error=` + encodeURIComponent("Add at least one invoice row."));
  }

  let created = 0;
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.description) {
      errors.push("A row is missing a description.");
      continue;
    }
    const cents = parseDollarsToCents(row.amount);
    if (cents === null || cents <= 0) {
      errors.push(`Row "${row.description.slice(0, 30)}" has an invalid amount.`);
      continue;
    }
    const due_at =
      row.due_at && /^\d{4}-\d{2}-\d{2}$/.test(row.due_at)
        ? `${row.due_at}T16:00:00.000Z`
        : undefined;

    const result = await createCommercialInvoice({
      opportunity_id: opp!.id,
      account_id: opp!.account_id,
      created_by_user_id: user.id,
      po_number: row.po_number || undefined,
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
  revalidatePath("/commercial/invoices");

  if (created === 0) {
    redirect(`/commercial/invoices/new?opp=${opp_id}&error=` + encodeURIComponent(errors[0] ?? "No invoices created."));
  }
  // Return to the opp detail; the InvoicesPanel will show the new rows.
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

  // Suggested due dates for the default 3 rows — Net 30, Net 60, Net 90.
  // Progress-billing UX assumption; users can override any row.
  const today = new Date();
  const suggestDue = (daysOut: number): string => {
    const d = new Date(today.getTime() + daysOut * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  const defaultRows = [
    { due_at: suggestDue(30), description: "Progress payment #1" },
    { due_at: suggestDue(60), description: "Progress payment #2" },
    { due_at: suggestDue(90), description: "Progress payment #3" },
  ];

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
          Add one invoice per row. Each becomes a draft with its own due date + invoice number. Skip any row you don't need.
        </p>
      </header>

      <form action={createBatchAction}>
        <input type="hidden" name="opp_id" value={opp!.id} />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-bold text-ppp-charcoal">Invoices to create</h2>
            <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
              We pre-filled 3 progress-billing rows (Net 30 · 60 · 90). Fill in the rows you want; leave the rest blank.
            </p>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {defaultRows.map((row, idx) => (
              <li key={idx} className="p-4 sm:p-5 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-100 text-cc-brand-700 text-[11px] font-bold">
                    {idx + 1}
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                    Invoice #{idx + 1}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3">
                  <div className="sm:col-span-6">
                    <label htmlFor={`row-${idx}-description`} className={LABEL_CLS}>
                      Description
                    </label>
                    <input
                      id={`row-${idx}-description`}
                      name={`row-${idx}-description`}
                      type="text"
                      maxLength={200}
                      defaultValue={row.description}
                      placeholder="What is this bill for?"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`row-${idx}-amount`} className={LABEL_CLS}>
                      Amount ($)
                    </label>
                    <input
                      id={`row-${idx}-amount`}
                      name={`row-${idx}-amount`}
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`row-${idx}-due_at`} className={LABEL_CLS}>
                      Due date
                    </label>
                    <input
                      id={`row-${idx}-due_at`}
                      name={`row-${idx}-due_at`}
                      type="date"
                      defaultValue={row.due_at}
                      className={INPUT_CLS}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor={`row-${idx}-po_number`} className={LABEL_CLS}>
                      PO # (optional)
                    </label>
                    <input
                      id={`row-${idx}-po_number`}
                      name={`row-${idx}-po_number`}
                      type="text"
                      maxLength={80}
                      className={INPUT_CLS}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="px-4 py-4 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/40 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="text-[12px] text-ppp-charcoal-500">
              Empty rows are skipped. You can edit line items, tax, and terms per invoice after creating.
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
