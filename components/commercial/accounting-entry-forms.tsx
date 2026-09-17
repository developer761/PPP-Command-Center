import { SearchableSelect, type SearchableOption } from "@/components/commercial/searchable-select";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { INPUT_CLS, LABEL_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";
import { OFFERED_PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META } from "@/lib/commercial/purchases/constants";

/**
 * The three things Mary does every day, on the page she already has open.
 *
 * Karan, 2026-09-16: "I want the accounting tab just to be for Mary and she can
 * do all of these things in that tab and doesn't need to go anywhere else on
 * the platform ideally."
 *
 * She records a payment that came in, a payment out to a labor crew, and a
 * purchase against a job — then produces the figures for the bookkeeper. All
 * three used to mean leaving Accounting: the invoice page for a payment, the
 * deal's cost tool for the other two. Each form here posts to the SAME action
 * those pages use, so nothing is a second way of writing the row.
 *
 * Every picker is searchable rather than a native select: 35 open invoices, 132
 * jobs and 44 vendors are all past the point where a dropdown is usable, and
 * Mary is typing a name she already knows.
 */

const TODAY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function FormCard({
  title,
  hint,
  children,
  action,
  submitLabel,
  pendingLabel,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  pendingLabel: string;
}) {
  return (
    <form
      action={action}
      // The purchase form carries a receipt file. Without this the file is
      // dropped on the way to the action and the purchase saves silently
      // without it — the worst shape of failure, because it looks like it
      // worked. Harmless on the two forms that have no file input.
      encType="multipart/form-data"
      className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3"
    >
      <div>
        <h3 className="text-sm font-bold text-ppp-charcoal">{title}</h3>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{hint}</p>
      </div>
      {children}
      <PendingSubmitButton
        pendingLabel={pendingLabel}
        className="inline-flex items-center justify-center gap-1.5 px-3 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] w-full sm:w-auto"
      >
        {submitLabel}
      </PendingSubmitButton>
    </form>
  );
}

/** Money in, against an invoice that is actually open. */
export function RecordPaymentForm({
  action,
  invoices,
}: {
  action: (formData: FormData) => void | Promise<void>;
  invoices: SearchableOption[];
}) {
  return (
    <FormCard
      title="Record a payment"
      hint="Money in, against an open invoice. It lands on the invoice, the job and the deposit list at once."
      action={action}
      submitLabel="Record payment"
      pendingLabel="Recording…"
    >
      {invoices.length === 0 ? (
        <p className="text-[12.5px] text-ppp-charcoal-500">Nothing is open — every invoice is paid.</p>
      ) : (
        <>
          <label data-tour="pay:invoice_id" className="block">
            <span className={LABEL_CLS}>Invoice *</span>
            <SearchableSelect name="invoice_id" options={invoices} required placeholder="Search by job or invoice number…" ariaLabel="Invoice" />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label data-tour="pay:amount" className="block">
              <span className={LABEL_CLS}>Amount *</span>
              <input name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT_CLS} />
            </label>
            <label data-tour="pay:paid_at" className="block">
              <span className={LABEL_CLS}>Date received *</span>
              <input type="date" name="paid_at" required defaultValue={TODAY()} className={INPUT_CLS} />
            </label>
            <label data-tour="pay:method" className="block">
              <span className={LABEL_CLS}>Method</span>
              <select name="method" defaultValue="check" className={SELECT_CLS} style={SELECT_BG_STYLE}>
                <option value="check">Check</option>
                <option value="ach">ACH / wire</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <label data-tour="pay:reference" className="block">
            <span className={LABEL_CLS}>Reference</span>
            <input name="reference" placeholder="Check number, wire ref…" className={INPUT_CLS} />
          </label>
        </>
      )}
    </FormCard>
  );
}

/** Money out to a crew — a Subcontract-labor purchase against the job. */
export function RecordLaborPaymentForm({
  action,
  jobs,
  payees,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: SearchableOption[];
  payees: SearchableOption[];
}) {
  return (
    <FormCard
      title="Record a labor payment"
      hint="Money out to a crew. Books against the job as a Subcontract cost, which is where crew labor is counted."
      action={action}
      submitLabel="Record payment out"
      pendingLabel="Recording…"
    >
      {/* Both spend forms post to one action; this is what tells them apart. */}
      <input type="hidden" name="kind" value="labor" />
      <label data-tour="labor:opportunity_id" className="block">
        <span className={LABEL_CLS}>Job *</span>
        <SearchableSelect name="opportunity_id" options={jobs} required placeholder="Search jobs…" ariaLabel="Job" />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label data-tour="labor:vendor" className="block sm:col-span-1">
          <span className={LABEL_CLS}>Paid to *</span>
          {/* Free text allowed: a new labor company should not need setting up
              before Mary can record what she just paid them. */}
          <SearchableSelect name="vendor" options={payees} required allowFreeText placeholder="Crew or labor company…" ariaLabel="Payee" />
        </label>
        <label data-tour="labor:amount" className="block">
          <span className={LABEL_CLS}>Amount *</span>
          <input name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT_CLS} />
        </label>
        <label data-tour="labor:purchased_at" className="block">
          <span className={LABEL_CLS}>Date paid *</span>
          <input type="date" name="purchased_at" required defaultValue={TODAY()} className={INPUT_CLS} />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label data-tour="labor:hours" className="block">
          <span className={LABEL_CLS}>Hours</span>
          <input name="hours" inputMode="decimal" placeholder="Optional" className={INPUT_CLS} />
        </label>
        <label data-tour="labor:description" className="block">
          <span className={LABEL_CLS}>Reference</span>
          <input name="description" placeholder="Check number, what it covered…" className={INPUT_CLS} />
        </label>
      </div>
    </FormCard>
  );
}

/** Money out to a supplier — materials and everything else. */
export function RecordPurchaseForm({
  action,
  jobs,
  vendors,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: SearchableOption[];
  vendors: SearchableOption[];
}) {
  return (
    <FormCard
      title="Record a purchase"
      hint="Money out to a supplier. Books against the job's costs and shows in Purchases straight away."
      action={action}
      submitLabel="Record purchase"
      pendingLabel="Recording…"
    >
      <input type="hidden" name="kind" value="purchase" />
      <label data-tour="purchase:opportunity_id" className="block">
        <span className={LABEL_CLS}>Job *</span>
        <SearchableSelect name="opportunity_id" options={jobs} required placeholder="Search jobs…" ariaLabel="Job" />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label data-tour="purchase:vendor" className="block">
          <span className={LABEL_CLS}>Vendor *</span>
          <SearchableSelect name="vendor" options={vendors} required allowFreeText placeholder="Search vendors…" ariaLabel="Vendor" />
        </label>
        <label data-tour="purchase:amount" className="block">
          <span className={LABEL_CLS}>Amount *</span>
          <input name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT_CLS} />
        </label>
        <label data-tour="purchase:purchased_at" className="block">
          <span className={LABEL_CLS}>Date *</span>
          <input type="date" name="purchased_at" required defaultValue={TODAY()} className={INPUT_CLS} />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label data-tour="purchase:category" className="block">
          <span className={LABEL_CLS}>Category</span>
          {/* Built from the offered list, so this cannot drift from the cost
              tool the way a second hand-written copy would. Labor is excluded
              here on purpose — it has its own form, with a payee and hours. */}
          <select name="category" defaultValue="materials" className={SELECT_CLS} style={SELECT_BG_STYLE}>
            {OFFERED_PURCHASE_CATEGORIES.filter((c) => c !== "labor").map((c) => (
              <option key={c} value={c}>
                {PURCHASE_CATEGORY_META[c].label}
              </option>
            ))}
          </select>
        </label>
        <label data-tour="purchase:description" className="block">
          <span className={LABEL_CLS}>Reference</span>
          <input name="description" placeholder="Receipt or invoice number…" className={INPUT_CLS} />
        </label>
      </div>
      <label data-tour="purchase:reimburse_to" className="block">
        <span className={LABEL_CLS}>Reimburse to</span>
        <input name="reimburse_to" placeholder="Leave blank unless somebody paid out of pocket" className={INPUT_CLS} />
      </label>
      {/* THE RECEIPT, HERE.
          Karan 2026-09-17: "where does she actually log a receipt currently? A
          bit confusing to input a receipt." There was no receipt field on this
          form at all — the only upload lived on the job's Costs tool, so filing
          one from the page Mary actually works on meant saving the purchase,
          finding the job, opening Costs, pressing Edit and attaching it there.
          `capture` so a phone opens the camera straight on the docket. */}
      <label data-tour="purchase:receipt" className="block">
        <span className={LABEL_CLS}>
          Receipt <span className="font-normal text-ppp-charcoal-400">(optional)</span>
        </span>
        <input
          name="receipt"
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif"
          capture="environment"
          className="block w-full text-base sm:text-[13px] text-ppp-charcoal-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-[13px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:min-h-[44px]"
        />
      </label>
    </FormCard>
  );
}
