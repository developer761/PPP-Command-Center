import { notFound, redirect } from "next/navigation";
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
      site_street: get("site_street"),
      site_city: get("site_city"),
      site_state: get("site_state"),
      site_zip: get("site_zip"),
      phone: get("phone"),
      ap_phone: get("ap_phone"),
      website: get("website"),
      vendor_compliance_status: (get("vendor_compliance_status") as
        | "green"
        | "yellow"
        | "red"
        | "not_started"
        | null) ?? "not_started",
      prequalification_status: (get("prequalification_status") as
        | "not_started"
        | "pending"
        | "approved"
        | "rejected"
        | null) ?? "not_started",
      insurance_min_liability: getNum("insurance_min_liability"),
      insurance_min_workers_comp: getNum("insurance_min_workers_comp"),
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
  redirect(`/commercial/accounts/${id}`);
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
          className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Back to account
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-2">Edit account</h1>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          Editing <strong>{account.company_name}</strong>. Changes are logged to the audit trail.
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

        <Section title="Identity">
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

        <Section title="Billing address">
          <EditField id="billing_street" label="Street" defaultValue={account.billing_street ?? ""} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <EditField id="billing_city" label="City" defaultValue={account.billing_city ?? ""} />
            <EditField id="billing_state" label="State" defaultValue={account.billing_state ?? ""} />
            <EditField id="billing_zip" label="ZIP" defaultValue={account.billing_zip ?? ""} />
          </div>
        </Section>

        <Section title="Primary site address (if different)">
          <EditField id="site_street" label="Street" defaultValue={account.site_street ?? ""} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <EditField id="site_city" label="City" defaultValue={account.site_city ?? ""} />
            <EditField id="site_state" label="State" defaultValue={account.site_state ?? ""} />
            <EditField id="site_zip" label="ZIP" defaultValue={account.site_zip ?? ""} />
          </div>
        </Section>

        <Section title="Contact">
          <EditField id="phone" label="Main phone" type="tel" defaultValue={account.phone ?? ""} />
          <EditField id="ap_phone" label="AP phone" type="tel" defaultValue={account.ap_phone ?? ""} />
          <EditField id="website" label="Website" type="url" defaultValue={account.website ?? ""} />
        </Section>

        <Section title="Compliance">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <EditSelectField
              id="vendor_compliance_status"
              label="Vendor compliance"
              options={[
                ["not_started", "Not started"],
                ["yellow", "In progress"],
                ["green", "Approved"],
                ["red", "Issues"],
              ]}
              defaultValue={account.vendor_compliance_status ?? "not_started"}
            />
            <EditSelectField
              id="prequalification_status"
              label="Prequalification"
              options={[
                ["not_started", "Not started"],
                ["pending", "Pending"],
                ["approved", "Approved"],
                ["rejected", "Rejected"],
              ]}
              defaultValue={account.prequalification_status ?? "not_started"}
            />
            <EditField
              id="insurance_min_liability"
              label="Insurance min liability ($)"
              type="number"
              defaultValue={account.insurance_min_liability != null ? String(account.insurance_min_liability) : ""}
            />
            <EditField
              id="insurance_min_workers_comp"
              label="Insurance min workers' comp ($)"
              type="number"
              defaultValue={account.insurance_min_workers_comp != null ? String(account.insurance_min_workers_comp) : ""}
            />
          </div>
        </Section>

        <Section title="Tax">
          <label className="flex items-center gap-2 text-sm min-h-[44px]">
            <input
              type="checkbox"
              name="tax_exempt"
              defaultChecked={account.tax_exempt}
              className="h-5 w-5 rounded border-ppp-charcoal-300 focus:ring-emerald-600/30"
            />
            Tax exempt
          </label>
          <EditField id="tax_exempt_cert_number" label="Tax exempt certificate #" defaultValue={account.tax_exempt_cert_number ?? ""} />
        </Section>

        <Section title="Strategic">
          <label className="flex items-start gap-3 text-sm min-h-[44px] cursor-pointer">
            <input
              type="checkbox"
              name="is_key_relationship"
              defaultChecked={Boolean(account.is_key_relationship)}
              className="h-5 w-5 mt-0.5 rounded border-ppp-charcoal-300 focus:ring-emerald-600/30"
            />
            <span>
              <strong>★ Key Relationship</strong>
              <span className="block text-[12px] text-ppp-charcoal-500 mt-0.5">
                Strategic partnership: biggest GCs, recurring multi-year customers, decision-makers with personal trust. Surfaces a ★ badge across every list + card so high-value accounts pop on scan.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Notes">
          <textarea
            id="notes"
            name="notes"
            rows={4}
            defaultValue={account.notes ?? ""}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 resize-y"
          />
        </Section>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Link
            href={`/commercial/accounts/${account.id}`}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 shadow-sm shadow-emerald-600/30 min-h-[44px]"
          >
            Save changes
          </button>
        </div>
      </form>

      {/* Delete zone — sequestered at the bottom so an accidental click
          stays accidental. Two-step: click 'Delete account' to reveal
          the confirm panel; click 'Yes, delete it' INSIDE the panel to
          actually fire the server action. URL-driven so a fresh load
          resets to the closed state. */}
      <section className="max-w-2xl border border-rose-200 rounded-xl p-4 sm:p-5 bg-rose-50/40 mt-8">
        <h2 className="text-sm font-bold text-rose-700 mb-1">Danger zone</h2>
        <p className="text-[12px] text-ppp-charcoal-700 leading-relaxed mb-3">
          Deleting hides this account from every list, but the record + every contact, document, and team assignment stays in the database. An admin can restore it via direct database access.
        </p>
        {!confirmDelete ? (
          <Link
            href={`/commercial/accounts/${account.id}/edit?confirm_delete=1`}
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-rose-300 text-sm font-semibold text-rose-700 hover:bg-rose-100 min-h-[44px]"
          >
            Delete account
          </Link>
        ) : (
          <div className="space-y-3 bg-white border border-rose-300 rounded-lg p-4">
            <p className="text-sm text-ppp-charcoal-700">
              Are you sure you want to delete <strong>{account.company_name}</strong>?
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <form action={deleteAction} className="flex-1">
                <input type="hidden" name="id" value={account.id} />
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 min-h-[44px]"
                >
                  Yes, delete it
                </button>
              </form>
              <Link
                href={`/commercial/accounts/${account.id}/edit`}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]"
              >
                Cancel
              </Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 space-y-3">
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
      <label htmlFor={id} className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
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
      <label htmlFor={id} className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
        {label}
      </label>
      <select
        id={id}
        name={id}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 bg-white min-h-[44px] sm:min-h-0"
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
