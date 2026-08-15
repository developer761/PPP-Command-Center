import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { createCommercialAccount } from "@/lib/commercial/accounts/mutations";
import { createCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { addContactToAccount } from "@/lib/commercial/accounts/contacts";
import { RfpImportForm } from "@/components/commercial/rfp-import-form";

/**
 * New opportunity from an RFP email (Karan 2026-08-14). Paste the invitation-to-
 * bid → Claude extracts the fields → you review/edit an ordinary New Opportunity
 * form → it finds-or-creates the GC account and opens the deal. Human-review
 * before create; nothing is auto-created.
 */
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function createFromRfpAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const s = (k: string, max = 500) => String(formData.get(k) ?? "").trim().slice(0, max);
  const gcCompany = s("gc_company", 200);
  const title = s("title", 200);
  const street = s("property_street", 200);
  const city = s("property_city", 120);
  const state = s("property_state", 60);
  const zip = s("property_zip", 20);
  const bidDueRaw = s("bid_due_date", 10);
  const bidDue = /^\d{4}-\d{2}-\d{2}$/.test(bidDueRaw) ? bidDueRaw : null;
  const scope = s("scope", 4000);
  const contactName = s("contact_name", 200);
  const contactEmail = s("contact_email", 200);
  const contactPhone = s("contact_phone", 60);

  const back = "/commercial/opportunities/new-from-rfp";
  if (!gcCompany) redirect(`${back}?error=${encodeURIComponent("Enter the general contractor's company name.")}`);
  if (!title) redirect(`${back}?error=${encodeURIComponent("Enter a project title.")}`);

  // Find-or-create the GC account by exact (case-insensitive) name — no
  // duplicate GCs for a repeat sender. LIKE wildcards in the name are escaped.
  const sb = commercialDb();
  const like = gcCompany.replace(/[\\%_]/g, "\\$&");
  const { data: existing } = await sb
    .from("commercial_accounts")
    .select("id")
    .is("deleted_at", null)
    .ilike("company_name", like)
    .limit(1)
    .maybeSingle();

  let accountId: string;
  if (existing?.id) {
    accountId = (existing as { id: string }).id;
  } else {
    const created = await createCommercialAccount({
      company_name: gcCompany,
      phone: contactPhone || null,
      notes: "Created from a parsed RFP email.",
      created_by_user_id: user.id,
    });
    if (!created.ok) redirect(`${back}?error=${encodeURIComponent("Couldn't create the GC account — try again.")}`);
    accountId = created.account.id;
  }

  const description = [
    "Opened from a parsed RFP email.",
    scope ? `\nScope:\n${scope}` : "",
    contactName || contactEmail || contactPhone
      ? `\nContact: ${[contactName, contactEmail, contactPhone].filter(Boolean).join(" · ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const opp = await createCommercialOpportunity({
    account_id: accountId,
    title,
    description,
    source: "email",
    client_name: contactName || null,
    property_street: street || null,
    property_city: city || null,
    property_state: state || null,
    property_zip: zip || null,
    proposal_due_at: bidDue,
    rfp_received_at: new Date().toISOString(),
    created_by_user_id: user.id,
  });
  if (!opp.ok) redirect(`${back}?error=${encodeURIComponent(opp.error)}`);

  // Best-effort: capture the contact on the account so it isn't buried in notes.
  if (contactEmail && EMAIL_RE.test(contactEmail)) {
    try {
      await addContactToAccount({
        account_id: accountId,
        full_name: contactName || contactEmail,
        email: contactEmail,
        phone: contactPhone || null,
        role: "pm",
        created_by_user_id: user.id,
      });
    } catch {
      // The deal is created; a contact hiccup shouldn't block the redirect.
    }
  }

  redirect(`/commercial/opportunities/${opp.opportunity.id}?created=1`);
}

export default async function NewFromRfpPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const sp = await searchParams;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-2">
        <Link
          href="/commercial/opportunities"
          aria-label="Back to opportunities"
          className="inline-flex items-center justify-center h-9 w-9 -ml-1 rounded-lg text-ppp-charcoal-500 hover:text-ppp-charcoal hover:bg-ppp-charcoal-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
        </Link>
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">New opportunity from an RFP</h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1">Paste the invitation-to-bid email. Claude fills in what it can — you review before anything is created.</p>
        </div>
      </div>

      {sp.error ? (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">{sp.error}</div>
      ) : null}

      <RfpImportForm createAction={createFromRfpAction} />
    </div>
  );
}
