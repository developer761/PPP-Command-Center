import { notFound, redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
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
import { findNearDuplicates } from "@/lib/commercial/accounts/duplicates";
import { commercialDb } from "@/lib/commercial/db";
import CommercialAddressFields from "@/components/commercial-address-fields";
import CommercialSiteAddressToggle from "@/components/commercial-site-address-toggle";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{
  error?: string;
  confirm_delete?: string;
  duplicate?: string;
  company_name?: string;
  dba?: string;
  industry?: string;
  rating?: string;
  billing_street?: string;
  billing_city?: string;
  billing_state?: string;
  billing_zip?: string;
  site_street?: string;
  site_city?: string;
  site_state?: string;
  site_zip?: string;
  phone?: string;
  ap_phone?: string;
  website?: string;
  tax_exempt?: string;
  tax_exempt_cert_number?: string;
  is_key?: string;
  site_same?: string;
  notes?: string;
}>;

async function updateAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const id = String(formData.get("id") ?? "");
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) redirect("/commercial/accounts");

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const company = get("company_name");
  if (!company) {
    redirect(`/commercial/accounts/${id}/edit?error=name_required`);
  }

  // Near-duplicate check on rename (Karan 2026-07-27 audit) — the edit path
  // never ran it, so renaming an account onto an existing name was silently
  // allowed. excludeId=self so we don't flag the row being edited; skipped
  // once the user confirms via "Save anyway".
  const confirmedDuplicate = formData.get("confirm_duplicate") === "1";
  if (!confirmedDuplicate) {
    const duplicates = await findNearDuplicates(company, id);
    if (duplicates.length > 0) {
      const ids = duplicates.map((d) => d.id).join(",");
      // Round-trip every edited TEXT field back so the warning re-render doesn't
      // silently revert to the DB row (re-audit 2026-07-28 BUG) — otherwise
      // "Save anyway" would save the ORIGINAL values, dropping the rename+edits.
      const p = new URLSearchParams({ duplicate: ids });
      p.set("company_name", company);
      for (const k of [
        "dba", "industry", "rating", "billing_street", "billing_city", "billing_state",
        "billing_zip", "site_street", "site_city", "site_state", "site_zip", "phone",
        "ap_phone", "website", "tax_exempt_cert_number", "notes",
      ]) {
        const v = get(k);
        if (v) p.set(k, v);
      }
      if (formData.get("tax_exempt") === "on") p.set("tax_exempt", "1");
      if (formData.get("is_key_relationship") === "on") p.set("is_key", "1");
      if (formData.get("site_same_as_billing") === "1") p.set("site_same", "1");
      redirect(`/commercial/accounts/${id}/edit?${p.toString()}`);
    }
  }

  const result = await updateCommercialAccount(
    id,
    {
      company_name: company,
      dba: get("dba"),
      industry: get("industry"),
      rating: (get("rating") as "A" | "B" | "C" | null) ?? null,
      // Direction flipped with the sections: billing mirrors the COMPANY
      // address now, not the other way round. The billing inputs are hidden
      // when the box is ticked, so the fallback has to be explicit — reading
      // the empty hidden inputs would blank billing instead of mirroring it.
      billing_street: get("site_same_as_billing") === "1" ? get("site_street") : get("billing_street"),
      billing_city: get("site_same_as_billing") === "1" ? get("site_city") : get("billing_city"),
      billing_state: get("site_same_as_billing") === "1" ? get("site_state") : get("billing_state"),
      billing_zip: get("site_same_as_billing") === "1" ? get("site_zip") : get("billing_zip"),
      site_street: get("site_street"),
      site_city: get("site_city"),
      site_state: get("site_state"),
      site_zip: get("site_zip"),
      phone: get("phone"),
      ap_phone: get("ap_phone"),
      website: get("website"),
      // Tax exemption removed from the account UI (2026-08 meeting) — no longer
      // written here so an existing account's value is PRESERVED, not silently
      // cleared to false on every edit.
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
  await assertCommercialAccess(user.id);

  const id = String(formData.get("id") ?? "");
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) redirect("/commercial/accounts");

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

  // Count the live deals under this account so the delete confirmation can warn
  // that they (and everything under them — invoices, work orders, field-ops
  // schedule) get removed too. Cheap head-count; only shown in the danger zone.
  let dealCount = 0;
  if (confirmDelete) {
    const { count } = await commercialDb()
      .from("commercial_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("account_id", id)
      .is("deleted_at", null);
    dealCount = count ?? 0;
  }

  // Near-duplicate warning (Karan 2026-07-27 audit): the rename hit an existing
  // account name. Show the candidates + a "Save anyway" confirmation.
  const duplicateIds = sp.duplicate?.split(",").filter(Boolean) ?? [];
  let duplicateCandidates: Array<{ id: string; company_name: string }> = [];
  if (duplicateIds.length > 0) {
    const { data } = await commercialDb()
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", duplicateIds)
      .is("deleted_at", null);
    duplicateCandidates = (data ?? []) as typeof duplicateCandidates;
  }

  return (
    <div className="space-y-6">
      <header>
        <Link
          href={`/commercial/accounts/${account.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] touch-manipulation -ml-1 px-1"
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

      {duplicateCandidates.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800 max-w-2xl">
          <div className="flex items-start gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            <div className="min-w-0">
              <div className="font-semibold">Another account has a similar name</div>
              <p className="mt-0.5 text-[13px] leading-snug">
                {duplicateCandidates.map((d) => d.company_name).join(", ")}. If this rename is intentional, click <strong>Save anyway</strong> below; otherwise adjust the name.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Edit form — same shape as new account form */}
      <form action={updateAction} className="space-y-5 max-w-2xl">
        <input type="hidden" name="id" value={account.id} />
        {/* When the dup warning is showing, the next submit confirms past it. */}
        {duplicateCandidates.length > 0 && <input type="hidden" name="confirm_duplicate" value="1" />}

        <Section title="Identity" anchorId="edit-identity">
          <EditField id="company_name" label="Company name *" required defaultValue={sp.company_name ?? account.company_name} />
          <EditField id="dba" label="DBA (doing business as)" defaultValue={sp.dba ?? (account.dba ?? "")} />
          {/* AUDIT 2026-08-12: Industry was removed from the create form and
              the account detail, and survived HERE — so the field Brendan said
              we don't need was still being asked for on the one screen used to
              correct an account. The column keeps its data. */}
          <EditSelectField
            id="rating"
            label="Rating"
            options={[["", "—"], ["A", "A"], ["B", "B"], ["C", "C"]]}
            defaultValue={sp.rating ?? (account.rating ?? "")}
          />
        </Section>

        {/* AUDIT 2026-08-12: the create form was reordered for Brendan
            ("company address then billing address with an option to click same
            as company address") and this page was not — so the toggle inherited
            the new LABEL while keeping the old BEHAVIOUR, and read exactly
            backwards: "Same as company address" while copying billing into the
            company address. Second time an edit page was missed after a
            create-form change; same class as the data loss. */}
        <Section title="Company address" anchorId="edit-site">
          <CommercialAddressFields
            prefix="site"
            defaults={{
              street: sp.site_street ?? (account.site_street ?? ""),
              city: sp.site_city ?? (account.site_city ?? ""),
              state: sp.site_state ?? (account.site_state ?? ""),
              zip: sp.site_zip ?? (account.site_zip ?? ""),
            }}
          />
        </Section>

        <Section title="Billing address" anchorId="edit-billing">
          {/* Ticked when billing already matches the company address — the
              common case, and it means an untouched save cannot silently
              un-link two addresses that were the same a moment ago. */}
          <CommercialSiteAddressToggle
            defaultChecked={
              duplicateCandidates.length > 0
                ? sp.site_same === "1"
                : (account.billing_street ?? "") === (account.site_street ?? "") &&
                  (account.billing_city ?? "") === (account.site_city ?? "") &&
                  (account.billing_state ?? "") === (account.site_state ?? "") &&
                  (account.billing_zip ?? "") === (account.site_zip ?? "")
            }
            defaults={{
              street: sp.billing_street ?? (account.billing_street ?? ""),
              city: sp.billing_city ?? (account.billing_city ?? ""),
              state: sp.billing_state ?? (account.billing_state ?? ""),
              zip: sp.billing_zip ?? (account.billing_zip ?? ""),
            }}
          />
        </Section>

        <Section title="Contact" anchorId="edit-contact">
          <EditField id="phone" label="Main phone" type="tel" defaultValue={sp.phone ?? (account.phone ?? "")} />
          <EditField id="ap_phone" label="Accounts Payable phone" type="tel" defaultValue={sp.ap_phone ?? (account.ap_phone ?? "")} />
          <EditField id="website" label="Website" type="url" defaultValue={sp.website ?? (account.website ?? "")} />
        </Section>

        {/* Karan 2026-07-10 (Katie/Brendan notes): Compliance section
            removed. Fields still exist in DB for audit trail but this
            form no longer writes them. Insurance certs + prequal docs
            now live per-Opportunity (Files sub-tab, Phase C). */}

        {/* Tax-exemption section removed per the 2026-08 meeting — not tracked at
            the account level. DB columns kept for audit; the edit action still
            preserves the existing value (it reads a now-absent checkbox as off,
            so we guard below to avoid silently clearing it). */}

        <Section title="Strategic" anchorId="edit-strategic">
          <label className="flex items-start gap-3 text-sm min-h-[44px] cursor-pointer">
            <input
              type="checkbox"
              name="is_key_relationship"
              defaultChecked={duplicateCandidates.length > 0 ? sp.is_key === "1" : Boolean(account.is_key_relationship)}
              className="h-5 w-5 mt-0.5 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30"
            />
            <span>
              <strong className="inline-flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z" /></svg>Key Relationship</strong>
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
            maxLength={4000}
            defaultValue={sp.notes ?? (account.notes ?? "")}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 resize-y transition-colors"
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
            {duplicateCandidates.length > 0 ? "Save anyway" : "Save changes"}
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
          <div className="space-y-3 bg-surface border border-rose-300 rounded-lg p-4">
            <p className="text-sm text-ppp-charcoal-700">
              Delete <strong>{account.company_name}</strong>?
            </p>
            {dealCount > 0 && (
              <p className="text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                This also removes {dealCount} deal{dealCount === 1 ? "" : "s"} under this account and everything on them — invoices, work orders, and any Field Ops schedule. There&rsquo;s no undo on account delete.
              </p>
            )}
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
      className={`bg-surface border border-ppp-charcoal-100 rounded-xl p-5 space-y-3 ${anchorId ? "scroll-mt-24 target:ring-2 target:ring-cc-brand-600/30" : ""}`}
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
