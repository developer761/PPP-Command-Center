import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getCommercialAccount,
  type CommercialAccount,
} from "@/lib/commercial/accounts/db";
import {
  updateCommercialAccount,
  softDeleteCommercialAccount,
} from "@/lib/commercial/accounts/mutations";
import CommercialAddressFields from "@/components/commercial-address-fields";
import CommercialSiteAddressToggle from "@/components/commercial-site-address-toggle";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{ error?: string; confirm_delete?: string }>;

async function updateAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const id = String(formData.get("id") ?? "");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) redirect("/commercial/accounts");

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const getNum = (k: string) => {
    const v = get(k);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const company = get("company_name");
  if (!company) {
    redirect(`/commercial/accounts/${id}/edit?error=name_required`);
  }

  const result = await updateCommercialAccount(
    id,
    {
      company_name: company,
      dba: get("dba"),
      industry: get("industry"),
      rating: (get("rating") as "A" | "B" | "C" | null) ?? null,
      billing_street: get("billing_street"),
      billing_city: get("billing_city"),
      billing_state: get("billing_state"),
      billing_zip: get("billing_zip"),
      // "Same as billing" toggle: if set, copy billing → site so the
      // user doesn't retype. Site fields aren't rendered in this case.
      site_street: get("site_same_as_billing") === "1" ? get("billing_street") : get("site_street"),
      site_city: get("site_same_as_billing") === "1" ? get("billing_city") : get("site_city"),
      site_state: get("site_same_as_billing") === "1" ? get("billing_state") : get("site_state"),
      site_zip: get("site_same_as_billing") === "1" ? get("billing_zip") : get("site_zip"),
      phone: get("phone"),
      ap_phone: get("ap_phone"),
      website: get("website"),
      // Karan 2026-07-10 (Katie/Brendan notes): compliance fields
      // no longer captured on Accounts — moved to per-Opportunity.
      tax_exempt: formData.get("tax_exempt") === "on",
      tax_exempt_cert_number: get("tax_exempt_cert_number"),
      notes: get("notes"),
      is_key_relationship: formData.get("is_key_relationship") === "on",
    },
    user.id
  );

  if (!result.ok) {
    redirect(`/commercial/accounts/${id}/edit?error=${encodeURIComponent(result.error)}`);
  }
  // Karan 2026-07-08 propagation fix: audit found the account edit was
  // saving silently — no revalidatePath call meant the detail page +
  // list served stale data (company name, address, compliance status,
  // Key Relationship flag) until Next's default ISR window elapsed.
  // Now flushes every surface that reads account fields.
  revalidatePath(`/commercial/accounts/${id}`);
  revalidatePath("/commercial/accounts");
  revalidatePath("/commercial");
  // Symmetric with opp-edit: redirect with ?saved=1 so the detail page
  // surfaces an emerald "Changes saved." banner. Closes the silent-save
  // gap the persona walkthrough flagged.
  redirect(`/commercial/accounts/${id}?saved=1`);
}

async function deleteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const id = String(formData.get("id") ?? "");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) redirect("/commercial/accounts");

  const result = await softDeleteCommercialAccount(id, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${id}/edit?error=${encodeURIComponent(result.error)}`);
  }
  // Flush every surface that lists or scopes by this account so a
  // freshly-deleted row disappears immediately instead of lingering.
  revalidatePath(`/commercial/accounts/${id}`);
  revalidatePath("/commercial/accounts");
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  // After delete, the account detail page will 404 → bounce to the list
  redirect("/commercial/accounts?deleted=1");
}

export default async function EditCommercialAccountPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const account = await getCommercialAccount(id);
  if (!account) notFound();

  const errorMsg = sp.error;
  const confirmDelete = sp.confirm_delete === "1";

  return (
    <div className="space-y-6">
      <header>
        <Link
          href={`/commercial/accounts/${account.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-800 min-h-[44px] touch-manipulation -ml-1 px-1"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Back to account
        </Link>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mt-2 mb-3 bg-cc-brand-600" />
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">Edit account</h1>
        <p className="mt-1 text-sm text-ppp-charcoal-500">
          Editing <strong className="text-ppp-charcoal">{account.company_name}</strong>. Changes are logged to the audit trail.
        </p>
      </header>

      {errorMsg && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMsg === "name_required"
            ? "Company name is required."
            : `Couldn't save: ${errorMsg}`}
        </div>
      )}

      {/* Edit form — same shape as new account form */}
      <form action={updateAction} className="space-y-5 max-w-2xl">
        <input type="hidden" name="id" value={account.id} />

        <Section title="Identity" anchorId="edit-identity">
          <EditField id="company_name" label="Company name *" required defaultValue={account.company_name} />
          <EditField id="dba" label="DBA (doing business as)" defaultValue={account.dba ?? ""} />
          <EditField id="industry" label="Industry" placeholder="Real estate, hospitality, healthcare…" defaultValue={account.industry ?? ""} />
          <EditSelectField
            id="rating"
            label="Rating"
            options={[["", "—"], ["A", "A"], ["B", "B"], ["C", "C"]]}
            defaultValue={account.rating ?? ""}
          />
        </Section>

        <Section title="Billing address" anchorId="edit-billing">
          <CommercialAddressFields
            prefix="billing"
            defaults={{
              street: account.billing_street ?? "",
              city: account.billing_city ?? "",
              state: account.billing_state ?? "",
              zip: account.billing_zip ?? "",
            }}
          />
        </Section>

        <Section title="Primary site address" anchorId="edit-site">
          {/* Default the "Same as billing" toggle to ON when the existing
              site address matches billing (common case for accounts
              created before the toggle existed — they had to retype). */}
          <CommercialSiteAddressToggle
            defaultChecked={
              (account.site_street ?? "") === (account.billing_street ?? "") &&
              (account.site_city ?? "") === (account.billing_city ?? "") &&
              (account.site_state ?? "") === (account.billing_state ?? "") &&
              (account.site_zip ?? "") === (account.billing_zip ?? "")
            }
            defaults={{
              street: account.site_street ?? "",
              city: account.site_city ?? "",
              state: account.site_state ?? "",
              zip: account.site_zip ?? "",
            }}
          />
        </Section>

        <Section title="Contact" anchorId="edit-contact">
          <EditField id="phone" label="Main phone" type="tel" defaultValue={account.phone ?? ""} />
          <EditField id="ap_phone" label="Accounts Payable phone" type="tel" defaultValue={account.ap_phone ?? ""} />
          <EditField id="website" label="Website" type="url" defaultValue={account.website ?? ""} />
        </Section>

        {/* Karan 2026-07-10 (Katie/Brendan notes): Compliance section
            removed. Fields still exist in DB for audit trail but this
            form no longer writes them. Insurance certs + prequal docs
            now live per-Opportunity (Files sub-tab, Phase C). */}

        <Section title="Tax" anchorId="edit-tax">
          <label className="flex items-center gap-2 text-sm min-h-[44px]">
            <input
              type="checkbox"
              name="tax_exempt"
              defaultChecked={account.tax_exempt}
              className="h-5 w-5 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30"
            />
            Tax exempt
          </label>
          <EditField id="tax_exempt_cert_number" label="Tax exempt certificate #" defaultValue={account.tax_exempt_cert_number ?? ""} />
        </Section>

        <Section title="Strategic" anchorId="edit-strategic">
          <label className="flex items-start gap-3 text-sm min-h-[44px] cursor-pointer">
            <input
              type="checkbox"
              name="is_key_relationship"
              defaultChecked={Boolean(account.is_key_relationship)}
              className="h-5 w-5 mt-0.5 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30"
            />
            <span>
              <strong>★ Key Relationship</strong>
              <span className="block text-[12px] text-ppp-charcoal-500 mt-0.5">
                Strategic partnership: biggest GCs, recurring multi-year customers, decision-makers with personal trust. Surfaces a ★ badge across every list + card so high-value accounts pop on scan.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Notes" anchorId="edit-notes">
          <textarea
            id="notes"
            name="notes"
            rows={4}
            defaultValue={account.notes ?? ""}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 resize-y transition-colors"
          />
        </Section>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Link
            href={`/commercial/accounts/${account.id}`}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation"
          >
            Save changes
          </button>
        </div>
      </form>

      {/* Two-step delete — click to reveal, click again inside the panel
          to fire. URL-driven so a fresh load closes the panel. */}
      <section id="danger-zone" className="max-w-2xl mt-10 scroll-mt-20">
        {!confirmDelete ? (
          <Link
            href={`/commercial/accounts/${account.id}/edit?confirm_delete=1#danger-zone`}
            scroll={false}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-rose-700 hover:text-rose-800 hover:underline touch-manipulation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
            </svg>
            Delete this account
          </Link>
        ) : (
          <div className="space-y-3 bg-white border border-rose-300 rounded-lg p-4">
            <p className="text-sm text-ppp-charcoal-700">
              Delete <strong>{account.company_name}</strong>?
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Link
                href={`/commercial/accounts/${account.id}/edit#danger-zone`}
                scroll={false}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation sm:order-1"
              >
                Cancel
              </Link>
              <form action={deleteAction} className="flex-1 sm:order-2">
                <input type="hidden" name="id" value={account.id} />
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 active:bg-rose-800 min-h-[44px] touch-manipulation"
                >
                  Delete
                </button>
              </form>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Section({
  title,
  children,
  anchorId,
}: {
  title: string;
  children: React.ReactNode;
  /** Karan 2026-07-08: the detail page "Edit →" quick-links deep-link
   *  to /edit#{anchorId} so users jump straight to the right section
   *  instead of scrolling. scroll-mt-24 keeps the section title clear
   *  of the sticky page chrome. */
  anchorId?: string;
}) {
  return (
    <section
      id={anchorId}
      className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 space-y-3 ${anchorId ? "scroll-mt-24 target:ring-2 target:ring-cc-brand-600/30" : ""}`}
    >
      <h2 className="text-sm font-bold text-ppp-charcoal">{title}</h2>
      {children}
    </section>
  );
}

function EditField({
  id,
  label,
  type = "text",
  required = false,
  placeholder,
  defaultValue,
}: {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLS}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className={INPUT_CLS}
      />
    </div>
  );
}

function EditSelectField({
  id,
  label,
  options,
  defaultValue,
}: {
  id: string;
  label: string;
  options: Array<[string, string]>;
  defaultValue?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLS}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        defaultValue={defaultValue}
        className={SELECT_CLS}
        style={SELECT_BG_STYLE}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

// Silence unused-import lint warning — TS doesn't track JSX-only types
// in some configs. Leaving here for posterity.
void ({} as CommercialAccount);
