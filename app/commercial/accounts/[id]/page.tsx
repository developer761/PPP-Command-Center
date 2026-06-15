import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import {
  listAccountContacts,
  addContactToAccount,
  detachContactFromAccount,
  getPrimaryContact,
  setPrimaryContact,
  touchContact,
  CONTACT_ROLES,
  roleLabel,
  type ContactRole,
  type CommercialContact,
} from "@/lib/commercial/accounts/contacts";
import {
  listAccountTeam,
  listAssignableStaff,
  addAssignment,
  removeAssignment,
  ASSIGNMENT_ROLES,
  assignmentRoleLabel,
  type AssignmentRole,
} from "@/lib/commercial/accounts/assignments";
import {
  listAccountDocuments,
  archiveDocument,
  documentCategoryLabel,
  expiryStatus,
  buildComplianceChecklist,
  type DocumentCategory,
  type CommercialAccountDocument,
  type ComplianceItem,
} from "@/lib/commercial/accounts/documents";
import CommercialDocumentUploadForm from "@/components/commercial-document-upload-form";
import {
  getAccountOverview,
  relativeActivity,
  activityTone,
  type AccountOverview,
} from "@/lib/commercial/accounts/overview";
import {
  listAccountTags,
  listAllDistinctTags,
  addAccountTag,
  removeAccountTag,
  MAX_TAG_LENGTH,
  type AccountTag,
} from "@/lib/commercial/accounts/tags";

export const dynamic = "force-dynamic";

/** Cheap UUID sanity check used by every server action that pulls an
 *  id out of formData. We don't trust the client to send a real UUID —
 *  malformed values must fail fast, not propagate to Postgres. */
const UUID_RE = /^[0-9a-f-]{36}$/i;

type PP = Promise<{ id: string }>;
type SP = Promise<{ tab?: string; error?: string }>;

const TABS = [
  { key: "info", label: "Info" },
  { key: "team", label: "Team" },
  { key: "contacts", label: "Contacts" },
  { key: "documents", label: "Documents" },
  { key: "performance", label: "Performance" },
] as const;

export default async function CommercialAccountDetailPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  // UUID gate — refuse garbage path segments before they reach the DB.
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const tab = (sp.tab && TABS.some((t) => t.key === sp.tab) ? sp.tab : "info") as
    | "info"
    | "team"
    | "contacts"
    | "documents"
    | "performance";

  const account = await getCommercialAccount(id);
  if (!account) notFound();

  // Account 360 overview — counts pulled from the Postgres view in one
  // round-trip. Falls back to nulls if the view migration hasn't been
  // pasted yet (graceful degradation; the KPI strip just hides).
  // Primary contact loads in parallel so the header can show the
  // quick-email button without an extra round-trip.
  const [overview, primary] = await Promise.all([
    getAccountOverview(account.id),
    getPrimaryContact(account.id),
  ]);

  return (
    <div className="space-y-5">
      <header>
        <Link href="/commercial/accounts" className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          All accounts
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal truncate">{account.company_name}</h1>
            {account.dba && (
              <p className="text-sm text-ppp-charcoal-500 mt-0.5">d/b/a {account.dba}</p>
            )}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {account.rating && <Pill tone={ratingTone(account.rating)}>{account.rating}</Pill>}
              {account.industry && <Pill tone="neutral">{account.industry}</Pill>}
              {account.vendor_compliance_status && (
                <Pill tone={complianceTone(account.vendor_compliance_status)}>
                  {complianceLabel(account.vendor_compliance_status)}
                </Pill>
              )}
            </div>
            {primary && (
              <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[12px]">
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <span aria-hidden>★</span>
                  <span className="font-semibold text-ppp-charcoal">{primary.contact.full_name}</span>
                  <span className="text-ppp-charcoal-500">· {roleLabel(primary.role)}</span>
                </span>
                {primary.contact.email && (
                  <a
                    href={`mailto:${primary.contact.email}`}
                    className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" />
                    </svg>
                    Email
                  </a>
                )}
              </div>
            )}
          </div>
          {/* Edit button — Karan 2026-06-14 Batch 5b. Lives in the header so
              it's always reachable from any tab. Mobile: full-width button
              wraps below the name; desktop: pinned to the right. */}
          <Link
            href={`/commercial/accounts/${account.id}/edit`}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-ppp-charcoal-100 bg-white text-ppp-charcoal text-sm font-semibold hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation min-h-[44px] shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </Link>
        </div>
      </header>

      {/* Account 360 KPI strip — Karan 2026-06-14. One-glance summary of
          every count + last-activity tone. Blue tiles = live counts (Phase
          1). Grey tiles = "coming with Phase N" placeholders for the bid /
          invoiced / paid / balance numbers that fill in when later phases
          ship. The strip never changes shape — the data just gets richer. */}
      <AccountOverviewStrip overview={overview} />

      {/* Tab bar */}
      <nav className="border-b border-ppp-charcoal-100">
        <ul className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <li key={t.key}>
                <Link
                  href={`/commercial/accounts/${id}?tab=${t.key}`}
                  className={`inline-block px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors touch-manipulation whitespace-nowrap ${
                    active
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-300"
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Tab content */}
      {tab === "info" && <InfoTab account={account} errorMessage={sp.error} />}
      {tab === "team" && <TeamTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "contacts" && <ContactsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "documents" && <DocumentsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "performance" && <ComingSoonTab label="Performance" phase="next" />}
    </div>
  );
}

async function addTagAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const tag = String(formData.get("tag") ?? "");
  const result = await addAccountTag(account_id, tag, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=info&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=info`);
}

async function removeTagAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const tag_id = String(formData.get("tag_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(tag_id)) {
    redirect("/commercial/accounts");
  }
  // The lib verifies (tag_id, account_id) pairing so a stray tag UUID
  // from another account can't be deleted from this one.
  await removeAccountTag(account_id, tag_id, user.id);
  redirect(`/commercial/accounts/${account_id}?tab=info`);
}

async function InfoTab({ account, errorMessage }: { account: CommercialAccount; errorMessage?: string }) {
  // Load tags + suggestions + compliance checklist in parallel so the
  // Info tab renders in one round-trip's worth of latency.
  const [tags, allTags, docGroups] = await Promise.all([
    listAccountTags(account.id),
    listAllDistinctTags(),
    listAccountDocuments(account.id),
  ]);
  // Filter suggestions to tags NOT already on this account (case-
  // insensitive) — saves the picker from showing dupes.
  const existingLower = new Set(tags.map((t) => t.tag.toLowerCase()));
  const suggestions = allTags.filter((s) => !existingLower.has(s.toLowerCase()));
  // Derive the per-category compliance health from active documents.
  // Drives the checklist card + the Key Dates panel below.
  const compliance = buildComplianceChecklist(docGroups);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {errorMessage && (
        <div className="lg:col-span-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      <TagsCard
        accountId={account.id}
        tags={tags}
        suggestions={suggestions}
        className="lg:col-span-2"
      />
      <ComplianceChecklistCard
        accountId={account.id}
        items={compliance}
        className="lg:col-span-1"
      />
      <KeyDatesCard
        items={compliance}
        className="lg:col-span-1"
      />
      <InfoCards account={account} />
    </div>
  );
}

function ComplianceChecklistCard({
  accountId,
  items,
  className,
}: {
  accountId: string;
  items: ComplianceItem[];
  className?: string;
}) {
  const missing = items.filter((i) => i.health === "missing").length;
  const expired = items.filter((i) => i.health === "expired").length;
  const soon = items.filter((i) => i.health === "soon").length;
  const allGood = missing === 0 && expired === 0 && soon === 0;
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <div className="flex items-start justify-between mb-3 gap-2">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">Compliance checklist</h2>
          <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            What PPP needs on file to do business with this account.
          </p>
        </div>
        <Link
          href={`/commercial/accounts/${accountId}?tab=documents`}
          className="text-[12px] text-emerald-700 hover:text-emerald-800 underline shrink-0"
        >
          Documents tab
        </Link>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => {
          const { dot, label, tone } = healthDecoration(item);
          return (
            <li key={item.category} className="flex items-center justify-between gap-3 py-1">
              <div className="flex items-center gap-2 min-w-0">
                <span aria-hidden className={`inline-block w-2 h-2 rounded-full shrink-0 ${dot}`} />
                <span className="text-[13px] text-ppp-charcoal truncate">{item.label}</span>
              </div>
              <span className={`text-[11px] font-medium ${tone} shrink-0`}>{label}</span>
            </li>
          );
        })}
      </ul>
      {allGood && (
        <p className="mt-3 text-[12px] text-emerald-700">All required docs on file and valid.</p>
      )}
      {!allGood && (
        <p className="mt-3 text-[12px] text-ppp-charcoal-500">
          {missing > 0 && <span className="text-rose-700">{missing} missing</span>}
          {missing > 0 && (expired > 0 || soon > 0) && <span> · </span>}
          {expired > 0 && <span className="text-rose-700">{expired} expired</span>}
          {expired > 0 && soon > 0 && <span> · </span>}
          {soon > 0 && <span className="text-amber-700">{soon} expiring soon</span>}
        </p>
      )}
    </section>
  );
}

function healthDecoration(item: ComplianceItem): { dot: string; label: string; tone: string } {
  switch (item.health) {
    case "missing":
      return { dot: "bg-rose-500", label: "Missing", tone: "text-rose-700" };
    case "expired":
      return {
        dot: "bg-rose-500",
        label: `Expired ${item.days_until !== null ? `${Math.abs(item.days_until)}d ago` : ""}`.trim(),
        tone: "text-rose-700",
      };
    case "soon":
      return {
        dot: "bg-amber-500",
        label: `${item.days_until ?? 0}d left`,
        tone: "text-amber-700",
      };
    case "ok":
      return {
        dot: "bg-emerald-500",
        label: item.expires_at
          ? `${item.days_until ?? 0}d left`
          : "On file",
        tone: "text-emerald-700",
      };
  }
}

function KeyDatesCard({
  items,
  className,
}: {
  items: ComplianceItem[];
  className?: string;
}) {
  // Show only items that have an actual expires_at (no expiry = no
  // entry in this card). Sort by soonest first — what's most urgent
  // bubbles to the top. If nothing has a date, the card shows an
  // invitational empty state pointing at the Documents tab.
  const dated = items
    .filter((i) => !!i.expires_at)
    .sort((a, b) => {
      const at = new Date(a.expires_at ?? 0).getTime();
      const bt = new Date(b.expires_at ?? 0).getTime();
      return at - bt;
    });
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Key dates</h2>
      <p className="text-[11px] text-ppp-charcoal-500 mb-3">
        Upcoming compliance deadlines, soonest first.
      </p>
      {dated.length === 0 ? (
        <p className="text-[12px] text-ppp-charcoal-500 italic">
          No expiry dates on file. Set one when you upload a COI or insurance cert from the Documents tab.
        </p>
      ) : (
        <ul className="space-y-2">
          {dated.map((item) => {
            const dt = item.expires_at ? new Date(item.expires_at) : null;
            const display = dt
              ? dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
              : "—";
            const { tone } = healthDecoration(item);
            const inDays =
              item.days_until !== null && item.days_until !== undefined
                ? item.days_until < 0
                  ? `${Math.abs(item.days_until)}d ago`
                  : item.days_until === 0
                  ? "today"
                  : `in ${item.days_until}d`
                : "";
            return (
              <li key={item.category} className="flex items-center justify-between gap-3 py-1">
                <div className="min-w-0">
                  <div className="text-[13px] text-ppp-charcoal truncate">{item.label}</div>
                  <div className={`text-[11px] ${tone}`}>
                    {display}
                    {inDays && <span className="text-ppp-charcoal-500"> · {inDays}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TagsCard({
  accountId,
  tags,
  suggestions,
  className,
}: {
  accountId: string;
  tags: AccountTag[];
  suggestions: string[];
  className?: string;
}) {
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Tags</h2>
      <p className="text-[11px] text-ppp-charcoal-500 mb-3">
        Free-form labels — different from Industry. Use them to group accounts (Hospitality, Healthcare,
        Property Mgmt) and filter the list page.
      </p>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200"
            >
              {t.tag}
              <form action={removeTagAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="tag_id" value={t.id} />
                <button
                  type="submit"
                  aria-label={`Remove ${t.tag}`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[32px] min-w-[32px] inline-flex items-center justify-center text-emerald-700/60 hover:text-emerald-900 touch-manipulation"
                >
                  ✕
                </button>
              </form>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-ppp-charcoal-500 italic mb-3">No tags yet.</p>
      )}
      <form action={addTagAction} className="flex flex-col sm:flex-row sm:items-end gap-2">
        <input type="hidden" name="account_id" value={accountId} />
        <div className="flex-1">
          <label htmlFor="new_tag" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
            Add tag
          </label>
          <input
            id="new_tag"
            name="tag"
            type="text"
            required
            maxLength={MAX_TAG_LENGTH}
            placeholder="e.g. Hospitality"
            list="tag-suggestions"
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
          />
          {suggestions.length > 0 && (
            <datalist id="tag-suggestions">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </div>
        <button
          type="submit"
          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] shrink-0"
        >
          Add
        </button>
      </form>
    </section>
  );
}

function InfoCards({ account }: { account: CommercialAccount }) {
  return (
    <>
      <Card title="Company">
        <Field label="Company name" value={account.company_name} />
        <Field label="DBA" value={account.dba} />
        <Field label="Industry" value={account.industry} />
        <Field label="Website" value={account.website} link />
      </Card>

      <Card title="Billing address">
        <Field label="Street" value={account.billing_street} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="City" value={account.billing_city} />
          <Field label="State" value={account.billing_state} />
          <Field label="ZIP" value={account.billing_zip} />
        </div>
      </Card>

      <Card title="Primary site address">
        <Field label="Street" value={account.site_street} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="City" value={account.site_city} />
          <Field label="State" value={account.site_state} />
          <Field label="ZIP" value={account.site_zip} />
        </div>
      </Card>

      <Card title="Contact">
        <Field label="Main phone" value={account.phone} />
        <Field label="AP phone" value={account.ap_phone} />
      </Card>

      <Card title="Compliance">
        <Field
          label="Vendor compliance"
          value={account.vendor_compliance_status ? complianceLabel(account.vendor_compliance_status) : null}
        />
        <Field
          label="Prequalification"
          value={account.prequalification_status ? prequalLabel(account.prequalification_status) : null}
        />
        <Field
          label="Insurance min liability"
          value={account.insurance_min_liability != null ? `$${account.insurance_min_liability.toLocaleString()}` : null}
        />
        <Field
          label="Insurance min workers' comp"
          value={
            account.insurance_min_workers_comp != null
              ? `$${account.insurance_min_workers_comp.toLocaleString()}`
              : null
          }
        />
      </Card>

      <Card title="Tax">
        <Field
          label="Tax exempt"
          value={account.tax_exempt ? "Yes" : "No"}
        />
        {account.tax_exempt && (
          <Field label="Tax exempt certificate #" value={account.tax_exempt_cert_number} />
        )}
      </Card>

      {account.notes && (
        <Card title="Notes" className="lg:col-span-2">
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">{account.notes}</p>
        </Card>
      )}
    </>
  );
}

// ───────────────────── Contacts tab ─────────────────────

async function addContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const full_name = String(formData.get("full_name") ?? "");
  const role = String(formData.get("role") ?? "other") as ContactRole;
  const email = (formData.get("email") as string) || null;
  const phone = (formData.get("phone") as string) || null;
  const title = (formData.get("title") as string) || null;
  const notes = (formData.get("notes") as string) || null;

  const result = await addContactToAccount({
    account_id,
    full_name,
    role,
    email,
    phone,
    title,
    notes,
    created_by_user_id: user.id,
  });

  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=contacts&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=contacts`);
}

async function setPrimaryContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const account_contact_id = String(formData.get("account_contact_id") ?? "");
  const make_primary = String(formData.get("make_primary") ?? "true") === "true";
  if (!UUID_RE.test(account_id) || !UUID_RE.test(account_contact_id)) {
    redirect("/commercial/accounts");
  }
  const result = await setPrimaryContact(account_id, account_contact_id, make_primary, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=contacts&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=contacts`);
}

async function touchContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const account_contact_id = String(formData.get("account_contact_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(account_contact_id)) {
    redirect("/commercial/accounts");
  }
  await touchContact(account_id, account_contact_id, user.id);
  redirect(`/commercial/accounts/${account_id}?tab=contacts`);
}

async function detachContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const account_contact_id = String(formData.get("account_contact_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(account_contact_id)) {
    redirect("/commercial/accounts");
  }
  await detachContactFromAccount(account_contact_id, user.id);
  redirect(`/commercial/accounts/${account_id}?tab=contacts`);
}

async function ContactsTab({ accountId, errorMessage }: { accountId: string; errorMessage?: string }) {
  const contacts = await listAccountContacts(accountId);
  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {/* Add-contact form */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Add contact</h2>
        <form action={addContactAction} className="space-y-3">
          <input type="hidden" name="account_id" value={accountId} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ContactInput id="full_name" label="Name *" required />
            <ContactInput id="title" label="Title" placeholder="VP Facilities, Property Mgr…" />
            <ContactInput id="email" label="Email" type="email" />
            <ContactInput id="phone" label="Phone" type="tel" />
          </div>
          <div>
            <label htmlFor="role" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
              Role
            </label>
            <select
              id="role"
              name="role"
              defaultValue="decision_maker"
              className="w-full sm:w-auto px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 bg-white"
            >
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="contact_notes" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
              Notes
            </label>
            <input
              id="contact_notes"
              name="notes"
              type="text"
              placeholder="Optional"
              className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation"
            >
              Add contact
            </button>
          </div>
        </form>
      </section>

      {/* Existing contacts */}
      {contacts.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No contacts yet. Add the decision-maker, estimator, PM, or anyone else from the customer side.
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {contacts.length} contact{contacts.length === 1 ? "" : "s"}
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {contacts.map(({ contact, attachments }) => (
              <li key={contact.id} className="px-4 py-4">
                <ContactRow
                  contact={contact}
                  attachments={attachments}
                  accountId={accountId}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ContactRow({
  contact,
  attachments,
  accountId,
}: {
  contact: CommercialContact;
  attachments: Array<{
    account_contact_id: string;
    role: ContactRole;
    is_default_for: string | null;
    notes: string | null;
    is_primary: boolean;
    last_contacted_at: string | null;
  }>;
  accountId: string;
}) {
  const primaryAttachment = attachments.find((a) => a.is_primary);
  // "Last touched" surfaces the most recent timestamp across this
  // person's role attachments. We mark a contact "touched" when anyone
  // on the PPP side records an interaction — drives the per-contact
  // freshness badge so Alex can spot relationships going cold.
  const lastTouchedAt = attachments
    .map((a) => a.last_contacted_at)
    .filter((x): x is string => !!x)
    .sort()
    .pop();
  const touchedDisplay = lastTouchedAt ? relativeTouch(lastTouchedAt) : null;
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-ppp-charcoal text-sm">{contact.full_name}</span>
          {primaryAttachment && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              <span aria-hidden>★</span> Primary
            </span>
          )}
        </div>
        {contact.title && (
          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{contact.title}</div>
        )}
        <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="text-emerald-700 hover:text-emerald-800 break-all">
              {contact.email}
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="text-ppp-charcoal-700 hover:text-ppp-charcoal">
              {contact.phone}
            </a>
          )}
          {touchedDisplay && (
            <span className="text-ppp-charcoal-500">Last touched {touchedDisplay}</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.account_contact_id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200"
              title={a.notes ?? undefined}
            >
              {roleLabel(a.role)}
              <form action={detachContactAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="account_contact_id" value={a.account_contact_id} />
                <button
                  type="submit"
                  aria-label={`Remove ${roleLabel(a.role)} role`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[32px] min-w-[32px] inline-flex items-center justify-center text-emerald-700/80 hover:text-emerald-900 touch-manipulation"
                >
                  ✕
                </button>
              </form>
            </span>
          ))}
        </div>
        {/* Quick actions: mark/unmark primary + log a touchpoint. Tied
            to ONE attachment row each (the primary toggle picks the
            first attachment by default so a one-role contact star is
            unambiguous; the touch action records on the same row). */}
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <form action={setPrimaryContactAction} className="inline">
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="account_contact_id" value={attachments[0].account_contact_id} />
              <input type="hidden" name="make_primary" value={primaryAttachment ? "false" : "true"} />
              <button
                type="submit"
                className="text-[11px] text-ppp-charcoal-500 hover:text-amber-700 underline underline-offset-2 touch-manipulation min-h-[32px] inline-flex items-center"
              >
                {primaryAttachment ? "Unstar primary" : "Mark as primary"}
              </button>
            </form>
            <form action={touchContactAction} className="inline">
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="account_contact_id" value={attachments[0].account_contact_id} />
              <button
                type="submit"
                className="text-[11px] text-ppp-charcoal-500 hover:text-emerald-700 underline underline-offset-2 touch-manipulation min-h-[32px] inline-flex items-center"
                title="Record that you just emailed or called this contact"
              >
                I just touched base
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact relative-time label for "last touched X ago" on contacts.
 *  Keeps the badge to one line on mobile. */
function relativeTouch(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function ContactInput({
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

// ───────────────────── Team tab ─────────────────────

async function addAssignmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const user_id = String(formData.get("user_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (user_id && !UUID_RE.test(user_id)) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent("Invalid staff selection.")}`);
  }
  const role = String(formData.get("role") ?? "other") as AssignmentRole;
  const is_primary = formData.get("is_primary") === "on";
  const notes = (formData.get("notes") as string) || null;

  if (!user_id) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent("Pick a PPP staff member.")}`);
  }

  const result = await addAssignment({
    account_id,
    user_id,
    role,
    is_primary,
    notes,
    assigned_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=team`);
}

async function removeAssignmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const assignment_id = String(formData.get("assignment_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(assignment_id)) {
    redirect("/commercial/accounts");
  }
  await removeAssignment(assignment_id, user.id);
  redirect(`/commercial/accounts/${account_id}?tab=team`);
}

async function TeamTab({ accountId, errorMessage }: { accountId: string; errorMessage?: string }) {
  const [team, assignableStaff] = await Promise.all([
    listAccountTeam(accountId),
    listAssignableStaff(),
  ]);
  const teamUserIds = new Set(team.map((t) => t.user_id));
  // Count by role so we can show "1 sales rep · 2 PMs" inline at the top
  // — gives Alex a one-glance read of the team shape without scanning.
  // Find which roles have NO primary holder — surface as warnings so the
  // account doesn't run with "nobody knows who 'THE' sales rep is."
  const rolesWithPrimary = new Set(
    team.flatMap((p) => p.assignments.filter((a) => a.is_primary).map((a) => a.role))
  );
  const rolesPresent = new Set(
    team.flatMap((p) => p.assignments.map((a) => a.role))
  );
  const rolesMissingPrimary = Array.from(rolesPresent).filter((r) => !rolesWithPrimary.has(r));
  const noStaffWithAccess = assignableStaff.length === 0;

  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      {/* Missing-primary warning(s) — surface when someone is on the team in
          a role but no one holds primary for that role. Drives the "who's
          THE sales rep?" question up front. */}
      {rolesMissingPrimary.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <strong>Heads up:</strong> no primary set for{" "}
          {rolesMissingPrimary.map((r) => assignmentRoleLabel(r as AssignmentRole)).join(", ")}.
          Tap a pill in that role and re-add with <em>Mark as primary</em> checked so the
          Account 360 highlights the right person.
        </div>
      )}

      {/* No-access warning — if NO PPP staff have Commercial CC access,
          the form is unusable. Tell them how to fix it. */}
      {noStaffWithAccess && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          No PPP staff have Commercial Command Center access yet. Grant access on
          the admin Users page, then come back to assign people to this account.
        </div>
      )}

      {/* Add assignment form */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Assign PPP staff</h2>
        <form action={addAssignmentAction} className="space-y-3">
          <input type="hidden" name="account_id" value={accountId} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="user_id" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                PPP staff *
              </label>
              <select
                id="user_id"
                name="user_id"
                required
                defaultValue=""
                className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 bg-white min-h-[44px] sm:min-h-0"
              >
                <option value="" disabled>
                  Pick someone…
                </option>
                {assignableStaff.map((s) => {
                  const label = s.full_name ? `${s.full_name} (${s.email})` : s.email;
                  const already = teamUserIds.has(s.user_id);
                  return (
                    <option key={s.user_id} value={s.user_id}>
                      {label}
                      {already ? "  · already on team" : ""}
                    </option>
                  );
                })}
              </select>
              {assignableStaff.length > 0 && assignableStaff.every((s) => teamUserIds.has(s.user_id)) && (
                <p className="text-[11px] text-ppp-charcoal-500 mt-1">
                  Everyone with Commercial CC access is already on this team — pick a
                  different role to add them again, or grant new access on the admin
                  Users page first.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="role" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                Role *
              </label>
              <select
                id="role"
                name="role"
                defaultValue="sales_rep"
                className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 bg-white min-h-[44px] sm:min-h-0"
              >
                {ASSIGNMENT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {assignmentRoleLabel(r)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-emerald-600/30" />
            Mark as primary in this role (replaces any current primary)
          </label>
          <div>
            <label htmlFor="team_notes" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
              Notes
            </label>
            <input
              id="team_notes"
              name="notes"
              type="text"
              placeholder="Optional — e.g. 'covering while Macarena is out'"
              className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 min-h-[44px] touch-manipulation"
            >
              Add to team
            </button>
          </div>
        </form>
      </section>

      {/* Symbol key — Karan 2026-06-14: every banner / pill icon explained
          inline so Alex never has to ask "what does ★ mean?" Stays compact;
          tooltips carry the long form for each. */}
      <details className="bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden group" open={team.length === 0}>
        <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between">
          <span>What do the symbols mean?</span>
          <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
        </summary>
        <ul className="px-4 py-3 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-700 space-y-1.5">
          <li>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-600 text-white border-emerald-700 mr-1">
              ★ Sales Rep
            </span>
            Primary holder of this role — the &ldquo;THE&rdquo; person platform-wide. One per (account, role).
          </li>
          <li>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200 mr-1">
              Sales Rep
            </span>
            Standard role assignment without primary status — supports the primary or covers when they&apos;re out.
          </li>
          <li className="text-amber-800">
            <strong>⚠️ Amber banner</strong> · a role has people but nobody marked primary. Re-add someone in that role with &ldquo;Mark as primary&rdquo; checked.
          </li>
          <li className="text-rose-700">
            <strong>🚫 Rose banner</strong> · no PPP staff have Commercial Command Center access yet. Grant on the admin Users page.
          </li>
        </ul>
      </details>

      {/* Current team */}
      {team.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <div className="text-sm font-medium text-ppp-charcoal">No team yet</div>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            Add the sales rep, project manager, and anyone else from PPP working on
            this account. Mark one person primary in each role so the rest of the
            platform knows who to surface on emails, scheduling, and the Account 360.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {team.length} on team
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {team.map((person) => (
              <li key={person.user_id} className="px-4 py-4">
                <TeamRow person={person} accountId={accountId} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TeamRow({
  person,
  accountId,
}: {
  person: {
    user_id: string;
    user_email: string;
    user_full_name: string | null;
    assignments: Array<{
      id: string;
      role: AssignmentRole;
      is_primary: boolean;
      notes: string | null;
      assigned_at: string;
    }>;
  };
  accountId: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ppp-charcoal text-sm">
          {person.user_full_name ?? person.user_email}
        </div>
        <a
          href={`mailto:${person.user_email}`}
          className="text-[11px] text-emerald-700 hover:text-emerald-800 break-all"
        >
          {person.user_email}
        </a>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {person.assignments.map((a) => {
            const since = (() => {
              const ms = Date.now() - new Date(a.assigned_at).getTime();
              const days = Math.floor(ms / 86_400_000);
              if (days < 1) return "today";
              if (days === 1) return "yesterday";
              if (days < 7) return `${days} days ago`;
              if (days < 30) return `${Math.floor(days / 7)}w ago`;
              return `${Math.floor(days / 30)}mo ago`;
            })();
            const tipBits = [
              a.is_primary ? "Primary holder of this role" : null,
              `Assigned ${since}`,
              a.notes ? `Note: ${a.notes}` : null,
            ].filter(Boolean);
            return (
            <span
              key={a.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${
                a.is_primary
                  ? "bg-emerald-600 text-white border-emerald-700"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
              }`}
              title={tipBits.join("\n")}
            >
              {a.is_primary && <span aria-hidden>★</span>}
              {assignmentRoleLabel(a.role)}
              <form action={removeAssignmentAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="assignment_id" value={a.id} />
                <button
                  type="submit"
                  aria-label={`Remove ${assignmentRoleLabel(a.role)} role from ${person.user_full_name ?? person.user_email}`}
                  className={`-mr-1 ml-0.5 px-2 py-1 min-h-[32px] min-w-[32px] inline-flex items-center justify-center touch-manipulation ${a.is_primary ? "text-white/80 hover:text-white" : "text-emerald-700/80 hover:text-emerald-900"}`}
                >
                  ✕
                </button>
              </form>
            </span>
          );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────── Documents tab ─────────────────────

async function archiveDocumentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const document_id = String(formData.get("document_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(document_id)) {
    redirect("/commercial/accounts");
  }
  const result = await archiveDocument(document_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=documents&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=documents`);
}

async function DocumentsTab({ accountId, errorMessage }: { accountId: string; errorMessage?: string }) {
  const grouped = await listAccountDocuments(accountId);
  const hasAnyDocs = grouped.some((g) => g.active || g.history.length > 0);

  // Pre-compute expiry summary so the heads-up banner can fire when needed.
  const expiringSoon = grouped
    .map((g) => ({ category: g.category, doc: g.active }))
    .filter((g) => g.doc && expiryStatus(g.doc.expires_at).status === "soon");
  const expired = grouped
    .map((g) => ({ category: g.category, doc: g.active }))
    .filter((g) => g.doc && expiryStatus(g.doc.expires_at).status === "expired");

  return (
    <div className="space-y-5">
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      {expired.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          <strong>⏰ Expired:</strong>{" "}
          {expired.map((e) => documentCategoryLabel(e.category)).join(", ")}. Upload a new version to clear.
        </div>
      )}
      {expiringSoon.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <strong>⚠️ Expiring soon:</strong>{" "}
          {expiringSoon.map((e) => documentCategoryLabel(e.category)).join(", ")}. PPP will be blocked from working
          if these lapse on a covered contract.
        </div>
      )}

      {/* Upload form — client-side multipart POST to the API route. Server
          actions can't currently accept binary File payloads cleanly, so
          we use a small client form that posts via fetch + reloads on
          success. */}
      <CommercialDocumentUploadForm accountId={accountId} />

      {/* Symbol key — what every badge means */}
      <details className="bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden group">
        <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between">
          <span>What do the badges mean?</span>
          <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
        </summary>
        <ul className="px-4 py-3 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-700 space-y-1.5">
          <li>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200 mr-1">
              v3
            </span>
            Active version. Highest version number wins. Older versions stack into &ldquo;History&rdquo;.
          </li>
          <li>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-100 text-emerald-800 border-emerald-200 mr-1">
              ✓ Valid 6mo
            </span>
            Document is in good standing &mdash; expires more than 30 days out (or never).
          </li>
          <li className="text-amber-800">
            <strong>⚠️ Expires in N days</strong> &middot; within 30 days. Plan a renewal now.
          </li>
          <li className="text-rose-700">
            <strong>⏰ Expired N days ago</strong> &middot; document is past its expiry date. Upload a new version.
          </li>
          <li className="text-ppp-charcoal-500">
            <strong>Archived</strong> &middot; superseded by a newer version. Still downloadable for history.
          </li>
        </ul>
      </details>

      {/* Per-category cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {grouped.map((g) => (
          <DocumentCategoryCard key={g.category} group={g} accountId={accountId} />
        ))}
      </div>

      {!hasAnyDocs && (
        <p className="text-center text-[12px] text-ppp-charcoal-500 italic">
          No documents uploaded yet. Start with the COI &mdash; that&apos;s the one PPP needs first.
        </p>
      )}
    </div>
  );
}

function DocumentCategoryCard({
  group,
  accountId,
}: {
  group: { category: DocumentCategory; active: CommercialAccountDocument | null; history: CommercialAccountDocument[] };
  accountId: string;
}) {
  const { category, active, history } = group;
  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 bg-[var(--color-surface-muted)]">
        <h3 className="text-sm font-bold text-ppp-charcoal">{documentCategoryLabel(category)}</h3>
      </div>
      {active ? (
        <DocumentRow doc={active} accountId={accountId} isActive />
      ) : (
        <div className="px-4 py-5 text-center text-[12px] text-ppp-charcoal-500">
          No active document. Upload one above.
        </div>
      )}
      {history.length > 0 && (
        <details className="border-t border-ppp-charcoal-100">
          <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none">
            History ({history.length})
          </summary>
          <ul className="divide-y divide-ppp-charcoal-100">
            {history.map((h) => (
              <li key={h.id}>
                <DocumentRow doc={h} accountId={accountId} isActive={false} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function DocumentRow({
  doc,
  accountId,
  isActive,
}: {
  doc: CommercialAccountDocument;
  accountId: string;
  isActive: boolean;
}) {
  const exp = expiryStatus(doc.expires_at);
  const expBadge = (() => {
    if (exp.status === "expired") {
      const n = Math.abs(exp.daysUntil ?? 0);
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-rose-50 text-rose-700 border-rose-200">
          ⏰ Expired {n}d ago
        </span>
      );
    }
    if (exp.status === "soon") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-amber-50 text-amber-800 border-amber-200">
          ⚠️ Expires in {exp.daysUntil}d
        </span>
      );
    }
    if (doc.expires_at) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
          ✓ Valid
        </span>
      );
    }
    return null;
  })();

  const sizeLabel = (() => {
    if (!doc.size_bytes) return null;
    const kb = doc.size_bytes / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  })();

  return (
    <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
            v{doc.version}
          </span>
          {expBadge}
          {!isActive && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100">
              Archived
            </span>
          )}
        </div>
        <a
          href={`/api/commercial/accounts/${accountId}/documents/${doc.id}/download`}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-800 break-all"
        >
          {doc.file_name}
        </a>
        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
          {sizeLabel && <span>{sizeLabel}</span>}
          {sizeLabel && <span aria-hidden>·</span>}
          <span>Uploaded {new Date(doc.uploaded_at).toLocaleDateString()}</span>
          {doc.expires_at && (
            <>
              <span aria-hidden>·</span>
              <span>Expires {new Date(doc.expires_at).toLocaleDateString()}</span>
            </>
          )}
        </div>
        {doc.notes && (
          <p className="text-[11px] text-ppp-charcoal-600 italic mt-1">{doc.notes}</p>
        )}
      </div>
      {isActive && !doc.archived && (
        <form action={archiveDocumentAction} className="shrink-0">
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="document_id" value={doc.id} />
          <button
            type="submit"
            className="px-3 py-1.5 text-[12px] font-medium text-ppp-charcoal-700 border border-ppp-charcoal-100 rounded-lg hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
            title="Archive without replacement. File stays downloadable in History."
          >
            Archive
          </button>
        </form>
      )}
    </div>
  );
}

function ComingSoonTab({ label, phase }: { label: string; phase: string }) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
      <strong className="block text-ppp-charcoal">{label} tab</strong>
      <p className="mt-1">Coming {phase} in the Phase 1 build.</p>
    </div>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-bold text-ppp-charcoal mb-3">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  link,
}: {
  label: string;
  value: string | null;
  link?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-32 sm:w-36 shrink-0 text-[11px] uppercase tracking-wide font-bold text-ppp-charcoal-500">
        {label}
      </span>
      {value ? (
        link ? (
          <a
            href={value.startsWith("http") ? value : `https://${value}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-emerald-700 hover:text-emerald-800 break-all"
          >
            {value}
          </a>
        ) : (
          <span className="text-ppp-charcoal break-words">{value}</span>
        )
      ) : (
        <span className="text-ppp-charcoal-300 italic text-[12px]">not set</span>
      )}
    </div>
  );
}

// ───────────────────── Account 360 strip ─────────────────────

function AccountOverviewStrip({ overview }: { overview: AccountOverview | null }) {
  // Graceful no-op if the view migration hasn't been applied yet. The page
  // still renders — the strip just hides until 024 is pasted.
  if (!overview) return null;

  const activity = relativeActivity(overview.last_activity_at);
  const tone = activityTone(overview.last_activity_at);
  const activityClass =
    tone === "ok"
      ? "text-emerald-700 bg-emerald-50 border-emerald-200"
      : tone === "stale"
      ? "text-amber-700 bg-amber-50 border-amber-200"
      : "text-rose-700 bg-rose-50 border-rose-200";

  // Document health pip — green if no expired & no expiring-soon, amber
  // if expiring-soon, rose if any expired.
  const docHealth =
    overview.expired_document_count > 0
      ? { label: `${overview.expired_document_count} expired`, cls: "text-rose-700" }
      : overview.expiring_soon_document_count > 0
      ? { label: `${overview.expiring_soon_document_count} expiring`, cls: "text-amber-700" }
      : overview.active_document_count > 0
      ? { label: "all current", cls: "text-emerald-700" }
      : { label: "none on file", cls: "text-ppp-charcoal-500" };

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          Account 360
        </h2>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${activityClass}`}
          title={`Most recent activity on this account (contact added, doc uploaded, team change). Last touched: ${overview.last_activity_at}`}
        >
          Activity: {activity}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <KpiTile
          tone="live"
          num={overview.contact_count}
          label="Contacts"
          href={`#contacts`}
        />
        <KpiTile
          tone="live"
          num={overview.ppp_team_count}
          label="PPP team"
        />
        <KpiTile
          tone="live"
          num={overview.active_document_count}
          label="Documents"
          sub={docHealth.label}
          subCls={docHealth.cls}
        />
        <KpiTile
          tone="placeholder"
          label="Total bid"
          placeholder="Phase 2"
        />
        <KpiTile
          tone="placeholder"
          label="Invoiced"
          placeholder="Phase 8"
        />
        <KpiTile
          tone="placeholder"
          label="Paid"
          placeholder="Phase 8"
        />
        <KpiTile
          tone="placeholder"
          label="Balance"
          placeholder="Phase 8"
        />
        <KpiTile
          tone="placeholder"
          label="Open opps"
          placeholder="Phase 2"
        />
      </div>
    </section>
  );
}

function KpiTile({
  tone,
  num,
  label,
  sub,
  subCls,
  placeholder,
  href,
}: {
  tone: "live" | "placeholder";
  num?: number | null;
  label: string;
  sub?: string;
  subCls?: string;
  placeholder?: string;
  href?: string;
}) {
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-1">
        {tone === "live" ? (
          <span className="text-xl sm:text-2xl font-bold text-ppp-charcoal leading-none">
            {(num ?? 0).toLocaleString()}
          </span>
        ) : (
          <span className="text-[11px] font-medium text-ppp-charcoal-400 italic">
            Coming with {placeholder}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-1">
        <span className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          {label}
        </span>
        {sub && (
          <span className={`text-[10px] sm:text-[11px] font-medium ${subCls ?? "text-ppp-charcoal-500"}`}>
            {sub}
          </span>
        )}
      </div>
    </>
  );

  const cls =
    tone === "live"
      ? "bg-emerald-50/50 border-emerald-200"
      : "bg-ppp-charcoal-50/50 border-ppp-charcoal-100";

  return href ? (
    <a
      href={href}
      className={`block rounded-lg border px-3 py-2.5 sm:px-4 sm:py-3 transition-colors hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-600/40 touch-manipulation ${cls}`}
    >
      {content}
    </a>
  ) : (
    <div className={`rounded-lg border px-3 py-2.5 sm:px-4 sm:py-3 ${cls}`}>{content}</div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "emerald" | "blue" | "amber" | "rose" | "neutral" }) {
  const cls = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    neutral: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100",
  }[tone];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${cls}`}>
      {children}
    </span>
  );
}

function ratingTone(r: "A" | "B" | "C"): "emerald" | "blue" | "amber" {
  return r === "A" ? "emerald" : r === "B" ? "blue" : "amber";
}

function complianceTone(s: "green" | "yellow" | "red" | "not_started"): "emerald" | "amber" | "rose" | "neutral" {
  return s === "green" ? "emerald" : s === "yellow" ? "amber" : s === "red" ? "rose" : "neutral";
}

function complianceLabel(s: "green" | "yellow" | "red" | "not_started"): string {
  return s === "green" ? "Approved" : s === "yellow" ? "In progress" : s === "red" ? "Issues" : "Not started";
}

function prequalLabel(s: "not_started" | "pending" | "approved" | "rejected"): string {
  return s === "not_started" ? "Not started" : s === "pending" ? "Pending" : s === "approved" ? "Approved" : "Rejected";
}
