import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createCommercialAccount } from "@/lib/commercial/accounts/mutations";
import { findNearDuplicates } from "@/lib/commercial/accounts/duplicates";
import {
  addAssignment,
  listAssignableStaff,
  ASSIGNMENT_ROLES,
  type AssignmentRole,
} from "@/lib/commercial/accounts/assignments";
import CommercialAddressFields from "@/components/commercial-address-fields";
import CommercialNewAccountTeamPicker from "@/components/commercial-new-account-team-picker";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

const VALID_ROLES = new Set<AssignmentRole>(ASSIGNMENT_ROLES);

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

  // Near-duplicate check — fire ONLY when user hasn't already confirmed
  // they want to create anyway. Surfaces a warning above the form with
  // links to the existing accounts + a "Create anyway" button.
  const confirmedDuplicate = formData.get("confirm_duplicate") === "1";
  if (!confirmedDuplicate) {
    const duplicates = await findNearDuplicates(company);
    if (duplicates.length > 0) {
      const ids = duplicates.map((d) => d.id).join(",");
      // Re-render the form with a warning. The user's typed name comes
      // back via the URL so they don't lose it. Other fields are lost —
      // acceptable since the duplicate check happens on submit and PPP
      // staff will rarely hit this path twice.
      redirect(
        `/commercial/accounts/new?duplicate=${encodeURIComponent(ids)}&typed_name=${encodeURIComponent(company)}`
      );
    }
  }

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
  const newAccountId = result.account.id;

  // Process team rows from the picker — each row writes an assignment +
  // fires the team-assignment email (fire-and-forget via the existing
  // notifyAssignment pipeline in lib/commercial/accounts/assignments.ts).
  // Failures don't roll back the account create — Karan would rather
  // land the account + see a partial-team warning than lose the typed
  // company details. Skipped rows surface in the redirect query string.
  const teamCount = Math.max(0, Math.min(20, Number(formData.get("team_count") ?? 0) || 0));
  let teamAddedCount = 0;
  const teamSkipReasons: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    const member_user_id = String(formData.get(`team_user_id_${i}`) ?? "").trim();
    const role_raw = String(formData.get(`team_role_${i}`) ?? "").trim();
    const is_primary = formData.get(`team_is_primary_${i}`) === "1";
    if (!member_user_id) continue;
    const role = role_raw as AssignmentRole;
    if (!VALID_ROLES.has(role)) {
      teamSkipReasons.push(`row ${i + 1}: invalid role`);
      continue;
    }
    const addResult = await addAssignment({
      account_id: newAccountId,
      user_id: member_user_id,
      role,
      is_primary,
      notes: null,
      assigned_by_user_id: user.id,
    });
    if (addResult.ok) {
      teamAddedCount += 1;
    } else {
      teamSkipReasons.push(`row ${i + 1}: ${addResult.error}`);
    }
  }

  const params = new URLSearchParams();
  if (teamAddedCount > 0) params.set("team_added", String(teamAddedCount));
  if (teamSkipReasons.length > 0) {
    // Defense-in-depth: even though React auto-escapes JSX text children,
    // strip HTML-meaningful chars + control bytes + clamp length BEFORE
    // the message lands in a query string. Keeps the URL clean + future-
    // proofs against any downstream consumer that doesn't auto-escape.
    const sanitized = teamSkipReasons
      .map((s) => s.replace(/[<>"'`]/g, "").replace(/[\x00-\x1f]/g, " ").slice(0, 120))
      .slice(0, 3)
      .join(" · ");
    params.set("team_skipped", sanitized);
  }
  const qs = params.toString();
  redirect(`/commercial/accounts/${newAccountId}${qs ? `?${qs}` : ""}`);
}

export default async function NewCommercialAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; duplicate?: string; typed_name?: string }>;
}) {
  const sp = await searchParams;
  const errorMsg = sp.error;
  const duplicateIds = sp.duplicate?.split(",").filter(Boolean) ?? [];
  const typedName = sp.typed_name ?? "";

  // Hydrate the duplicate-candidate previews if we're showing the warning.
  let duplicateCandidates: Array<{ id: string; company_name: string; industry: string | null }> = [];
  if (duplicateIds.length > 0) {
    const { commercialDb } = await import("@/lib/commercial/db");
    const { data } = await commercialDb()
      .from("commercial_accounts")
      .select("id, company_name, industry")
      .in("id", duplicateIds)
      .is("deleted_at", null);
    duplicateCandidates = (data ?? []) as typeof duplicateCandidates;
  }

  // Assignable PPP staff for the team-on-create picker — same filter as
  // the Team tab on the detail page (has_new_platform_access + active).
  const assignableStaff = await listAssignableStaff();

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

      {duplicateCandidates.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 sm:p-5 space-y-3">
          <div className="text-sm font-semibold text-amber-800">
            ⚠️ Possible duplicate{duplicateCandidates.length > 1 ? "s" : ""} found
          </div>
          <p className="text-[12px] text-amber-800/90 leading-relaxed">
            We already have account{duplicateCandidates.length > 1 ? "s" : ""} on file with a similar name. Open the existing one if it&apos;s the same company — otherwise click <strong>Create anyway</strong> at the bottom of the form to proceed.
          </p>
          <ul className="space-y-1.5">
            {duplicateCandidates.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/commercial/accounts/${d.id}`}
                  className="inline-flex items-center gap-2 text-sm text-emerald-700 hover:text-emerald-800 font-medium"
                >
                  → {d.company_name}
                  {d.industry && <span className="text-[11px] text-ppp-charcoal-500">({d.industry})</span>}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form action={createAction} className="space-y-5 max-w-2xl">
        {/* Pass-through flag so a second submit after the warning skips
            the duplicate check. */}
        {duplicateCandidates.length > 0 && <input type="hidden" name="confirm_duplicate" value="1" />}
        <Section title="Identity">
          <Field id="company_name" label="Company name *" required defaultValue={typedName} />
          <Field id="dba" label="DBA (doing business as)" />
          <Field id="industry" label="Industry" placeholder="Real estate, hospitality, healthcare…" />
          <SelectField id="rating" label="Rating" options={[["", "—"], ["A", "A"], ["B", "B"], ["C", "C"]]} />
        </Section>

        <Section title="Billing address">
          <CommercialAddressFields prefix="billing" />
        </Section>

        <Section title="Primary site address (if different)">
          <CommercialAddressFields prefix="site" />
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

        <Section title="Team">
          <p className="text-[12px] text-ppp-charcoal-500 -mt-1 leading-relaxed">
            Pick the PPP staff who&apos;ll manage this account. They&apos;ll get an
            email with a link as soon as the account is created. You can adjust
            roles + primaries later from the Team tab.
          </p>
          <CommercialNewAccountTeamPicker assignableStaff={assignableStaff} />
        </Section>

        <Section title="Notes">
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 hover:border-ppp-charcoal-300 resize-y transition-colors"
          />
        </Section>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Link
            href="/commercial/accounts"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
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
      <label htmlFor={id} className={LABEL_CLS}>
        {label}
      </label>
      <select
        id={id}
        name={id}
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
