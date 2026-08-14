import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { revalidatePath } from "next/cache";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
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
import {
  DOCUMENT_CATEGORIES,
  documentCategoryLabel,
  uploadDocument,
  ALLOWED_MIME_TYPES,
  type DocumentCategory,
} from "@/lib/commercial/accounts/documents";
import { addAccountTag } from "@/lib/commercial/accounts/tags";
import CommercialAddressFields from "@/components/commercial-address-fields";
import CommercialSiteAddressToggle from "@/components/commercial-site-address-toggle";
import { NewAccountContacts } from "@/components/commercial/new-account-contacts";
import CommercialNewAccountTeamPicker from "@/components/commercial-new-account-team-picker";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

const VALID_ROLES = new Set<AssignmentRole>(ASSIGNMENT_ROLES);

// On-create doc upload. Was the five compliance categories; Brendan cut four
// of them 2026-08-12 ("the only thing for the account level really would be
// prequal questionnaire"), so one remains — and a one-item upload row on the
// create form is more friction than it saves. Uploads happen from the account's
// Documents tab, where the file usually arrives anyway.
const ON_CREATE_DOC_CATEGORIES: DocumentCategory[] = [];

export const dynamic = "force-dynamic";

async function createAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
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
      // Re-render the form with a warning, round-tripping every TEXT field the
      // user typed so they don't lose it (Karan 2026-07-27 audit — previously
      // only the name survived). File uploads + team rows + tags can't be
      // restored (browsers can't repopulate file inputs), so those must be
      // re-added; the warning copy notes that.
      const p = new URLSearchParams({ duplicate: ids, typed_name: company });
      for (const k of [
        "dba", "rating", "billing_street", "billing_street2", "billing_city", "billing_state",
        "billing_zip", "site_street", "site_street2", "site_city", "site_state", "site_zip", "phone",
        "ap_phone", "website", "tax_exempt_cert_number", "notes",
      ]) {
        const v = get(k);
        if (v) p.set(k, v);
      }
      if (formData.get("tax_exempt") === "on") p.set("tax_exempt", "1");
      if (formData.get("is_key_relationship") === "on") p.set("is_key", "1");
      if (formData.get("site_same_as_billing") === "1") p.set("site_same", "1");
      redirect(`/commercial/accounts/new?${p.toString()}`);
    }
  }

  // The checkbox still posts its original name; only what it MEANS changed.
  const same = get("site_same_as_billing") === "1";
  const result = await createCommercialAccount({
    company_name: company,
    dba: get("dba"),
    rating: (get("rating") as "A" | "B" | "C" | null) ?? null,
    is_key_relationship: formData.get("is_key_relationship") === "on",
    // "Same as company address": when set, billing copies the company address
    // so nobody retypes the same four fields. The billing inputs are hidden in
    // that case, so the fallback has to be explicit — reading the empty hidden
    // inputs would blank the billing address instead of mirroring it.
    billing_street: same ? get("site_street") : get("billing_street"),
    billing_street2: same ? get("site_street2") : get("billing_street2"),
    billing_city: same ? get("site_city") : get("billing_city"),
    billing_state: same ? get("site_state") : get("billing_state"),
    billing_zip: same ? get("site_zip") : get("billing_zip"),
    site_street: get("site_street"),
    site_street2: get("site_street2"),
    site_city: get("site_city"),
    site_state: get("site_state"),
    site_zip: get("site_zip"),
    phone: get("phone"),
    ap_phone: get("ap_phone"),
    website: get("website"),
    // Karan 2026-07-10 (Katie/Brendan notes): compliance status +
    // insurance minimums no longer collected on Accounts — moved to
    // per-Opportunity docs (Files → "Insurance" category).
    tax_exempt: formData.get("tax_exempt") === "on",
    tax_exempt_cert_number: get("tax_exempt_cert_number"),
    notes: get("notes"),
    created_by_user_id: user.id,
  });

  if (!result.ok) {
    redirect(`/commercial/accounts/new?error=${encodeURIComponent(result.error)}`);
  }
  const newAccountId = result.account.id;

  // ── Contacts typed on this form (Brendan 2026-08-12) ─────────────────────
  //
  // "While entering a new builder we can add an estimator's contact at the
  // same time, so when we go to send the proposal it's already pre-populated."
  //
  // A NAME is what makes a row real: an email or phone with nobody attached
  // would create a nameless contact that shows as a blank line forever. Rows
  // without one are skipped silently — they are empty inputs, not mistakes.
  //
  // Best-effort, like the team rows below: a contact that fails to save must
  // not lose the company details somebody just typed. Failures are counted and
  // surfaced on the destination page rather than swallowed.
  const CONTACT_ROWS = [
    { key: "owner", role: "decision_maker" },
    { key: "estimating", role: "estimator" },
    { key: "billing", role: "billing" },
    { key: "field", role: "site" },
  ] as const;
  let contactsAdded = 0;
  let contactsFailed = 0;
  {
    const { addContactToAccount } = await import("@/lib/commercial/accounts/contacts");
    for (const row of CONTACT_ROWS) {
      const full_name = String(formData.get(`c_${row.key}_name`) ?? "").trim();
      if (!full_name) continue;
      const res = await addContactToAccount({
        account_id: newAccountId,
        full_name,
        email: String(formData.get(`c_${row.key}_email`) ?? "").trim() || null,
        phone: String(formData.get(`c_${row.key}_phone`) ?? "").trim() || null,
        role: row.role,
        created_by_user_id: user.id,
      });
      if (res.ok) contactsAdded++;
      else {
        contactsFailed++;
        console.warn(`[accounts/new] contact "${row.key}" failed: ${res.error}`);
      }
    }
  }

  // Process team rows from the picker — each row writes an assignment +
  // fires the team-assignment email (fire-and-forget via the existing
  // notifyAssignment pipeline in lib/commercial/accounts/assignments.ts).
  // Failures don't roll back the account create — Karan would rather
  // land the account + see a partial-team warning than lose the typed
  // company details. Skipped rows surface in the redirect query string.
  const teamCount = Math.max(0, Math.min(20, Number(formData.get("team_count") ?? 0) || 0));
  let teamAddedCount = 0;
  const teamSkipReasons: string[] = [];
  // Lazy-imported for the email-mode lookup path.
  const { commercialDb } = await import("@/lib/commercial/db");
  for (let i = 0; i < teamCount; i++) {
    const mode = String(formData.get(`team_mode_${i}`) ?? "user").trim();
    const role_raw = String(formData.get(`team_role_${i}`) ?? "").trim();
    const is_primary = formData.get(`team_is_primary_${i}`) === "1";
    const role = role_raw as AssignmentRole;
    if (!VALID_ROLES.has(role)) {
      teamSkipReasons.push(`row ${i + 1}: invalid role`);
      continue;
    }

    let member_user_id = "";

    if (mode === "email") {
      // Email-mode lookup. Trim + lowercase for case-insensitive match.
      const rawEmail = String(formData.get(`team_email_${i}`) ?? "").trim();
      if (!rawEmail) continue;
      const email = rawEmail.toLowerCase();
      const sb = commercialDb();
      const { data: profile } = await sb
        .from("profiles")
        .select("user_id, is_active, has_new_platform_access")
        .ilike("email", email)
        .maybeSingle();
      if (!profile) {
        teamSkipReasons.push(
          `${rawEmail}: no account yet — they need to sign in once first`
        );
        continue;
      }
      const p = profile as { user_id: string; is_active: boolean | null; has_new_platform_access: boolean | null };
      if (p.is_active === false) {
        teamSkipReasons.push(`${rawEmail}: account is inactive`);
        continue;
      }
      // Security (2026-08 sweep): do NOT auto-grant Commercial access here — a
      // non-admin could otherwise provision arbitrary users just by naming them
      // on the team. Granting is admin-only (Settings → Access, audited). Skip
      // with a clear reason; addAssignment also refuses a no-flag assignee.
      if (!p.has_new_platform_access) {
        teamSkipReasons.push(`${rawEmail}: no Commercial access yet — an admin must grant it at Settings → Access first`);
        continue;
      }
      member_user_id = p.user_id;
    } else {
      // Default user-dropdown mode.
      member_user_id = String(formData.get(`team_user_id_${i}`) ?? "").trim();
      if (!member_user_id) continue;
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

  // Karan 2026-07-08: process any tags typed into the "Tags" field
  // (comma-separated). Fail-soft — a bad tag doesn't roll back the
  // account, just gets tallied in the flash so Alex knows which ones
  // to retype from the Tags card.
  const rawTags = String(formData.get("tags") ?? "").trim();
  let tagsAddedCount = 0;
  const tagSkipReasons: string[] = [];
  if (rawTags) {
    const tags = rawTags
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
    for (const t of tags) {
      const r = await addAccountTag(newAccountId, t, user.id);
      if (r.ok) tagsAddedCount += 1;
      else tagSkipReasons.push(`${t}: ${r.error}`);
    }
  }

  // Karan 2026-07-08: process any compliance docs Alex uploaded on
  // the New Account form. Fail-soft — an oversized/rejected file
  // surfaces in the flash and Alex can retry from the Documents tab.
  // Same 50MB / MIME allowlist gates that live in the API upload path.
  let docsUploadedCount = 0;
  const docSkipReasons: string[] = [];
  for (const category of ON_CREATE_DOC_CATEGORIES) {
    const f = formData.get(`doc_${category}`);
    if (!(f instanceof File) || f.size === 0) continue;
    if (!ALLOWED_MIME_TYPES.has(f.type)) {
      docSkipReasons.push(`${documentCategoryLabel(category)}: file type not allowed`);
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const up = await uploadDocument({
      account_id: newAccountId,
      category,
      file_name: f.name,
      size_bytes: f.size,
      mime_type: f.type,
      expires_at: null,
      notes: null,
      data: bytes,
      uploaded_by_user_id: user.id,
    });
    if (up.ok) docsUploadedCount += 1;
    else docSkipReasons.push(`${documentCategoryLabel(category)}: ${up.error}`);
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
  if (contactsAdded > 0) params.set("contacts_added", String(contactsAdded));
  // Counted, not swallowed: a contact that failed to save is a person somebody
  // typed and expects to find later.
  if (contactsFailed > 0) params.set("contacts_failed", String(contactsFailed));
  if (tagsAddedCount > 0) params.set("tags_added", String(tagsAddedCount));
  if (tagSkipReasons.length > 0) {
    params.set(
      "tag_skipped",
      tagSkipReasons.map((s) => s.replace(/[<>"'`]/g, "").slice(0, 120)).slice(0, 3).join(" · ")
    );
  }
  if (docsUploadedCount > 0) params.set("docs_added", String(docsUploadedCount));
  if (docSkipReasons.length > 0) {
    params.set(
      "doc_skipped",
      docSkipReasons.map((s) => s.replace(/[<>"'`]/g, "").slice(0, 120)).slice(0, 5).join(" · ")
    );
  }
  // Flush the detail page + list so uploaded docs and tags render
  // immediately on the redirect landing.
  revalidatePath(`/commercial/accounts/${newAccountId}`);
  revalidatePath("/commercial/accounts");
  const qs = params.toString();
  redirect(`/commercial/accounts/${newAccountId}${qs ? `?${qs}` : ""}`);
}

export default async function NewCommercialAccountPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    duplicate?: string;
    typed_name?: string;
    dba?: string;
    rating?: string;
    billing_street?: string;
    billing_street2?: string;
    billing_city?: string;
    billing_state?: string;
    billing_zip?: string;
    site_street?: string;
    site_street2?: string;
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
}) {
  const sp = await searchParams;
  const errorMsg = sp.error;
  const duplicateIds = sp.duplicate?.split(",").filter(Boolean) ?? [];
  const typedName = sp.typed_name ?? "";

  // Hydrate the duplicate-candidate previews if we're showing the warning.
  let duplicateCandidates: Array<{ id: string; company_name: string }> = [];
  if (duplicateIds.length > 0) {
    const { commercialDb } = await import("@/lib/commercial/db");
    const { data } = await commercialDb()
      .from("commercial_accounts")
      .select("id, company_name")
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
        <Link
          href="/commercial/accounts"
          className="inline-flex items-center gap-1.5 text-sm text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] touch-manipulation -ml-1 px-1"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          All accounts
        </Link>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mt-2 mb-3 bg-cc-brand-600" />
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">New account</h1>
        <p className="mt-1 text-sm text-ppp-charcoal-500">
          The essentials. If you have compliance docs or tags in hand, add them below —
          everything is optional and can be edited from the account&apos;s tabs later.
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
          <div className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            Possible duplicate{duplicateCandidates.length > 1 ? "s" : ""} found
          </div>
          <p className="text-[12px] text-amber-800/90 leading-relaxed">
            We already have account{duplicateCandidates.length > 1 ? "s" : ""} on file with a similar name. Open the existing one if it&apos;s the same company — otherwise click <strong>Create anyway</strong> at the bottom of the form to proceed. Your typed details were kept; any team members, tags, or file uploads need to be re-added.
          </p>
          <ul className="space-y-1.5">
            {duplicateCandidates.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/commercial/accounts/${d.id}`}
                  className="inline-flex items-center gap-2 text-sm text-emerald-700 hover:text-emerald-800 font-medium"
                >
                  → {d.company_name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form action={createAction} encType="multipart/form-data" className="space-y-5 max-w-2xl">
        {/* Pass-through flag so a second submit after the warning skips
            the duplicate check. */}
        {duplicateCandidates.length > 0 && <input type="hidden" name="confirm_duplicate" value="1" />}
        <Section title="Identity">
          <Field id="company_name" label="Company name *" required defaultValue={typedName} />
          <Field id="dba" label="DBA (doing business as)" defaultValue={sp.dba ?? ""} />
          <SelectField id="rating" label="Rating" options={[["", "—"], ["A", "A"], ["B", "B"], ["C", "C"]]} defaultValue={sp.rating ?? ""} />
          {/* Karan 2026-07-08: is_key_relationship parity with the Edit
              form. Was create→edit round-trip; now flagging a key
              account at create time works from one place. */}
          <label className="flex items-start gap-2 text-sm pt-1 cursor-pointer min-h-[44px] sm:min-h-0">
            <input
              type="checkbox"
              name="is_key_relationship"
              defaultChecked={sp.is_key === "1"}
              className="h-4 w-4 mt-0.5 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30"
            />
            <span className="flex flex-col">
              <span className="font-medium text-ppp-charcoal">Key relationship</span>
              <span className="text-[11.5px] text-ppp-charcoal-500 leading-snug">
                Star this account so it surfaces with a Key badge on lists + drawers.
              </span>
            </span>
          </label>
        </Section>

        {/* Brendan 2026-08-12: "Primary Site Address should not be on the
            account level. It should just be the company address then billing
            address with an option to click same as company address."
            A general contractor has one office and many job sites — the sites
            belong to the jobs, which is where they already live. So the
            account keeps the company's own address, and billing defaults to
            it. Same two column sets as before, read the right way round. */}
        <Section title="Company address">
          <CommercialAddressFields
            prefix="site"
            defaults={{
              street: sp.site_street ?? "",
              street2: sp.site_street2 ?? "",
              city: sp.site_city ?? "",
              state: sp.site_state ?? "",
              zip: sp.site_zip ?? "",
            }}
          />
        </Section>

        <Section title="Billing address">
          <CommercialSiteAddressToggle
            defaultChecked={sp.site_same === "1"}
            defaults={{
              street: sp.billing_street ?? "",
              street2: sp.billing_street2 ?? "",
              city: sp.billing_city ?? "",
              state: sp.billing_state ?? "",
              zip: sp.billing_zip ?? "",
            }}
          />
        </Section>

        {/* Brendan 2026-08-12: contacts, captured while the builder is being
            entered — "so when we go to send the proposal it's already
            pre-populated". */}
        <Section title="Contacts">
          <NewAccountContacts defaults={sp as Record<string, string | undefined>} />
        </Section>

        <Section title="Company phone">
          <Field id="phone" label="Main phone" type="tel" defaultValue={sp.phone ?? ""} />
          <Field id="ap_phone" label="Accounts Payable phone" type="tel" defaultValue={sp.ap_phone ?? ""} />
          <Field id="website" label="Website" type="url" defaultValue={sp.website ?? ""} />
        </Section>

        {/* Karan 2026-07-10 (Katie/Brendan notes): Compliance section
            removed from Accounts. Vendor compliance status, prequal
            status, and insurance minimums live per-Opportunity now
            (upload insurance docs as Files → category "Insurance"
            per Phase C). DB columns kept for audit trail but never
            written to from this flow again. */}

        {/* Tax-exemption section removed per the 2026-08 meeting — not tracked at
            the account level. DB columns kept for audit; never written here now. */}

        <Section title="Team">
          <p className="text-[12px] text-ppp-charcoal-500 -mt-1 leading-relaxed">
            Pick the PPP staff who&apos;ll manage this account. They&apos;ll get an
            email with a link as soon as the account is created. You can adjust
            roles + primaries later from the Team tab.
          </p>
          <CommercialNewAccountTeamPicker assignableStaff={assignableStaff} />
        </Section>

        {/* Karan 2026-07-08: Tags + Documents on create. Skip the trip
            through the detail page if the operator has the info in
            hand. Both sections are optional — the form still submits
            with empty values so nothing here can block the create. */}
        <Section title="Tags">
          <p className="text-[12px] text-ppp-charcoal-500 -mt-1 leading-relaxed">
            Free-form labels (Hospitality, Healthcare, Property Mgmt) — different from Industry.
            Use them to group accounts on the list page. Comma-separated.
          </p>
          <input
            id="tags"
            name="tags"
            type="text"
            placeholder="e.g. Hospitality, Long Island, Repeat"
            className={INPUT_CLS}
            maxLength={500}
          />
        </Section>

        {/* Hidden entirely when there is nothing to upload. Brendan's
            2026-08-12 retirement emptied ON_CREATE_DOC_CATEGORIES, leaving a
            heading and a paragraph promising "upload any compliance docs you
            have in hand" above nothing at all — a section that reads as
            broken rather than as deliberately empty. */}
        {ON_CREATE_DOC_CATEGORIES.length > 0 && (
        <Section title="Documents">
          <p className="text-[12px] text-ppp-charcoal-500 -mt-1 leading-relaxed">
            Upload any compliance docs you have in hand. All optional —
            you can add more from the Documents tab later. Max 50 MB per file (PDF, image, Word, or Excel).
          </p>
          <div className="space-y-3">
            {ON_CREATE_DOC_CATEGORIES.map((c) => (
              <div key={c} className="border border-ppp-charcoal-100 rounded-lg p-3">
                <label htmlFor={`doc_${c}`} className="block text-[12.5px] font-semibold text-ppp-charcoal mb-1.5">
                  {documentCategoryLabel(c)}
                </label>
                <input
                  id={`doc_${c}`}
                  name={`doc_${c}`}
                  type="file"
          aria-label="Attach compliance document"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"
                  className="block w-full text-[12px] text-ppp-charcoal-700 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:cursor-pointer min-h-[44px] touch-manipulation"
                />
              </div>
            ))}
          </div>
        </Section>
        )}

        <Section title="Notes">
          <textarea
            id="notes"
            name="notes"
            rows={4}
            maxLength={4000}
            defaultValue={sp.notes ?? ""}
            placeholder="Anything PPP staff should know about this account."
            className="w-full px-3.5 py-2.5 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 hover:border-ppp-charcoal-300 resize-y transition-colors"
          />
        </Section>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
          <Link
            href="/commercial/accounts"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
          <PendingSubmitButton
            pendingLabel="Creating…"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation disabled:opacity-60"
          >
            {duplicateCandidates.length > 0 ? "Create anyway" : "Create account"}
          </PendingSubmitButton>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 space-y-3">
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
