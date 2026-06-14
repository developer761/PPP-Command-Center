import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createCommercialAccount } from "@/lib/commercial/accounts/mutations";

export const dynamic = "force-dynamic";

async function createAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

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
  if (!company) redirect("/commercial/accounts/new?error=name_required");

  const result = await createCommercialAccount({
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
    created_by_user_id: user.id,
  });

  if (!result.ok) {
    redirect(`/commercial/accounts/new?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${result.account.id}`);
}

export default async function NewCommercialAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const errorMsg = sp.error;

  return (
    <div className="space-y-6">
      <header>
        <Link href="/commercial/accounts" className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          All accounts
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-2">New account</h1>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          The basics — add documents, contacts, and other detail after saving.
        </p>
      </header>

      {errorMsg && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMsg === "name_required"
            ? "Company name is required."
            : `Couldn't create account: ${errorMsg}`}
        </div>
      )}

      <form action={createAction} className="space-y-5 max-w-2xl">
        <Section title="Identity">
          <Field id="company_name" label="Company name *" required />
          <Field id="dba" label="DBA (doing business as)" />
          <Field id="industry" label="Industry" placeholder="Real estate, hospitality, healthcare…" />
          <SelectField id="rating" label="Rating" options={[["", "—"], ["A", "A"], ["B", "B"], ["C", "C"]]} />
        </Section>

        <Section title="Billing address">
          <Field id="billing_street" label="Street" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field id="billing_city" label="City" />
            <Field id="billing_state" label="State" />
            <Field id="billing_zip" label="ZIP" />
          </div>
        </Section>

        <Section title="Primary site address (if different)">
          <Field id="site_street" label="Street" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field id="site_city" label="City" />
            <Field id="site_state" label="State" />
            <Field id="site_zip" label="ZIP" />
          </div>
        </Section>

        <Section title="Contact">
          <Field id="phone" label="Main phone" type="tel" />
          <Field id="ap_phone" label="AP phone" type="tel" />
          <Field id="website" label="Website" type="url" />
        </Section>

        <Section title="Compliance">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SelectField
              id="vendor_compliance_status"
              label="Vendor compliance"
              options={[
                ["not_started", "Not started"],
                ["yellow", "In progress"],
                ["green", "Approved"],
                ["red", "Issues"],
              ]}
            />
            <SelectField
              id="prequalification_status"
              label="Prequalification"
              options={[
                ["not_started", "Not started"],
                ["pending", "Pending"],
                ["approved", "Approved"],
                ["rejected", "Rejected"],
              ]}
            />
            <Field id="insurance_min_liability" label="Insurance min liability ($)" type="number" />
            <Field id="insurance_min_workers_comp" label="Insurance min workers' comp ($)" type="number" />
          </div>
        </Section>

        <Section title="Tax">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="tax_exempt" className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-emerald-600/30" />
            Tax exempt
          </label>
          <Field id="tax_exempt_cert_number" label="Tax exempt certificate #" />
        </Section>

        <Section title="Notes">
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 resize-y"
          />
        </Section>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Link
            href="/commercial/accounts"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 shadow-sm shadow-emerald-600/30"
          >
            Create account
          </button>
        </div>
      </form>
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

function Field({
  id,
  label,
  type = "text",
  required = false,
  placeholder,
}: {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
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
        className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
      />
    </div>
  );
}

function SelectField({
  id,
  label,
  options,
}: {
  id: string;
  label: string;
  options: Array<[string, string]>;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
        {label}
      </label>
      <select
        id={id}
        name={id}
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
