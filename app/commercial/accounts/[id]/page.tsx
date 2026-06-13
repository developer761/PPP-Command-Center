import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import {
  listAccountContacts,
  addContactToAccount,
  detachContactFromAccount,
  CONTACT_ROLES,
  roleLabel,
  type ContactRole,
  type CommercialContact,
} from "@/lib/commercial/accounts/contacts";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{ tab?: string; error?: string }>;

const TABS = [
  { key: "info", label: "Info" },
  { key: "documents", label: "Documents" },
  { key: "contacts", label: "Contacts" },
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
  const sp = await searchParams;
  const tab = (sp.tab && TABS.some((t) => t.key === sp.tab) ? sp.tab : "info") as
    | "info"
    | "documents"
    | "contacts"
    | "performance";

  const account = await getCommercialAccount(id);
  if (!account) notFound();

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
          <div className="min-w-0">
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
          </div>
        </div>
      </header>

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
      {tab === "info" && <InfoTab account={account} />}
      {tab === "documents" && <ComingSoonTab label="Documents" phase="next" />}
      {tab === "contacts" && <ContactsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "performance" && <ComingSoonTab label="Performance" phase="next" />}
    </div>
  );
}

function InfoTab({ account }: { account: CommercialAccount }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
    </div>
  );
}

// ───────────────────── Contacts tab ─────────────────────

async function addContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
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

async function detachContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const account_contact_id = String(formData.get("account_contact_id") ?? "");
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
              className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700"
            >
              Add contact
            </button>
          </div>
        </form>
      </section>

      {/* Existing contacts */}
      {contacts.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No contacts attached yet.
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
  }>;
  accountId: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ppp-charcoal text-sm">{contact.full_name}</div>
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
                  className="-mr-1 ml-0.5 px-1 text-emerald-700/60 hover:text-emerald-900"
                >
                  ✕
                </button>
              </form>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
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
        className="w-full px-3 py-2 text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600"
      />
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
