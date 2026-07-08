import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
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
  listAccountDocumentsWithUploaders,
  archiveDocument,
  restoreDocument,
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
  winRate,
  daysSinceIso,
  type AccountOverview,
} from "@/lib/commercial/accounts/overview";
import {
  getInvoiceRollupForAccount,
  type AccountInvoiceRollup,
} from "@/lib/commercial/invoices/rollup";
import { formatCentsCompact, formatCentsFull, fmtEtDate, parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { listCommercialInvoices, addPayment, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, invoiceStatusLabel, PAYMENT_METHODS } from "@/lib/commercial/invoices/constants";
import {
  listCommercialOpportunities,
  opportunityStatusLabel,
  formatBidRange,
  weightedPipelineCents,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  opportunitySourceLabel,
  type CommercialOpportunity,
  type OpportunityStatus,
} from "@/lib/commercial/opportunities/db";
import { createCommercialOpportunity, softDeleteCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { revalidatePath } from "next/cache";
import {
  listCurrentStatusEnteredAtByOpp,
  allowedNextStatuses,
  changeOpportunityStatus,
} from "@/lib/commercial/opportunities/status";
import { listOpenTaskStatsByOpp } from "@/lib/commercial/opportunities/tasks";
import { listLastNoteByOpp } from "@/lib/commercial/opportunities/notes";
import { listPrimaryLeadByOpp } from "@/lib/commercial/opportunities/assignments";
import { listAttachmentCountByOpp } from "@/lib/commercial/opportunities/attachments";
import { listSubmittalCountByOpp } from "@/lib/commercial/opportunities/submittals";
import { listFinishCountByOpp } from "@/lib/commercial/opportunities/finishes";
import {
  OPEN_OPP_STATUSES,
  TERMINAL_STATUSES,
  QUICK_FLIP_BLOCKED_STATUSES,
  isTerminalOpportunityStatus,
} from "@/lib/commercial/opportunities/constants";
import {
  getAccountRecentActivity,
  describeActivity,
} from "@/lib/commercial/accounts/recent-activity";
import {
  listAccountTags,
  listAllDistinctTags,
  addAccountTag,
  removeAccountTag,
  MAX_TAG_LENGTH,
  type AccountTag,
} from "@/lib/commercial/accounts/tags";
// InfoDot import removed 2026-07-08 Batch 2b — labels use native `title`
// attribute for hover tooltips instead of the visible `?` badge.

export const dynamic = "force-dynamic";

/** Cheap UUID sanity check used by every server action that pulls an
 *  id out of formData. We don't trust the client to send a real UUID —
 *  malformed values must fail fast, not propagate to Postgres. */
const UUID_RE = /^[0-9a-f-]{36}$/i;

type PP = Promise<{ id: string }>;
type SP = Promise<{
  tab?: string;
  sub?: string;
  error?: string;
  team_added?: string;
  team_skipped?: string;
  saved?: string;
  /** Karan 2026-07-08: per-deal drill-in section. When `?deal=<uuid>` is
   *  set AND the deal belongs to this account, OpportunitiesTab renders
   *  the DealDrillIn card at the top. Set by /opportunities/[id] redirect
   *  shim, by Edit-save redirects, and by the pipeline sheet's deep links. */
  deal?: string;
  /** Toast surface after softDeleteOpportunityAction fires on this account.
   *  URL-encoded deal title. */
  deleted?: string;
  /** Karan 2026-07-08: inline Record-payment flash surface on the
   *  Invoices tab. `payment_ok=1` fires the emerald success banner;
   *  `capped=1` with `requested` + `applied` cents fires the amber
   *  "overpayment capped" copy that mirrors the invoice-detail flow. */
  payment_ok?: string;
  capped?: string;
  requested?: string;
  applied?: string;
  /** Karan 2026-07-08: inline "+ New deal" collapsible state. Set from
   *  the retired /commercial/opportunities/new redirect (auto-opens the
   *  form) OR from a redirect after error. `created=1` + `created_title`
   *  fire the success toast. */
  new_deal?: string;
  created?: string;
  created_title?: string;
}>;

// Consolidated tab structure — see PRIMARY_TABS + SUB_TABS_BY_PRIMARY.
// Karan 2026-07-05: "too cluttered, needs better organization." Went
// from 9 flat tabs to 4 primary groups with sub-navigation. Email tab
// removed entirely per user's explicit ask.
//
//   Overview      → Info (default) · Team · Performance
//   People        → Contacts (default) · Notes
//   Deals & Docs  → Opportunities (default) · Documents
//   Activity      → Activity (chronological feed of all account events)
//
// Sub-nav uses URL `?tab=X&sub=Y`; missing/invalid sub falls back to the
// group's default. Legacy `?tab=info|team|contacts|...` deep links still
// resolve via `resolveTabParam` so old bookmarks + bell links work.
// Karan 2026-07-08: added "invoices" + "kpis" as top-level tabs per user
// ask ("add KPIs tab here as well" + "invoices tab where me kate katie or
// alex or whoever can quick edit"). Both are leaves — no sub-tabs.
type PrimaryTab = "overview" | "people" | "deals" | "invoices" | "activity" | "kpis";
type SubTab =
  | "info"
  | "team"
  | "performance"
  | "contacts"
  | "notes"
  | "opportunities"
  | "documents";
const PRIMARY_TABS: { key: PrimaryTab; label: string }[] = [
  // Deals first (primary read), Invoices next (Alex's money question),
  // KPIs (account-level scoreboard), People, Details, Activity.
  { key: "deals", label: "Deals" },
  { key: "invoices", label: "Invoices" },
  { key: "kpis", label: "KPIs" },
  { key: "people", label: "People" },
  { key: "overview", label: "Details" },
  { key: "activity", label: "Activity" },
];
type PrimaryWithSubs = Exclude<PrimaryTab, "activity" | "invoices" | "kpis">;
const SUB_TABS_BY_PRIMARY: Record<PrimaryWithSubs, { key: SubTab; label: string }[]> = {
  overview: [
    { key: "info", label: "Info" },
    { key: "team", label: "Team" },
    { key: "performance", label: "Performance" },
  ],
  people: [
    { key: "contacts", label: "Contacts" },
    { key: "notes", label: "Notes" },
  ],
  deals: [
    { key: "opportunities", label: "Pipeline" },
    { key: "documents", label: "Documents" },
  ],
};
const DEFAULT_SUB_BY_PRIMARY: Record<PrimaryWithSubs, SubTab> = {
  overview: "info",
  people: "contacts",
  deals: "opportunities",
};
function resolveTabParam(raw: string | undefined): { primary: PrimaryTab; sub: SubTab | null } {
  if (!raw) return { primary: "deals", sub: null };
  if (raw === "overview" || raw === "people" || raw === "deals" || raw === "activity" || raw === "invoices" || raw === "kpis") {
    return { primary: raw, sub: null };
  }
  if (raw === "info" || raw === "team" || raw === "performance") return { primary: "overview", sub: raw as SubTab };
  if (raw === "contacts" || raw === "notes") return { primary: "people", sub: raw as SubTab };
  if (raw === "opportunities" || raw === "documents") return { primary: "deals", sub: raw as SubTab };
  return { primary: "deals", sub: null };
}

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
  const rawTab = sp.tab;
  const rawSub = sp.sub;
  const { primary: resolvedPrimary, sub: resolvedSub } = resolveTabParam(rawTab);
  // Named `primaryTab` here to avoid collision with the `primary` local
  // below that refers to the primary contact record.
  const primaryTab: PrimaryTab = resolvedPrimary;
  // Karan 2026-07-08: invoices + kpis + activity are LEAF tabs — no sub-navigation.
  // Only overview / people / deals carry sub-tabs.
  const hasSubTabs = primaryTab === "overview" || primaryTab === "people" || primaryTab === "deals";
  const sub: SubTab | null = !hasSubTabs
    ? null
    : (rawSub && SUB_TABS_BY_PRIMARY[primaryTab].some((s) => s.key === rawSub))
    ? (rawSub as SubTab)
    : resolvedSub && SUB_TABS_BY_PRIMARY[primaryTab].some((s) => s.key === resolvedSub)
    ? resolvedSub
    : DEFAULT_SUB_BY_PRIMARY[primaryTab];
  // Legacy compat: existing tab dispatchers below check `tab === "info"`
  // etc. Preserve that shape so the sub-tabs still route correctly.
  const tab: SubTab | "activity" | "invoices" | "kpis" =
    primaryTab === "activity" ? "activity"
    : primaryTab === "invoices" ? "invoices"
    : primaryTab === "kpis" ? "kpis"
    : sub!;

  const account = await getCommercialAccount(id);
  if (!account) notFound();

  // Account 360 overview — counts pulled from the Postgres view in one
  // round-trip. Falls back to nulls if the view migration hasn't been
  // pasted yet (graceful degradation; the KPI strip just hides).
  // Primary contact loads in parallel so the header can show the
  // quick-email button without an extra round-trip.
  const [overview, primary, invoiceRollup] = await Promise.all([
    getAccountOverview(account.id),
    getPrimaryContact(account.id),
    getInvoiceRollupForAccount(account.id),
  ]);

  const teamAddedCount = sp.team_added ? Number(sp.team_added) : 0;
  const teamSkippedMsg = sp.team_skipped ?? null;
  const savedOk = sp.saved === "1";

  return (
    <div className="space-y-5">
      {/* Toast surface from the new-account team-on-create flow. Fades
          out via reload (no client component needed — the user navigating
          away clears the query string naturally). */}
      {savedOk && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2">
          <span aria-hidden>✓</span>
          <span>Changes saved.</span>
        </div>
      )}
      {teamAddedCount > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start gap-2 flex-wrap">
          <span aria-hidden>✓</span>
          <span className="flex-1 min-w-0">
            Added {teamAddedCount} team member{teamAddedCount === 1 ? "" : "s"}.
            They&apos;ve been emailed a link to this account.
          </span>
          <Link
            href={`/commercial/accounts/${account.id}?tab=documents`}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-semibold bg-white text-blue-700 border border-blue-300 hover:bg-blue-50 min-h-[36px] touch-manipulation shrink-0"
          >
            Upload COI / W-9 →
          </Link>
        </div>
      )}
      {teamSkippedMsg && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <span aria-hidden>⚠</span>
          <span>
            Some team members couldn&apos;t be added — {teamSkippedMsg}. Try again from
            the Team tab below.
          </span>
        </div>
      )}
      {/* Karan 2026-07-08 Batch 2a: hero polish. Removed the "← All
          accounts" back link — sidebar handles nav. Elevated the
          primary contact into the pill row so email/phone are one
          tap away without scrolling. Repeat-customer ★ signal moved
          from the Financial Snapshot chip into the pill row where it
          belongs (only when the account isn't already flagged Key
          Relationship — avoids the "two stars" audit finding). Primary
          CTA is "+ New deal" for direct action; Edit is a quieter
          secondary link. Everything wraps cleanly on mobile. */}
      <header>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal break-words">
              {account.company_name}
            </h1>
            {account.dba && (
              <p className="text-sm text-ppp-charcoal-500 mt-0.5">d/b/a {account.dba}</p>
            )}
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              {account.is_key_relationship && (
                <Pill tone="amber">★ Key Relationship</Pill>
              )}
              {!account.is_key_relationship && (overview?.won_opps_count ?? 0) > 0 && (
                <Pill tone="amber">★ Repeat customer</Pill>
              )}
              {account.rating && <Pill tone={ratingTone(account.rating)}>{account.rating}</Pill>}
              {account.industry && <Pill tone="neutral">{account.industry}</Pill>}
              {account.vendor_compliance_status && (
                <Pill tone={complianceTone(account.vendor_compliance_status)}>
                  {complianceLabel(account.vendor_compliance_status)}
                </Pill>
              )}
            </div>
            {primary && (
              <div className="mt-2.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px]">
                <span className="inline-flex items-center gap-1">
                  <span className="font-semibold text-ppp-charcoal">{primary.contact.full_name}</span>
                  <span className="text-ppp-charcoal-500">· {roleLabel(primary.role)}</span>
                </span>
                {primary.contact.email && (
                  <a
                    href={`mailto:${primary.contact.email}`}
                    className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 hover:underline underline-offset-2 min-h-[24px]"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" />
                    </svg>
                    Email
                  </a>
                )}
                {primary.contact.phone && (
                  <a
                    href={`tel:${primary.contact.phone.replace(/[^0-9+]/g, "")}`}
                    className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 hover:underline underline-offset-2 min-h-[24px]"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                    </svg>
                    Call
                  </a>
                )}
              </div>
            )}
          </div>
          {/* Primary CTA cluster — "+ New deal" is the visually loud
              action Alex will reach for most often (add another bid
              for this customer). Edit is a subtle ghost link — always
              reachable but doesn't compete for attention. */}
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <Link
              href={`/commercial/accounts/${account.id}?tab=deals&sub=opportunities&new_deal=1#new-deal`}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px]"
              title={`Log a new deal for ${account.company_name}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New deal
            </Link>
            <Link
              href={`/commercial/accounts/${account.id}/edit`}
              className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-ppp-charcoal-600 text-sm font-medium hover:bg-ppp-charcoal-50 active:bg-ppp-charcoal-100 transition-colors touch-manipulation min-h-[44px]"
              title="Edit account details"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            Edit
          </Link>
        </div>
        </div>
      </header>

      {/* Account 360 KPI strip — Karan 2026-06-14. One-glance summary of
          every count + last-activity tone. Blue tiles = live counts (Phase
          1). Grey tiles = "coming with Phase N" placeholders for the bid /
          invoiced / paid / balance numbers that fill in when later phases
          ship. The strip never changes shape — the data just gets richer. */}
      <AccountOverviewStrip overview={overview} invoiceRollup={invoiceRollup} accountId={account.id} />

      {/* Stage 3: Expiring-doc banner — appears between the KPI strip
          and the tab bar when ANY active doc on this account expires
          within 30 days OR has already expired. Driven by the existing
          commercial_account_overview_v view (no extra query). Click
          jumps to the Documents tab. Banner is amber for "expiring
          soon" + red for "already expired" so the urgency reads at a
          glance. */}
      <AccountComplianceBanner accountId={account.id} overview={overview} />

      {/* Primary tab bar — 4 groups. Consolidated from 9 flat tabs;
          Email tab removed entirely. Karan 2026-07-05. */}
      <nav className="relative border-b border-ppp-charcoal-100">
        <ul className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {PRIMARY_TABS.map((t) => {
            const active = t.key === primaryTab;
            return (
              <li key={t.key}>
                <Link
                  href={`/commercial/accounts/${id}?tab=${t.key}`}
                  className={`inline-flex items-center gap-1.5 px-4 sm:px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors touch-manipulation whitespace-nowrap min-h-[44px] ${
                    active
                      ? "border-cc-brand-600 text-ppp-charcoal"
                      : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-100"
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent sm:hidden" aria-hidden />
      </nav>

      {/* Sub-tab pill row — only when the primary has sub-tabs.
          Activity / Invoices / KPIs are single-view leaves with no sub-nav. */}
      {hasSubTabs && (
        <div className="flex flex-wrap items-center gap-1.5">
          {SUB_TABS_BY_PRIMARY[primaryTab as PrimaryWithSubs].map((s) => {
            const active = s.key === sub;
            return (
              <Link
                key={s.key}
                href={`/commercial/accounts/${id}?tab=${primaryTab}&sub=${s.key}`}
                className={`inline-flex items-center px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors touch-manipulation min-h-[36px] ${
                  active
                    ? "bg-cc-brand-50 text-cc-brand-700 border border-cc-brand-200"
                    : "bg-ppp-charcoal-50 text-ppp-charcoal-600 border border-transparent hover:bg-ppp-charcoal-100"
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </div>
      )}

      {/* Tab content — dispatches on the flat `tab` key. */}
      {tab === "info" && <InfoTab account={account} errorMessage={sp.error} />}
      {tab === "activity" && <ActivityTab accountId={account.id} />}
      {tab === "team" && <TeamTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "contacts" && <ContactsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "opportunities" && (
        <OpportunitiesTab
          accountId={account.id}
          overview={overview}
          openNewDeal={sp.new_deal === "1"}
          createdTitle={sp.created === "1" ? sp.created_title ?? null : null}
          focusDealId={
            typeof sp.deal === "string" && /^[0-9a-f-]{36}$/i.test(sp.deal)
              ? sp.deal
              : null
          }
          savedFlash={sp.saved === "1"}
          deletedFlash={typeof sp.deleted === "string" ? sp.deleted : null}
          errorMessage={sp.error}
        />
      )}
      {tab === "documents" && <DocumentsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "notes" && <NotesTab accountId={account.id} />}
      {tab === "performance" && <ComingSoonTab label="Performance" phase="next" />}
      {tab === "invoices" && (
        <AccountInvoicesTab
          accountId={account.id}
          rollup={invoiceRollup}
          paymentOk={sp.payment_ok === "1"}
          paymentCapped={sp.capped === "1"}
          paymentRequested={typeof sp.requested === "string" ? Number(sp.requested) || null : null}
          paymentApplied={typeof sp.applied === "string" ? Number(sp.applied) || null : null}
          errorMessage={sp.error}
        />
      )}
      {tab === "kpis" && <AccountKpisTab accountId={account.id} overview={overview} rollup={invoiceRollup} />}
    </div>
  );
}

/**
 * Quick-flip an opp's status straight from the account-side
 * Opportunities tab — Alex sees a bid mid-pipeline, picks the next
 * status from a dropdown on the row, one tap submits. Same DAG check
 * as the global page; terminal states (won/lost/no_bid) redirect to
 * the opp detail so the user can capture the required reason/note.
 */
async function quickFlipFromAccountAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  const to_status = String(formData.get("to_status") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!UUID_RE.test(opp_id)) redirect(`/commercial/accounts/${account_id}?tab=opportunities`);
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&error=${encodeURIComponent("Invalid status.")}`);
  }
  // Lost / No-bid need loss_reason capture — bounce to detail page.
  // Won flips immediately, drops the placeholder auto-note, then routes
  // to the opp page so the DebriefOnlyCard is right there for optional
  // structured-debrief follow-through.
  if (to_status === "lost" || to_status === "no_bid") {
    redirect(`/commercial/opportunities/${opp_id}?action=change-status&to=${to_status}`);
  }
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&error=${encodeURIComponent(result.error)}`);
  }
  if (to_status === "won") {
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({ opportunityId: opp_id, outcome: "won", actorUserId: user.id });
    redirect(`/commercial/opportunities/${opp_id}?tab=debrief&just_closed=1`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=opportunities`);
}

/** Karan 2026-07-08 — inline "+ New deal" server action for the Account
 *  Pipeline sub-tab. Retires the full-page /commercial/opportunities/new
 *  form in favor of a collapsible-based inline flow (mirrors the invoice
 *  inline create pattern). Title + status + source + bid range + due date
 *  cover 95% of new-deal entries; property + long description are behind
 *  progressive-disclosure "More details" on the client. */
async function createDealInlineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");

  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&new_deal=1&error=${encodeURIComponent("Deal title is required.")}`);
  }

  const statusRaw = String(formData.get("status") ?? "inquiry").trim();
  const status = (OPPORTUNITY_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as OpportunityStatus)
    : "inquiry";

  const sourceRaw = String(formData.get("source") ?? "").trim();
  const source = (OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as (typeof OPPORTUNITY_SOURCES)[number])
    : null;

  const bidLowRaw = String(formData.get("bid_low") ?? "").trim();
  const bidHighRaw = String(formData.get("bid_high") ?? "").trim();
  const bid_value_low_cents = bidLowRaw ? parseDollarsToCents(bidLowRaw) : null;
  const bid_value_high_cents = bidHighRaw ? parseDollarsToCents(bidHighRaw) : null;

  const proposalDueRaw = String(formData.get("proposal_due_at") ?? "").trim();
  const proposal_due_at = proposalDueRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposalDueRaw)
    ? `${proposalDueRaw}T16:00:00.000Z`
    : null;

  const description = String(formData.get("description") ?? "").trim() || null;
  const property_street = String(formData.get("property_street") ?? "").trim() || null;
  const property_city = String(formData.get("property_city") ?? "").trim() || null;
  const property_state = String(formData.get("property_state") ?? "").trim() || null;
  const property_zip = String(formData.get("property_zip") ?? "").trim() || null;

  // Karan 2026-07-08: capture proposed_start / proposed_end / probability
  // override on create so the user doesn't have to bounce through the
  // Edit form after logging a deal that already has a signed schedule.
  const proposedStartRaw = String(formData.get("proposed_start_at") ?? "").trim();
  const proposed_start_at = proposedStartRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedStartRaw)
    ? `${proposedStartRaw}T09:00:00.000Z`
    : null;
  const proposedEndRaw = String(formData.get("proposed_end_at") ?? "").trim();
  const proposed_end_at = proposedEndRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedEndRaw)
    ? `${proposedEndRaw}T17:00:00.000Z`
    : null;
  const probRaw = String(formData.get("probability_pct") ?? "").trim();
  const probParsed = probRaw ? Number(probRaw) : NaN;
  const probability_pct = Number.isFinite(probParsed) && probParsed >= 0 && probParsed <= 100
    ? Math.round(probParsed)
    : null;

  const result = await createCommercialOpportunity({
    account_id,
    title,
    status,
    source,
    bid_value_low_cents,
    bid_value_high_cents,
    proposal_due_at,
    proposed_start_at,
    proposed_end_at,
    probability_pct,
    description,
    property_street,
    property_city,
    property_state,
    property_zip,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&new_deal=1&error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  const createdTitle = encodeURIComponent(result.opportunity.title);
  redirect(`/commercial/accounts/${account_id}?tab=opportunities&created=1&created_title=${createdTitle}#deal-${result.opportunity.id}`);
}

/**
 * Karan 2026-07-08: soft-delete a deal from the account-page drill-in.
 * Cross-account defense: the mutation lib re-fetches by id, but we
 * validate the account_id in the redirect target so a malicious form
 * post can't smuggle a redirect to a different customer's page.
 */
async function deleteDealFromAccountAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  const confirm = formData.get("confirm") === "yes";
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!UUID_RE.test(opp_id)) redirect(`/commercial/accounts/${account_id}?tab=opportunities`);
  if (!confirm) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&deal=${opp_id}&error=${encodeURIComponent("Confirmation required to delete.")}#deal-${opp_id}`);
  }
  // Peek the title BEFORE deleting so we can surface it in the toast.
  // Lazy import to keep the top-of-module bundle lean (this action fires
  // once per manual delete, not on every account-page render).
  const { commercialDb: _cdb } = await import("@/lib/commercial/db");
  const sb = _cdb();
  const { data: pre } = await sb
    .from("commercial_opportunities")
    .select("title, account_id")
    .eq("id", opp_id)
    .eq("account_id", account_id)
    .maybeSingle();
  if (!pre) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&error=${encodeURIComponent("Deal not found on this account.")}`);
  }
  const title = ((pre as { title?: string }).title || "Deal");
  const result = await softDeleteCommercialOpportunity(opp_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&deal=${opp_id}&error=${encodeURIComponent(result.error)}#deal-${opp_id}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  redirect(`/commercial/accounts/${account_id}?tab=opportunities&deleted=${encodeURIComponent(title)}`);
}

/**
 * Karan 2026-07-08: inline "Record payment" for the Invoices tab.
 * Per user "let me do quick actions straight onto this page just like
 * adding a payment to a specific invoice but everything else they can
 * do on the invoice page by click on the actual invoice". Everything
 * except the payment record still routes to the full invoice page.
 *
 * The addPayment lib is the same one the invoice detail page uses so
 * the state machine (draft → partial → paid) fires identically and the
 * account's Financial Snapshot rolls up on the very next render.
 */
async function recordPaymentInlineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const account_id = String(formData.get("account_id") ?? "");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const returnUrl = `/commercial/accounts/${account_id}?tab=invoices`;
  if (!UUID_RE.test(invoice_id)) redirect(`${returnUrl}&error=${encodeURIComponent("Invalid invoice.")}`);
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const cents = parseDollarsToCents(amountRaw);
  if (cents === null || cents <= 0) {
    redirect(`${returnUrl}&error=${encodeURIComponent("Enter a positive dollar amount.")}#inv-${invoice_id}`);
  }
  const paidAtRaw = String(formData.get("paid_at") ?? "").trim();
  const paid_at = paidAtRaw && /^\d{4}-\d{2}-\d{2}$/.test(paidAtRaw)
    ? `${paidAtRaw}T12:00:00.000Z`
    : new Date().toISOString();
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const result = await addPayment(invoice_id, {
    amount_cents: cents,
    paid_at,
    method,
    reference,
    notes: null,
    recorded_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`${returnUrl}&error=${encodeURIComponent(result.error ?? "Failed to record payment.")}#inv-${invoice_id}`);
  }
  // Same revalidations the invoice-detail action fires — every surface
  // that surfaces this invoice or its parent account's rollup refreshes.
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath(`/commercial/invoices/${invoice_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial");
  const cappedMsg = result.capped ? `&capped=1&requested=${cents}&applied=${result.applied_cents ?? cents}` : "";
  redirect(`${returnUrl}&payment_ok=1${cappedMsg}#inv-${invoice_id}`);
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
  // Recent Activity moved out of InfoTab → its own tab 2026-06-24.
  // InfoTab stays focused on identity + tags + compliance — no chronological
  // feed that competed with the rest of the layout for vertical space.
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

/** Recent Activity card — chronological feed of opp events for this
 *  account. Quiet when the account has no opps or no events yet. */
function RecentActivityCard({
  entries,
  className,
}: {
  entries: import("@/lib/commercial/accounts/recent-activity").AccountActivityEntry[];
  className?: string;
}) {
  if (entries.length === 0) {
    // Hide entirely on quiet accounts — better than rendering a blank
    // card. The Opportunities tab + KPI strip already communicate
    // "nothing happening here."
    return null;
  }
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden ${className ?? ""}`}>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ppp-charcoal">Recent activity</h2>
        <span className="text-[11px] text-ppp-charcoal-500">
          Across {entries.length === 1 ? "this deal" : "this account's deals"}
        </span>
      </div>
      <ol className="divide-y divide-ppp-charcoal-100">
        {entries.map((entry) => {
          const when = new Date(entry.occurred_at);
          const iconCls =
            entry.kind === "status_change"
              ? "bg-blue-100 text-blue-700"
              : entry.kind === "task_completed"
              ? "bg-blue-100 text-blue-700"
              : "bg-ppp-charcoal-100 text-ppp-charcoal-700";
          const icon =
            entry.kind === "status_change" ? "→" : entry.kind === "task_completed" ? "✓" : "📝";
          return (
            <li key={entry.id} className="px-4 py-3 flex items-start gap-3">
              <span
                className={`flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-semibold ${iconCls}`}
                aria-hidden
              >
                {icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ppp-charcoal flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{describeActivity(entry)}</span>
                  <span className="text-ppp-charcoal-400">on</span>
                  <Link
                    href={`/commercial/opportunities/${entry.opportunity_id}`}
                    className="text-blue-700 hover:text-blue-800 underline break-words"
                  >
                    {entry.opportunity_title || "(untitled)"}
                  </Link>
                </div>
                {entry.excerpt && (
                  <p className="text-[12px] text-ppp-charcoal-700 mt-1 leading-relaxed">
                    {entry.excerpt}
                  </p>
                )}
                <div
                  className="text-[11px] text-ppp-charcoal-500 mt-1"
                  title={when.toISOString()}
                >
                  {when.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                  {" · "}
                  {when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
                  {" ET"}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Dedicated Activity tab — separates the chronological feed from the
 *  Info tab so neither competes for vertical space. Pulls 50 entries
 *  (vs 10 on the old inline card) since this surface is BUILT for
 *  scrolling. Empty state explains where activity comes from. */
async function ActivityTab({ accountId }: { accountId: string }) {
  const activity = await getAccountRecentActivity(accountId, 50);
  if (activity.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
        <div className="text-sm font-semibold text-ppp-charcoal mb-1">No activity yet</div>
        <p className="text-[12px] text-ppp-charcoal-500 max-w-md mx-auto leading-relaxed">
          Status changes, notes, and completed tasks on this account&apos;s deals show up here as a chronological feed.
        </p>
      </div>
    );
  }
  return <RecentActivityCard entries={activity} />;
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
          className="text-[12px] text-blue-700 hover:text-blue-800 underline shrink-0"
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
        <p className="mt-3 text-[12px] text-blue-700">All required docs on file and valid.</p>
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
        dot: "bg-blue-500",
        label: item.expires_at
          ? `${item.days_until ?? 0}d left`
          : "On file",
        tone: "text-blue-700",
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
        Compliance deadlines, most urgent first. Past-due items stay
        on the list until the doc is replaced.
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
              ? dt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })
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
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium border bg-blue-50 text-blue-700 border-blue-200"
            >
              {t.tag}
              <form action={removeTagAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="tag_id" value={t.id} />
                <button
                  type="submit"
                  aria-label={`Remove ${t.tag}`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-blue-700/60 hover:text-blue-900 touch-manipulation"
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
            className={INPUT_CLS}
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
          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] shrink-0"
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
  const result = await touchContact(account_id, account_contact_id, user.id);
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
  if (!UUID_RE.test(account_id) || !UUID_RE.test(account_contact_id)) {
    redirect("/commercial/accounts");
  }
  // Security fix 2026-06-24: pass account_id for cross-account scoping
  // — see lib/commercial/accounts/contacts.ts detachContactFromAccount.
  await detachContactFromAccount(account_id, account_contact_id, user.id);
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
              className="w-full sm:w-auto px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 bg-white"
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
              className={INPUT_CLS}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
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
            <a href={`mailto:${contact.email}`} className="text-blue-700 hover:text-blue-800 break-all">
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
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200"
              title={a.notes ?? undefined}
            >
              {roleLabel(a.role)}
              <form action={detachContactAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="account_contact_id" value={a.account_contact_id} />
                <button
                  type="submit"
                  aria-label={`Remove ${roleLabel(a.role)} role`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-blue-700/80 hover:text-blue-900 touch-manipulation"
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
                className="text-[11px] text-ppp-charcoal-500 hover:text-amber-700 underline underline-offset-2 touch-manipulation min-h-[44px] px-1 inline-flex items-center"
              >
                {primaryAttachment ? "Unstar primary" : "Mark as primary"}
              </button>
            </form>
            <form action={touchContactAction} className="inline">
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="account_contact_id" value={attachments[0].account_contact_id} />
              <button
                type="submit"
                className="text-[11px] text-ppp-charcoal-500 hover:text-blue-700 underline underline-offset-2 touch-manipulation min-h-[44px] px-1 inline-flex items-center"
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
        className={INPUT_CLS}
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
  // Security fix 2026-06-24: pass account_id so the lib double-scopes
  // the row + the update. Without this, a hand-crafted POST with a
  // foreign assignment_id could soft-delete a row from a different account.
  await removeAssignment(account_id, assignment_id, user.id);
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
      <section id="assign-ppp-staff" className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 scroll-mt-24">
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
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
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
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
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
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30" />
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
              className={INPUT_CLS}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
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
        <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
          <span>What do the symbols mean?</span>
          <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
        </summary>
        <ul className="px-4 py-3 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-700 space-y-1.5">
          <li>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-600 text-white border-blue-700 mr-1">
              ★ Sales Rep
            </span>
            Primary holder of this role — the &ldquo;THE&rdquo; person platform-wide. One per (account, role).
          </li>
          <li>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200 mr-1">
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
          <a
            href="#assign-ppp-staff"
            className="inline-flex items-center gap-1.5 mt-4 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            Add a team member
          </a>
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              {team.length} team member{team.length === 1 ? "" : "s"}
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
          className="text-[11px] text-blue-700 hover:text-blue-800 break-all"
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
                  ? "bg-cc-brand-600 text-white border-blue-700"
                  : "bg-blue-50 text-blue-700 border-blue-200"
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
                  className={`-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center touch-manipulation ${a.is_primary ? "text-white/80 hover:text-white" : "text-blue-700/80 hover:text-blue-900"}`}
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
  // Security fix 2026-06-24: pass account_id so the lib double-scopes
  // the lookup + update against cross-account hand-crafted POSTs.
  const result = await archiveDocument(account_id, document_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=documents&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=documents`);
}

async function restoreDocumentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  const document_id = String(formData.get("document_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(document_id)) {
    redirect("/commercial/accounts");
  }
  // Security fix 2026-06-24: pass account_id — restoreDocument is the
  // worst of the doc paths (mutates the active version), so cross-account
  // scoping here is critical.
  const result = await restoreDocument(account_id, document_id, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=documents&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=documents`);
}

/**
 * Account-side Opportunities tab. Every bid PPP has ever pitched this
 * customer — open at the top in a "Open · N" section, decided history
 * below in a "Decided · N" section if any exist.
 *
 * Bulk-fetches all 5 row-signal Maps in parallel so the tab renders in
 * one round-trip regardless of opp count (same pattern as the global
 * /commercial/opportunities list page).
 *
 * Empty state surfaces a + New Opportunity CTA deep-linked to the new
 * form with the account pre-selected (`?account=<uuid>`).
 */
/** Inline "+ New deal" form — Karan 2026-07-08. Shared between the
 *  empty state (renders bare) and the header collapsible (renders inside
 *  a <details>). Two required rows visible immediately (title, status)
 *  plus optional bid/due/source. Property + description behind a
 *  progressive-disclosure <details>. Zero page jumps. */
function NewDealForm({ accountId }: { accountId: string }) {
  const inputCls =
    "w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[40px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30";
  const labelCls = "block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5";
  return (
    <form action={createDealInlineAction} className="space-y-3">
      <input type="hidden" name="account_id" value={accountId} />
      <div>
        <label className={labelCls} htmlFor="deal-title">Deal title</label>
        <input
          id="deal-title"
          type="text"
          name="title"
          required
          maxLength={200}
          placeholder="e.g. Lobby + Halls Repaint — Q3 Bid"
          className={inputCls}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Status</span>
          <select
            name="status"
            defaultValue="inquiry"
            className={`${inputCls} bg-white`}
          >
            {OPPORTUNITY_STATUSES.filter((s) => s !== "reopened").map((s) => (
              <option key={s} value={s}>{opportunityStatusLabel(s)}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Source</span>
          <select
            name="source"
            defaultValue=""
            className={`${inputCls} bg-white`}
          >
            <option value="">— select —</option>
            {OPPORTUNITY_SOURCES.map((s) => (
              <option key={s} value={s}>{opportunitySourceLabel(s)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={labelCls}>Bid low</span>
          <input
            type="text"
            inputMode="decimal"
            name="bid_low"
            placeholder="0.00"
            className={`${inputCls} tabular-nums`}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Bid high</span>
          <input
            type="text"
            inputMode="decimal"
            name="bid_high"
            placeholder="0.00"
            className={`${inputCls} tabular-nums`}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Proposal due</span>
          <input
            type="date"
            name="proposal_due_at"
            className={inputCls}
          />
        </label>
      </div>
      <details className="group/more">
        <summary className="list-none cursor-pointer text-[11.5px] font-medium text-blue-700 hover:text-blue-900 min-h-[28px] flex items-center gap-1.5 select-none">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open/more:rotate-90" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
          More details (schedule, probability, description, address)
        </summary>
        <div className="mt-2 space-y-3">
          {/* Karan 2026-07-08: expanded per user "it should ask me all
              these questions when i'm making a new deal because it
              doesnt right now". Captures probability override,
              proposed start/end, description, project address at
              create time so users don't have to bounce through Edit. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block">
              <span className={labelCls}>Probability %</span>
              <input
                type="number"
                name="probability_pct"
                min={0}
                max={100}
                step={1}
                placeholder="auto"
                className={`${inputCls} tabular-nums`}
              />
              <span className="block text-[10px] text-ppp-charcoal-400 mt-0.5">Leave blank → default from status</span>
            </label>
            <label className="block">
              <span className={labelCls}>Proposed start</span>
              <input
                type="date"
                name="proposed_start_at"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Proposed end</span>
              <input
                type="date"
                name="proposed_end_at"
                className={inputCls}
              />
            </label>
          </div>
          <label className="block">
            <span className={labelCls}>Description</span>
            <textarea
              name="description"
              rows={2}
              maxLength={1000}
              placeholder="e.g. Scope: repaint 3-story lobby + 4 corridors. Existing latex, no lead."
              className={`${inputCls} min-h-[60px]`}
            />
          </label>
          <div>
            <div className={labelCls}>Project address <span className="font-normal text-ppp-charcoal-400">(if different from the account address)</span></div>
            <input
              type="text"
              name="property_street"
              maxLength={200}
              placeholder="Street"
              className={inputCls}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
              <input type="text" name="property_city" maxLength={80} placeholder="City" className={inputCls} />
              <input type="text" name="property_state" maxLength={2} placeholder="State" className={inputCls} />
              <input type="text" name="property_zip" maxLength={10} placeholder="ZIP" className={inputCls} />
            </div>
          </div>
        </div>
      </details>
      <div className="flex justify-end pt-1">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40"
        >
          Create deal
        </button>
      </div>
    </form>
  );
}

async function OpportunitiesTab({
  accountId,
  overview,
  openNewDeal,
  createdTitle,
  focusDealId,
  savedFlash,
  deletedFlash,
  errorMessage,
}: {
  accountId: string;
  overview: AccountOverview | null;
  openNewDeal?: boolean;
  createdTitle?: string | null;
  /** When set, expand a per-deal drill-in section at the top of the tab.
   *  Loaded from `?deal=<uuid>` on the URL — set by edit/save redirects,
   *  by the pipeline sheet's deep-links, and by the deprecated deal-detail
   *  page's shim redirect. Cross-account access blocked by the
   *  account_id-scoped fetch below (the deal only expands when it belongs
   *  to `accountId`; a mismatched pair silently ignores the param). */
  focusDealId?: string | null;
  savedFlash?: boolean;
  deletedFlash?: string | null;
  errorMessage?: string;
}) {
  const all = await listCommercialOpportunities({ accountId });
  const ids = all.map((o) => o.id);

  // Bulk-fetch every row signal in parallel — keeps the tab a single
  // batch query regardless of opp count.
  const [statusEnteredMap, taskStatsMap, lastNoteMap, primaryLeadMap, attachmentMap, submittalMap, finishMap] = await Promise.all([
    listCurrentStatusEnteredAtByOpp(ids),
    listOpenTaskStatsByOpp(ids),
    listLastNoteByOpp(ids),
    listPrimaryLeadByOpp(ids),
    listAttachmentCountByOpp(ids),
    listSubmittalCountByOpp(ids),
    listFinishCountByOpp(ids),
  ]);

  const open = all.filter((o) => OPEN_OPP_STATUSES.includes(o.status));
  const decided = all.filter((o) => TERMINAL_STATUSES.has(o.status));

  // Karan 2026-07-08: empty state now renders the SAME inline "+ New
  // deal" form open by default. Zero clicks between landing on the tab
  // and filling in the first field. No jumping to a separate page.
  if (all.length === 0) {
    return (
      <div className="space-y-3">
        {errorMessage && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800">
            {errorMessage}
          </div>
        )}
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
          <div className="flex items-start gap-3 mb-4">
            <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-cc-brand-100 text-cc-brand-700 shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="6" />
                <circle cx="12" cy="12" r="2" />
              </svg>
            </span>
            <div>
              <div className="text-sm font-bold text-ppp-charcoal">Start the first bid</div>
              <p className="text-[12.5px] text-ppp-charcoal-500 leading-relaxed mt-0.5">
                Title is the minimum — add bid range + due date when you have them.
              </p>
            </div>
          </div>
          <NewDealForm accountId={accountId} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Karan 2026-07-08: header-strip "+ New opportunity" Link →
          inline "+ New deal" collapsible. Same activity summary; the
          CTA is now a native <details> that expands the form right
          here instead of jumping to a full-page form. Auto-opens when
          the URL has ?new_deal=1 (set by the retired
          /commercial/opportunities/new redirect shim). */}
      {createdTitle && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-800 flex items-start justify-between gap-3">
          <span>
            <strong>{decodeURIComponent(createdTitle)}</strong> logged.
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {savedFlash && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden>✓</span>
            <span>Changes saved.</span>
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {deletedFlash && (
        <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-start justify-between gap-3">
          <span>
            <strong className="text-ppp-charcoal">{decodeURIComponent(deletedFlash)}</strong> deleted. Soft-delete — restorable by admin from the audit log.
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
          <span>{errorMessage}</span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {/* Karan 2026-07-08 rewrite: primary "+ New deal" CTA is now a
          proper red-accent card (matches the pipeline "New deal" +
          "New account" CTAs on the list pages). Reads as the primary
          action, not a nested collapsible chevron. When open exists the
          card stays collapsed; when it's the customer's only next move
          it opens by default with a "Start the next bid" label change. */}
      {/* Karan 2026-07-08: per-deal drill-in section. Renders when the
          URL carries ?deal=<uuid> AND the deal actually belongs to this
          account (cross-account defense — `all` is already filtered by
          accountId at the top of the tab). Full deal detail lives here
          under a collapsible header with Edit + Delete + status flip
          actions so users never leave the account page for routine
          deal management. Auto-scrolled to via #deal-<id>. */}
      {focusDealId && (() => {
        const dealRow = all.find((d) => d.id === focusDealId);
        if (!dealRow) return null;
        return (
          <DealDrillIn
            deal={dealRow}
            accountId={accountId}
            statusEnteredAt={statusEnteredMap.get(dealRow.id) ?? null}
            taskStats={taskStatsMap.get(dealRow.id) ?? null}
            primaryLead={primaryLeadMap.get(dealRow.id) ?? null}
            fileCount={attachmentMap.get(dealRow.id) ?? 0}
            submittalStats={submittalMap.get(dealRow.id) ?? null}
            finishCount={finishMap.get(dealRow.id) ?? 0}
          />
        );
      })()}

      <details
        open={openNewDeal || open.length === 0}
        className="group/newdeal bg-white border border-cc-brand-200 rounded-xl overflow-hidden shadow-sm shadow-cc-brand-100/40"
      >
        <summary
          id="new-deal"
          className="list-none cursor-pointer flex items-center justify-between gap-3 px-4 py-3.5 min-h-[52px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 hover:bg-cc-brand-50/40"
        >
          <span className="inline-flex items-center gap-2.5">
            <span aria-hidden className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cc-brand-100 text-cc-brand-700 shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
            </span>
            <span className="flex flex-col">
              <span className="text-[14px] font-bold text-cc-brand-700 leading-tight">
                {open.length === 0 && decided.length > 0
                  ? "Start the next bid"
                  : "New deal for this customer"}
              </span>
              <span className="text-[11px] text-ppp-charcoal-500 leading-tight mt-0.5">
                {open.length === 0 && decided.length > 0
                  ? "Log the next opportunity — repeat customer, warm lead."
                  : "Title + bid range gets you moving; details later."}
              </span>
            </span>
          </span>
          <span aria-hidden className="text-cc-brand-500 transition-transform group-open/newdeal:rotate-180 shrink-0">▾</span>
        </summary>
        <div className="p-4 border-t border-cc-brand-100 bg-cc-brand-50/20">
          <NewDealForm accountId={accountId} />
        </div>
      </details>

      {open.length > 0 && (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ppp-charcoal">
              Open · {open.length}
            </h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {open.map((opp) => (
              <AccountOpportunityRow
                key={opp.id}
                opp={opp}
                accountId={accountId}
                statusEnteredAt={statusEnteredMap.get(opp.id) ?? null}
                taskStats={taskStatsMap.get(opp.id) ?? null}
                lastNote={lastNoteMap.get(opp.id) ?? null}
                primaryLead={primaryLeadMap.get(opp.id) ?? null}
                fileCount={attachmentMap.get(opp.id) ?? 0}
                submittalStats={submittalMap.get(opp.id) ?? null}
                finishCount={finishMap.get(opp.id) ?? 0}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Karan 2026-07-08 Batch 2: Decided section is collapsed by
          default when there are open deals — closed history is
          reference-only, not the primary read. Expanded by default when
          this is the customer's only deal history (no open bids), since
          then it IS the read. */}
      {decided.length > 0 && (
        <details
          open={open.length === 0}
          className="group/decided bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden"
        >
          <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] hover:bg-ppp-charcoal-50/60 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300/40">
            <h2 className="text-sm font-semibold text-ppp-charcoal-700">
              Decided · {decided.length}
            </h2>
            <span aria-hidden className="text-ppp-charcoal-400 transition-transform group-open/decided:rotate-180">▾</span>
          </summary>
          <ul className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
            {decided.map((opp) => (
              <AccountOpportunityRow
                key={opp.id}
                opp={opp}
                accountId={accountId}
                statusEnteredAt={statusEnteredMap.get(opp.id) ?? null}
                taskStats={taskStatsMap.get(opp.id) ?? null}
                lastNote={lastNoteMap.get(opp.id) ?? null}
                primaryLead={primaryLeadMap.get(opp.id) ?? null}
                fileCount={attachmentMap.get(opp.id) ?? 0}
                submittalStats={submittalMap.get(opp.id) ?? null}
                finishCount={finishMap.get(opp.id) ?? 0}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Account-context opp row. Trims the global pipeline row's signals down
 * since we're already filtered to one account: skip the account name +
 * source columns; keep status / bid / probability / days-in-status /
 * primary lead / task chip / file count / last note.
 */
function AccountOpportunityRow({
  opp,
  accountId,
  statusEnteredAt,
  taskStats,
  lastNote,
  primaryLead,
  fileCount,
  submittalStats,
  finishCount,
}: {
  opp: CommercialOpportunity;
  accountId: string;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  lastNote: { created_at: string; author_label: string | null } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
}) {
  const statusInfo = statusPillTone(opp.status);
  const daysInStatus = daysSinceIso(statusEnteredAt);
  const daysTone =
    daysInStatus === null
      ? "text-ppp-charcoal-500"
      : daysInStatus > 14
      ? "text-rose-700"
      : daysInStatus > 7
      ? "text-amber-700"
      : "text-blue-700";
  // First name from "Sarah Connor" → "Sarah". Falls back to the local
  // part of the email when no full name is set.
  const leadLabel = primaryLead
    ? (primaryLead.user_full_name?.split(" ")[0] ?? primaryLead.user_email.split("@")[0])
    : null;
  // DAG-filtered next statuses for inline quick-flip. Empty list →
  // dropdown hides (terminal states have no forward motion; reopened
  // is the only legal exit and that's handled on the detail page).
  const nextStatuses = allowedNextStatuses(opp.status);
  const isTerminal = TERMINAL_STATUSES.has(opp.status);
  const bidLabel = formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents);
  return (
    <li>
      {/* Karan 2026-07-08 rewrite: cleaner 2-line hierarchy.
          Line 1: [title] [status pill]
          Line 2: [bid] · [probability]  (compact, muted)
          Signal row (line 3, only when there's something to say): overdue tasks,
          submittals awaiting, primary lead, days-stuck. No cluttered 6-chip soup
          on every row — the empty state is quiet. */}
      <Link
        href={`/commercial/opportunities/${opp.id}`}
        className="block px-4 py-3 hover:bg-ppp-charcoal-50 transition-colors min-h-[44px] touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[14px] font-semibold text-ppp-charcoal break-words leading-snug">
                {opp.title || "(untitled)"}
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border shrink-0 ${statusInfo.cls}`}
              >
                {opportunityStatusLabel(opp.status)}
              </span>
            </div>
            <div className="mt-1 text-[12.5px] text-ppp-charcoal-600 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              <span className="font-semibold text-ppp-charcoal-800">
                {bidLabel !== "—" ? bidLabel : "No bid set"}
              </span>
              {!isTerminal && (
                <>
                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                  <span className="text-ppp-charcoal-500">
                    {opp.probability_pct}% likely
                  </span>
                </>
              )}
              {isTerminal && daysInStatus !== null && (
                <>
                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                  <span className="text-ppp-charcoal-500">
                    {daysInStatus === 0 ? "closed today" : daysInStatus === 1 ? "closed yesterday" : `closed ${daysInStatus}d ago`}
                  </span>
                </>
              )}
            </div>
            {/* Signal row — only renders when there's a signal to show.
                No overwhelming chip soup on every row; the eye lands on
                titles first. Order: urgent (overdue) → primary lead →
                stuck-days → docs summary. */}
            {(
              (taskStats && (taskStats.overdue > 0 || taskStats.open > 0)) ||
              (submittalStats && submittalStats.awaiting_response > 0) ||
              leadLabel ||
              (!isTerminal && daysInStatus !== null && daysInStatus > 7) ||
              lastNote
            ) && (
              <div className="mt-1.5 text-[11.5px] flex items-center gap-x-3 gap-y-0.5 flex-wrap text-ppp-charcoal-500">
                {taskStats && taskStats.overdue > 0 && (
                  <span className="text-rose-700 font-medium">
                    <span aria-hidden>⚠</span> {taskStats.overdue} overdue task{taskStats.overdue === 1 ? "" : "s"}
                  </span>
                )}
                {submittalStats && submittalStats.awaiting_response > 0 && (
                  <span className="text-sky-700 font-medium">
                    <span aria-hidden>📋</span> {submittalStats.awaiting_response} awaiting GC
                  </span>
                )}
                {leadLabel && (
                  <span>
                    <span aria-hidden>★</span> {leadLabel} lead
                  </span>
                )}
                {!isTerminal && daysInStatus !== null && daysInStatus > 7 && (
                  <span className={daysTone}>
                    {daysInStatus}d in stage
                  </span>
                )}
                {lastNote && (
                  <span className="truncate max-w-[180px]">
                    Last note {relativeActivity(lastNote.created_at)}
                  </span>
                )}
              </div>
            )}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 shrink-0 mt-1" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>
      {/* Karan 2026-07-08 Batch 2: dropped the "QUICK FLIP" caps label —
          the placeholder text inside the select tells the same story
          without shouting. Terminal states still route to detail for
          loss_reason + note capture. */}
      {nextStatuses.length > 0 && (
        <form
          action={quickFlipFromAccountAction}
          className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap"
        >
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="opp_id" value={opp.id} />
          <select
            id={`account-flip-${opp.id}`}
            name="to_status"
            defaultValue=""
            required
            aria-label={`Move ${opp.title} to next stage`}
            className={`${SELECT_CLS} text-base sm:text-sm py-1.5 min-h-[36px]`}
            style={SELECT_BG_STYLE}
          >
            <option value="" disabled>
              Move to…
            </option>
            {nextStatuses.map((s) => {
              const isTerminal = isTerminalOpportunityStatus(s);
              return (
                <option key={s} value={s}>
                  {isTerminal ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                </option>
              );
            })}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-ppp-charcoal-700 text-white hover:bg-ppp-charcoal-800 min-h-[36px] touch-manipulation"
          >
            Go
          </button>
        </form>
      )}
    </li>
  );
}

/** Status pill color tone — mirrors the global pipeline page. */
function statusPillTone(status: OpportunityStatus): { cls: string } {
  if (status === "won") return { cls: "bg-emerald-50 text-emerald-800 border-emerald-200" };
  if (status === "lost" || status === "no_bid") return { cls: "bg-rose-50 text-rose-800 border-rose-200" };
  if (status === "on_hold") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "negotiating" || status === "proposal_sent") return { cls: "bg-blue-50 text-blue-800 border-blue-200" };
  if (status === "reopened") return { cls: "bg-purple-50 text-purple-800 border-purple-200" };
  return { cls: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100" };
}

async function DocumentsTab({ accountId, errorMessage }: { accountId: string; errorMessage?: string }) {
  // Use the uploader-enriched variant so each row can show "Uploaded by
  // Alice · Jun 12" + "Archived by Bob · Jun 18". One extra profile
  // query in the lib; same row shape otherwise.
  const grouped = await listAccountDocumentsWithUploaders(accountId);
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
        <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
          <span>What do the badges mean?</span>
          <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
        </summary>
        <ul className="px-4 py-3 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-700 space-y-1.5">
          <li>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200 mr-1">
              v3
            </span>
            Active version. Highest version number wins. Older versions stack into &ldquo;History&rdquo;.
          </li>
          <li>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-100 text-blue-800 border-blue-200 mr-1">
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

type DocWithNames = CommercialAccountDocument & {
  uploader_name: string | null;
  archiver_name: string | null;
};

function DocumentCategoryCard({
  group,
  accountId,
}: {
  group: { category: DocumentCategory; active: DocWithNames | null; history: DocWithNames[] };
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
          <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none min-h-[44px] touch-manipulation flex items-center">
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
  doc: DocWithNames;
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
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200">
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
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-blue-50 text-blue-700 border-blue-200">
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
          className="text-sm font-medium text-blue-700 hover:text-blue-800 break-all"
        >
          {doc.file_name}
        </a>
        {/* Condensed audit trail — uploaded date + uploader on top line,
            expiry + archived-by on a second line ONLY when present. The
            previous flex-wrap version wrapped into 4+ ugly lines at 375px
            when names were long. Use short month + 2-digit year so the
            line holds even on tight mobile widths. */}
        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 leading-snug">
          <div>
            {sizeLabel && <>{sizeLabel} · </>}
            Uploaded {new Date(doc.uploaded_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "America/New_York" })}
            {doc.uploader_name && <> by <strong className="text-ppp-charcoal-700">{doc.uploader_name}</strong></>}
          </div>
          {(doc.expires_at || (!isActive && doc.archived_at)) && (
            <div className="text-ppp-charcoal-400 mt-0.5">
              {doc.expires_at && (
                <>Expires {new Date(doc.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "America/New_York" })}</>
              )}
              {doc.expires_at && !isActive && doc.archived_at && " · "}
              {!isActive && doc.archived_at && (
                <>Archived {new Date(doc.archived_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "America/New_York" })}
                {doc.archiver_name && <> by {doc.archiver_name}</>}</>
              )}
            </div>
          )}
        </div>
        {doc.notes && (
          <p className="text-[11px] text-ppp-charcoal-600 italic mt-1">{doc.notes}</p>
        )}
      </div>
      {!isActive && doc.archived && (
        <form action={restoreDocumentAction} className="shrink-0 w-full sm:w-auto">
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="document_id" value={doc.id} />
          <button
            type="submit"
            className="w-full sm:w-auto px-3 py-2 text-[12px] font-medium text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50 min-h-[44px] touch-manipulation whitespace-nowrap"
            title="Make this the active version. Adds a new entry to the chain so the audit trail stays intact."
          >
            Restore as active
          </button>
        </form>
      )}
      {isActive && !doc.archived && (
        <form action={archiveDocumentAction} className="shrink-0 w-full sm:w-auto">
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="document_id" value={doc.id} />
          <button
            type="submit"
            className="w-full sm:w-auto px-3 py-2 text-[12px] font-medium text-ppp-charcoal-700 border border-ppp-charcoal-100 rounded-lg hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation whitespace-nowrap"
            title="Archive without replacement. File stays downloadable in History."
          >
            Archive
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Notes tab — surfaces commercial_account_notes for this account.
 * Two visual treatments:
 *   - user notes: standard white card with author + timestamp
 *   - auto_debrief notes: slate-tinted card with [AUTO] badge + "View opportunity" link
 *
 * Auto-debrief notes land here automatically when a linked opportunity
 * is closed (won/lost/no_bid) via the Win/Loss Debrief flow. Two-stage
 * post: a placeholder lands immediately on status change, enriches
 * in-place when the structured debrief is submitted.
 */
async function NotesTab({ accountId }: { accountId: string }) {
  const { listAccountNotes } = await import("@/lib/commercial/account-notes");
  const notes = await listAccountNotes(accountId);

  if (notes.length === 0) {
    return (
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
        <strong className="block text-ppp-charcoal">No notes yet</strong>
        <p className="mt-1">
          When opportunities for this account close (won/lost/no-bid), the
          debrief auto-posts here. Manual notes coming next.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notes.map((n) => {
        const isAuto = n.kind === "auto_debrief";
        return (
          <article
            key={n.id}
            className={`rounded-xl border p-4 sm:p-5 ${
              isAuto
                ? "bg-slate-50/60 border-slate-200"
                : "bg-white border-ppp-charcoal-100"
            }`}
          >
            <header className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                {isAuto ? (
                  <>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-200 text-slate-700">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="3" y="11" width="18" height="10" rx="2" />
                        <circle cx="12" cy="5" r="2" />
                        <path d="M12 7v4 M8 16h.01 M16 16h.01" />
                      </svg>
                      Auto
                    </span>
                    {n.source_outcome && (
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                          n.source_outcome === "won"
                            ? "bg-blue-100 text-blue-800"
                            : n.source_outcome === "lost"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-ppp-charcoal-100 text-ppp-charcoal-700"
                        }`}
                      >
                        {n.source_outcome === "no_bid" ? "No bid" : n.source_outcome}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[12px] font-medium text-ppp-charcoal">
                    {n.author_full_name ?? n.author_email ?? "System"}
                  </span>
                )}
                <time className="text-[11px] text-ppp-charcoal-500">
                  {new Date(n.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </time>
              </div>
              {isAuto && n.source_opportunity_id && (
                <Link
                  href={`/commercial/opportunities/${n.source_opportunity_id}`}
                  className="text-[11px] font-medium text-blue-700 hover:text-blue-800 shrink-0 underline underline-offset-2"
                >
                  {n.source_opportunity_title ?? "View opportunity"} →
                </Link>
              )}
            </header>
            <p className="text-sm text-ppp-charcoal whitespace-pre-wrap leading-relaxed">
              {n.body}
            </p>
          </article>
        );
      })}
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
            className="text-blue-700 hover:text-blue-800 break-all"
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

// ───────────────────── Stage 3 compliance banner ─────────────────────

/**
 * AccountComplianceBanner — sits above the tab bar when any active
 * doc is expiring soon or already expired. Pulls counts from the
 * overview view so it's a free read (no extra query). Wraps the
 * banner in a soft-deleted-aware guard so a deleted account never
 * shows the banner.
 *
 *   expired > 0          → red banner, "N expired — renew now"
 *   else expiring > 0    → amber banner, "N expiring within 30d"
 *   else                 → nothing
 */
function AccountComplianceBanner({
  accountId,
  overview,
}: {
  accountId: string;
  overview: AccountOverview | null;
}) {
  if (!overview) return null;
  const expired = overview.expired_document_count ?? 0;
  const expiring = overview.expiring_soon_document_count ?? 0;
  if (expired === 0 && expiring === 0) return null;
  const isRed = expired > 0;
  const noun = isRed
    ? `${expired} compliance doc${expired === 1 ? "" : "s"} expired`
    : `${expiring} compliance doc${expiring === 1 ? "" : "s"} expiring within 30 days`;
  return (
    <Link
      href={`/commercial/accounts/${accountId}?tab=documents`}
      className={`block rounded-xl border px-4 py-3 sm:py-3.5 transition-colors touch-manipulation min-h-[44px] ${
        isRed
          ? "bg-rose-50 border-rose-200 text-rose-900 hover:bg-rose-100"
          : "bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100"
      }`}
    >
      <div className="flex items-center gap-3">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">{noun}</p>
          <p className="text-[12px] mt-0.5 leading-tight opacity-90">
            {isRed
              ? "Tap to open Documents and renew before the next bid."
              : "Tap to open Documents and schedule renewal."}
          </p>
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 opacity-75"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
    </Link>
  );
}

// ───────────────────── Account 360 strip ─────────────────────

function AccountOverviewStrip({
  overview,
  invoiceRollup,
  accountId,
}: {
  overview: AccountOverview | null;
  invoiceRollup: AccountInvoiceRollup;
  accountId: string;
}) {
  // Karan 2026-07-08 Batch 1: total rewrite. Old strip crammed 8 tiles
  // across 3 unrelated categories (people + documents + pipeline +
  // financials) into one grid + hung a "View statement" CTA orphaned
  // at the bottom + littered every label with an inline (?) info-dot.
  // New shape: money-only, clean.
  //
  //   ┌─────────────────────────────── Activity chip ┐
  //   │  $INVOICED    $PAID    $BALANCE               │
  //   │  ██░░░░░░ N% collected                        │
  //   │                    View statement →           │
  //   └───────────────────────────────────────────────┘
  //
  // Non-money counts (Contacts / Team / Documents / Open opps) now live
  // in their respective tab body headers — they were duplicate shortcuts
  // here since the tab bar already exposes those surfaces. Repeat-
  // customer signal moves to a subtle chip inline with Activity (was
  // fighting for attention next to it before).
  //
  // Graceful no-op if the view migration hasn't been applied yet.
  if (!overview) return null;

  const activity = relativeActivity(overview.last_activity_at);
  const activityTonality = activityTone(overview.last_activity_at);
  const activityClass =
    activityTonality === "ok"
      ? "text-blue-700 bg-blue-50 border-blue-200"
      : activityTonality === "stale"
      ? "text-amber-700 bg-amber-50 border-amber-200"
      : "text-rose-700 bg-rose-50 border-rose-200";

  // Progress bar — collected as a fraction of invoiced. Tone escalates:
  //   fully paid → emerald · any overdue → rose ·
  //   partial paid → blue · nothing paid yet → neutral.
  const invoicedCents = invoiceRollup.invoiced_cents;
  const paidCents = invoiceRollup.paid_cents;
  const collectedPct =
    invoicedCents > 0 ? Math.min(100, Math.round((paidCents / invoicedCents) * 100)) : 0;
  const barTone =
    invoicedCents === 0
      ? "bg-ppp-charcoal-200"
      : paidCents >= invoicedCents
      ? "bg-emerald-500"
      : invoiceRollup.overdue_count > 0
      ? "bg-rose-500"
      : paidCents > 0
      ? "bg-blue-500"
      : "bg-ppp-charcoal-300";

  const invoicedCountLabel =
    invoiceRollup.invoice_count === 0
      ? undefined
      : `${invoiceRollup.invoice_count} invoice${invoiceRollup.invoice_count === 1 ? "" : "s"}`;
  const balanceCountLabel =
    invoiceRollup.overdue_count > 0
      ? `${invoiceRollup.overdue_count} overdue`
      : undefined;

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
      {/* Top-right chip cluster — activity + repeat-customer signal,
          subtle so they don't compete with the money numbers below. */}
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-ppp-charcoal leading-tight">
            Financial snapshot
          </h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            Every non-void invoice + payment, rolled up.
          </p>
        </div>
        {/* Batch 2a: Repeat-customer chip moved to the header pill row
            where relationship signals belong. Activity chip stays here
            since it's tied to the money numbers below (helps read
            "invoiced X, last touched Y" as a single story). */}
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border shrink-0 ${activityClass}`}
          title={`Most recent activity on this account. Last touched: ${overview.last_activity_at}`}
        >
          Active {activity}
        </span>
      </div>

      {/* Three money tiles — same category (financials), same visual weight.
          Row layout on mobile stacks 2+1 (grid-cols-2 with last row full);
          desktop shows all three side-by-side. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
        <MoneyTile
          label="Invoiced"
          value={formatCentsCompact(invoicedCents)}
          sub={invoicedCountLabel}
          href={`/commercial/invoices?account_id=${accountId}`}
          tone="brand"
        />
        <MoneyTile
          label="Paid"
          value={formatCentsCompact(paidCents)}
          href={`/commercial/invoices?account_id=${accountId}&status=paid`}
          tone="emerald"
        />
        <MoneyTile
          label="Balance"
          value={formatCentsCompact(invoiceRollup.balance_cents)}
          sub={balanceCountLabel}
          subTone={invoiceRollup.overdue_count > 0 ? "rose" : "muted"}
          href={
            invoiceRollup.overdue_count > 0
              ? `/commercial/invoices?account_id=${accountId}&status=overdue`
              : `/commercial/invoices?account_id=${accountId}&status=sent`
          }
          tone={invoiceRollup.balance_cents > 0 ? "blue" : "muted"}
        />
      </div>

      {/* Progress bar — only meaningful when there's at least one invoice. */}
      {invoicedCents > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-2 mb-1.5 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
              Collected
            </span>
            <span className="text-[11.5px] text-ppp-charcoal-600 tabular-nums">
              <strong className="text-ppp-charcoal">{formatCentsCompact(paidCents)}</strong>
              <span className="text-ppp-charcoal-500"> of {formatCentsCompact(invoicedCents)}</span>
              <span className="text-ppp-charcoal-400"> · {collectedPct}%</span>
            </span>
          </div>
          <div className="h-2 bg-ppp-charcoal-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barTone}`}
              style={{ width: `${collectedPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Karan 2026-07-08: dropped the "View full statement" CTA that
          used to live here. The account page now has a dedicated
          Invoices tab (top nav) that covers the same drill-down, so
          this button was duplicating destinations. Users click Invoices
          in the tab strip. */}
    </section>
  );
}

/** Money-only tile — dedicated to the Financial Snapshot container so
 *  we can drop the KpiTile's tooltip / info-dot / dual-mode complexity.
 *  Tones map to semantic accents:
 *   - brand   → cc-brand tint (Invoiced — the top-of-funnel money)
 *   - emerald → green tint (Paid — money actually in the door)
 *   - blue    → blue tint (Balance — money still owed)
 *   - muted   → charcoal (zero-balance / paid-in-full quiet state)
 */
function MoneyTile({
  label,
  value,
  sub,
  subTone = "muted",
  href,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: "muted" | "rose";
  href: string;
  tone: "brand" | "emerald" | "blue" | "muted";
}) {
  const borderCls =
    tone === "brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/40"
      : tone === "emerald"
      ? "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/40"
      : tone === "blue"
      ? "border-blue-200 bg-gradient-to-br from-white to-blue-50/40"
      : "border-ppp-charcoal-200 bg-white";
  const subCls = subTone === "rose" ? "text-rose-700 font-semibold" : "text-ppp-charcoal-500";
  return (
    <Link
      href={href}
      className={`block rounded-xl border px-4 py-3 sm:py-3.5 transition-all hover:shadow-sm hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 touch-manipulation ${borderCls}`}
    >
      <div className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
        {label}
      </div>
      <div className="mt-1 text-2xl sm:text-[26px] font-bold text-ppp-charcoal leading-none tabular-nums">
        {value}
      </div>
      {sub && (
        <div className={`mt-1 text-[11px] ${subCls}`}>
          {sub}
        </div>
      )}
    </Link>
  );
}

/** "67% win · ~32d to close" subtitle when there's history; "" when none. */
function renderWinRateSub(overview: AccountOverview): string | undefined {
  const rate = winRate(overview);
  const avg = overview.avg_days_to_close;
  if (rate === null && (avg === null || avg === undefined)) return undefined;
  const rateText = rate === null ? null : `${Math.round(rate * 100)}% win`;
  const avgText = avg === null || avg === undefined ? null : `~${Math.round(avg)}d close`;
  return [rateText, avgText].filter(Boolean).join(" · ");
}

function KpiTile({
  tone,
  num,
  text,
  label,
  sub,
  subCls,
  placeholder,
  href,
  tooltip,
}: {
  tone: "live" | "placeholder";
  num?: number | null;
  text?: string;
  label: string;
  sub?: string;
  subCls?: string;
  placeholder?: string;
  href?: string;
  tooltip?: string;
}) {
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-1">
        {tone === "live" ? (
          <span className="text-xl sm:text-2xl font-bold text-ppp-charcoal leading-none">
            {text ?? (num ?? 0).toLocaleString()}
          </span>
        ) : (
          <span className="text-[11px] font-medium text-ppp-charcoal-400 italic">
            Coming with {placeholder}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-1">
        <span
          className="text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500"
          title={tooltip}
        >
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

  // Live tiles get a confident emerald accent + subtle shadow + hover
  // lift to read as actionable. Placeholders are quieter (lighter
  // background, dashed border) so the eye doesn't waste time on them
  // until the future phase lands.
  // Karan 2026-06-24: live tiles now use a subtle emerald→sky gradient
  // background instead of pure white, matching the brightened look
  // of the opp page KPI strip.
  const cls =
    tone === "live"
      ? "relative bg-gradient-to-br from-white to-sky-50 border-ppp-charcoal-200 shadow-sm"
      : "bg-ppp-charcoal-50/60 border-ppp-charcoal-200 border-dashed";

  return href ? (
    <a
      href={href}
      className={`block rounded-xl border px-3 py-3 sm:px-4 sm:py-3.5 transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 touch-manipulation ${cls}`}
    >
      {content}
    </a>
  ) : (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 sm:py-3.5 ${cls}`}>{content}</div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "emerald" | "blue" | "amber" | "rose" | "neutral" }) {
  // Karan 2026-06-24: boosted saturation from -50/-700/-200 to
  // -100/-800/-300 to match the brighter status pills on opp page.
  const cls = {
    emerald: "bg-blue-100 text-blue-800 border-blue-300",
    blue: "bg-blue-100 text-blue-800 border-blue-300",
    amber: "bg-amber-100 text-amber-900 border-amber-300",
    rose: "bg-rose-100 text-rose-800 border-rose-300",
    neutral: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
  }[tone];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
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

/**
 * AccountInvoicesTab — Karan 2026-07-08 rewrite.
 *
 * Customer-scoped invoice list per user's ask: "an invoice tab where me
 * kate katie or alex or whoever can quick edit the invoices if needed
 * and if we click on the invoice it redirects us to the invoice page
 * under that user's invoice for a full view".
 *
 * Layout:
 *   1. Top rollup strip — Invoiced / Paid / Balance / Overdue count
 *   2. "+ New invoice" CTA (deep-links to the invoicing surface with the
 *      quick-add form pre-opened for this account)
 *   3. Grouped invoice list by status (Overdue → Sent → Draft → Paid →
 *      Void), each row clickable → full invoice detail page
 */
async function AccountInvoicesTab({
  accountId,
  rollup,
  paymentOk,
  paymentCapped,
  paymentRequested,
  paymentApplied,
  errorMessage,
}: {
  accountId: string;
  rollup: AccountInvoiceRollup;
  paymentOk?: boolean;
  paymentCapped?: boolean;
  paymentRequested?: number | null;
  paymentApplied?: number | null;
  errorMessage?: string;
}) {
  const invoices = await listCommercialInvoices({ accountId });
  const paidPct =
    rollup.invoiced_cents > 0
      ? Math.min(100, Math.round((rollup.paid_cents / rollup.invoiced_cents) * 100))
      : 0;
  // Group by derived status; keep insertion order (most recent first
  // since the underlying query orders by created_at DESC).
  const buckets = new Map<ReturnType<typeof deriveInvoiceStatus>, CommercialInvoice[]>();
  for (const inv of invoices) {
    const s = deriveInvoiceStatus(inv);
    const arr = buckets.get(s) ?? [];
    arr.push(inv);
    buckets.set(s, arr);
  }
  const ORDER: ReadonlyArray<ReturnType<typeof deriveInvoiceStatus>> = [
    "overdue",
    "sent",
    "viewed",
    "partial",
    "draft",
    "paid",
    "void",
  ];
  return (
    <div className="space-y-4">
      {/* Flash toasts from the inline "Record payment" action. Same
          shape as the invoice-detail flash — emerald for success,
          amber for the overpayment-capped edge case. */}
      {paymentOk && !paymentCapped && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden>✓</span>
            <span>Payment recorded.</span>
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=invoices`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {paymentOk && paymentCapped && paymentRequested !== null && paymentApplied !== null && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-semibold">
            <span aria-hidden>✓</span>
            <span>Payment recorded — capped to invoice balance</span>
          </div>
          <div className="mt-1 text-[12.5px] text-amber-800">
            You entered <span className="font-mono">${((paymentRequested ?? 0) / 100).toFixed(2)}</span>{" "}
            but only <span className="font-mono">${((paymentApplied ?? 0) / 100).toFixed(2)}</span> was owed. The extra{" "}
            <span className="font-mono">${(((paymentRequested ?? 0) - (paymentApplied ?? 0)) / 100).toFixed(2)}</span> was not recorded.
          </div>
        </div>
      )}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
          <span>{errorMessage}</span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=invoices`}
            className="text-[12px] underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {/* Rollup strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RollupTile label="Invoiced" value={formatCentsFull(rollup.invoiced_cents)} sub={`${rollup.invoice_count} invoice${rollup.invoice_count === 1 ? "" : "s"}`} tone="neutral" />
        <RollupTile label="Paid" value={formatCentsFull(rollup.paid_cents)} sub={`${paidPct}% collected`} tone="blue" />
        <RollupTile label="Balance" value={formatCentsFull(rollup.balance_cents)} sub={rollup.balance_cents === 0 ? "settled" : "unpaid"} tone={rollup.balance_cents > 0 ? "warn" : "neutral"} />
        <RollupTile label="Overdue" value={rollup.overdue_count.toString()} sub={rollup.overdue_count === 0 ? "on track" : rollup.overdue_count === 1 ? "invoice past due" : "invoices past due"} tone={rollup.overdue_count > 0 ? "danger" : "neutral"} />
      </section>

      {/* Primary CTAs — new invoice + drill to full list */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/commercial/invoices?account_id=${accountId}`}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14 M5 12h14" />
          </svg>
          New invoice
        </Link>
        <Link
          href={`/commercial/invoices?account_id=${accountId}`}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
        >
          Full invoicing surface →
        </Link>
      </div>

      {/* Empty state */}
      {invoices.length === 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <div className="text-[36px] mb-2" aria-hidden>📄</div>
          <div className="text-sm font-semibold text-ppp-charcoal">No invoices yet</div>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            Convert a Won deal into an invoice from the Deals tab, or start a new one above.
          </p>
        </div>
      )}

      {/* Grouped invoice list */}
      {invoices.length > 0 && (
        <div className="space-y-4">
          {ORDER.map((status) => {
            const arr = buckets.get(status) ?? [];
            if (arr.length === 0) return null;
            const isDanger = status === "overdue";
            return (
              <section
                key={status}
                className={`rounded-xl overflow-hidden border ${isDanger ? "border-rose-200 bg-rose-50/20" : "border-ppp-charcoal-100 bg-white"}`}
              >
                <div className={`px-4 py-2.5 border-b ${isDanger ? "border-rose-200 bg-rose-50/40" : "border-ppp-charcoal-100 bg-ppp-charcoal-50/40"}`}>
                  <h3 className={`text-[13px] font-bold ${isDanger ? "text-rose-800" : "text-ppp-charcoal"}`}>
                    {invoiceStatusLabel(status)} · {arr.length}
                  </h3>
                </div>
                <ul className="divide-y divide-ppp-charcoal-100">
                  {arr.map((inv) => (
                    <AccountInvoiceRow key={inv.id} invoice={inv} accountId={accountId} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AccountInvoiceRow({ invoice, accountId }: { invoice: CommercialInvoice; accountId: string }) {
  const derived = deriveInvoiceStatus(invoice);
  const toneCls =
    derived === "paid"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : derived === "overdue"
      ? "bg-rose-50 text-rose-800 border-rose-200"
      : derived === "void"
      ? "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200"
      : "bg-blue-50 text-blue-800 border-blue-200";
  const paidPct =
    invoice.total_cents > 0
      ? Math.min(100, Math.round((invoice.paid_cents / invoice.total_cents) * 100))
      : 0;
  // Karan 2026-07-08: "Record payment" surfaces only when payment is
  // actually meaningful — invoice has a balance owed AND isn't void.
  // Paid/void invoices show a static state; drill into the full page
  // for refunds / adjustments (per user "everything else on invoice page").
  const canRecordPayment = derived !== "paid" && derived !== "void" && invoice.balance_cents > 0;
  return (
    <li id={`inv-${invoice.id}`} className="scroll-mt-4">
      <div className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-blue-50/40 transition-colors">
        <Link
          href={`/commercial/invoices/${invoice.id}`}
          className="flex-1 min-w-0 min-h-[52px] touch-manipulation"
          title={`Open ${invoice.invoice_number}`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-mono font-semibold text-ppp-charcoal">
              {invoice.invoice_number}
            </span>
            <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${toneCls}`}>
              {invoiceStatusLabel(derived)}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-ppp-charcoal-500 flex items-center gap-x-3 gap-y-0.5 flex-wrap">
            <span>Created {fmtEtDate(invoice.created_at)}</span>
            {invoice.due_at && (
              <>
                <span aria-hidden>·</span>
                <span>Due {fmtEtDate(invoice.due_at)}</span>
              </>
            )}
            {invoice.sent_at && (
              <>
                <span aria-hidden>·</span>
                <span>Sent {fmtEtDate(invoice.sent_at)}</span>
              </>
            )}
          </div>
          {invoice.total_cents > 0 && invoice.paid_cents > 0 && invoice.paid_cents < invoice.total_cents && (
            <div className="mt-1.5 max-w-[240px]">
              <div className="h-1 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                <div className="h-full bg-blue-500" style={{ width: `${paidPct}%` }} aria-label={`${paidPct}% paid`} />
              </div>
            </div>
          )}
        </Link>
        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <Link
            href={`/commercial/invoices/${invoice.id}`}
            className="block"
            title={`Open ${invoice.invoice_number}`}
          >
            <div className="text-sm font-bold text-ppp-charcoal">
              {formatCentsFull(invoice.total_cents)}
            </div>
            {invoice.balance_cents > 0 && invoice.balance_cents !== invoice.total_cents && (
              <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                {formatCentsFull(invoice.balance_cents)} owed
              </div>
            )}
          </Link>
          {canRecordPayment && (
            <details className="text-right">
              <summary className="list-none cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[28px] touch-manipulation">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14 M5 12h14" />
                </svg>
                Record payment
              </summary>
              <form
                action={recordPaymentInlineAction}
                className="mt-2 bg-white border border-ppp-charcoal-100 rounded-lg shadow-sm p-3 space-y-2 w-[260px] text-left"
              >
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <div className="text-[10.5px] text-ppp-charcoal-500">
                  Balance owed: <strong className="text-ppp-charcoal">{formatCentsFull(invoice.balance_cents)}</strong>
                </div>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Amount</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    name="amount"
                    required
                    placeholder="0.00"
                    defaultValue={(invoice.balance_cents / 100).toFixed(2)}
                    className="w-full mt-0.5 px-2 py-1.5 text-sm border border-ppp-charcoal-200 rounded-md tabular-nums focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Date</span>
                    <input
                      type="date"
                      name="paid_at"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      className="w-full mt-0.5 px-2 py-1.5 text-[13px] border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Method</span>
                    <select
                      name="method"
                      defaultValue=""
                      className="w-full mt-0.5 px-2 py-1.5 text-[13px] bg-white border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                    >
                      <option value="">—</option>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Reference (optional)</span>
                  <input
                    type="text"
                    name="reference"
                    maxLength={120}
                    placeholder="Check #, transaction ID…"
                    className="w-full mt-0.5 px-2 py-1.5 text-[13px] border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                  />
                </label>
                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[36px] touch-manipulation"
                >
                  Record payment
                </button>
              </form>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function RollupTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "neutral" | "blue" | "warn" | "danger";
}) {
  const ring =
    tone === "blue"
      ? "border-blue-200 bg-gradient-to-br from-white to-blue-50/50"
      : tone === "warn"
      ? "border-amber-200 bg-gradient-to-br from-white to-amber-50/40"
      : tone === "danger"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "blue" ? "bg-blue-500" : tone === "warn" ? "bg-amber-500" : tone === "danger" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-bold text-ppp-charcoal mt-1 leading-none">
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-1">{sub}</div>
    </div>
  );
}

/**
 * AccountKpisTab — Karan 2026-07-08 rewrite.
 *
 * Customer-scoped scoreboard. Numbers pulled from the same libs the
 * Financial Snapshot + Deals tab use, so drift can't happen between
 * surfaces. Read-only tiles + rolled-up progress bars.
 */
function AccountKpisTab({
  overview,
  rollup,
}: {
  accountId: string;
  overview: AccountOverview | null;
  rollup: AccountInvoiceRollup;
}) {
  // Audit fix 2026-07-08: winRate() returns a 0..1 decimal (won/total),
  // NOT a percentage. Previously the tab was rendering ".67%" instead
  // of "67%" — multiply by 100 + round for display.
  const winRateRaw = overview ? winRate(overview) : null;
  const winRatePct = winRateRaw === null ? null : Math.round(winRateRaw * 100);
  const paidPct =
    rollup.invoiced_cents > 0
      ? Math.min(100, Math.round((rollup.paid_cents / rollup.invoiced_cents) * 100))
      : 0;
  const decidedCount =
    (overview?.won_opps_count ?? 0) + (overview?.lost_opps_count ?? 0);
  const bidLow = overview?.total_active_bid_low_cents ?? 0;
  const bidHigh = overview?.total_active_bid_high_cents ?? 0;
  const bidRangeLabel = bidLow > 0 || bidHigh > 0
    ? `${formatCentsFull(bidLow)} – ${formatCentsFull(bidHigh)}`
    : "—";
  return (
    <div className="space-y-5">
      {/* Financials group */}
      <section>
        <h3 className="text-sm font-bold text-ppp-charcoal mb-2 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Financials
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <RollupTile label="Invoiced" value={formatCentsFull(rollup.invoiced_cents)} sub={`${rollup.invoice_count} invoice${rollup.invoice_count === 1 ? "" : "s"}`} tone="neutral" />
          <RollupTile label="Paid" value={formatCentsFull(rollup.paid_cents)} sub={`${paidPct}% collected`} tone="blue" />
          <RollupTile label="Balance" value={formatCentsFull(rollup.balance_cents)} sub={rollup.balance_cents === 0 ? "settled" : "unpaid"} tone={rollup.balance_cents > 0 ? "warn" : "neutral"} />
          <RollupTile label="Overdue" value={rollup.overdue_count.toString()} sub={rollup.overdue_count === 0 ? "on track" : "past due"} tone={rollup.overdue_count > 0 ? "danger" : "neutral"} />
        </div>
      </section>

      {/* Pipeline group */}
      <section>
        <h3 className="text-sm font-bold text-ppp-charcoal mb-2 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Pipeline
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <RollupTile
            label="Open bids"
            value={(overview?.open_opps_count ?? 0).toString()}
            sub={(overview?.open_opps_count ?? 0) === 0 ? "no live bids" : "in progress"}
            tone="blue"
          />
          <RollupTile
            label="Bid range"
            value={bidRangeLabel}
            sub="low – high (open)"
            tone="neutral"
          />
          <RollupTile
            label="Won"
            value={(overview?.won_opps_count ?? 0).toString()}
            sub={decidedCount === 0 ? "no history" : `of ${decidedCount} decided`}
            tone="blue"
          />
          <RollupTile
            label="Win rate"
            value={winRatePct === null ? "—" : `${winRatePct}%`}
            sub={decidedCount === 0 ? "no history" : "won ÷ decided"}
            tone="neutral"
          />
        </div>
      </section>

      {/* Progress bars — collections + wins */}
      <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 space-y-4">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Health
        </h3>
        <div>
          <div className="flex items-center justify-between text-[11px] font-semibold text-ppp-charcoal mb-1">
            <span>Collections</span>
            <span>{paidPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden">
            <div
              className={`h-full transition-all ${paidPct === 100 ? "bg-emerald-500" : "bg-blue-500"}`}
              style={{ width: `${paidPct}%` }}
              aria-label={`${paidPct}% of invoiced amount collected`}
            />
          </div>
          <p className="text-[11px] text-ppp-charcoal-500 mt-1">
            {formatCentsFull(rollup.paid_cents)} of {formatCentsFull(rollup.invoiced_cents)} collected
          </p>
        </div>
        {decidedCount > 0 && (
          <div>
            <div className="flex items-center justify-between text-[11px] font-semibold text-ppp-charcoal mb-1">
              <span>Win rate</span>
              <span>{winRatePct}%</span>
            </div>
            <div className="h-2 rounded-full bg-ppp-charcoal-100 overflow-hidden">
              <div
                className="h-full bg-cc-brand-600 transition-all"
                style={{ width: `${winRatePct ?? 0}%` }}
                aria-label={`${winRatePct}% deals won of ${decidedCount} decided`}
              />
            </div>
            <p className="text-[11px] text-ppp-charcoal-500 mt-1">
              {overview?.won_opps_count ?? 0} won · {overview?.lost_opps_count ?? 0} lost across {decidedCount} decided deal{decidedCount === 1 ? "" : "s"}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * DealDrillIn — Karan 2026-07-08. Per-deal detail section on the account
 * page. Opens when the URL has ?deal=<uuid> matching one of this
 * account's deals. Contents:
 *   1. Header — anchor id, deal title, status pill, Edit + Delete
 *   2. KPI strip — Bid / Probability / Weighted / Decision countdown
 *   3. Info grid — status, source, dates, description, project address
 *   4. Move-to-next-stage form (same DAG as elsewhere)
 *   5. Collapse link (drops ?deal= from URL)
 *
 * Users can still click into full-detail workflows via deep links:
 * ?tab=debrief (for closed deals) and ?tab=documents survive on
 * /commercial/opportunities/{id} for structured forms.
 */
function DealDrillIn({
  deal,
  accountId,
  statusEnteredAt,
  taskStats,
  primaryLead,
  fileCount,
  submittalStats,
  finishCount,
}: {
  deal: CommercialOpportunity;
  accountId: string;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
}) {
  const bidLabel = formatBidRange(deal.bid_value_low_cents, deal.bid_value_high_cents);
  const weighted = weightedPipelineCents(deal);
  const daysInStatus = daysSinceIso(statusEnteredAt);
  const daysTone =
    daysInStatus === null
      ? "text-ppp-charcoal-500"
      : daysInStatus > 14
      ? "text-rose-700"
      : daysInStatus > 7
      ? "text-amber-700"
      : "text-blue-700";
  const nextStatuses = allowedNextStatuses(deal.status);
  const isTerminal = TERMINAL_STATUSES.has(deal.status);
  const statusInfo = statusPillTone(deal.status);
  const proposalDue = deal.proposal_due_at ? new Date(deal.proposal_due_at) : null;
  const daysUntilDue = proposalDue ? Math.ceil((proposalDue.getTime() - Date.now()) / 86_400_000) : null;
  const dueLabel = daysUntilDue === null
    ? "—"
    : daysUntilDue < 0
    ? `${Math.abs(daysUntilDue)}d overdue`
    : daysUntilDue === 0
    ? "today"
    : `${daysUntilDue}d`;
  const dueTone = daysUntilDue === null
    ? "text-ppp-charcoal-500"
    : daysUntilDue < 0
    ? "text-rose-700"
    : daysUntilDue <= 3
    ? "text-amber-700"
    : "text-ppp-charcoal";
  return (
    <section
      id={`deal-${deal.id}`}
      className="bg-white border-2 border-cc-brand-300 rounded-xl overflow-hidden shadow-sm ring-1 ring-cc-brand-100 scroll-mt-4"
    >
      {/* Header row — title, status pill, action buttons */}
      <header className="px-4 sm:px-5 py-4 border-b border-ppp-charcoal-100 bg-gradient-to-r from-cc-brand-50/40 to-white">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-cc-brand-700 mb-1">
              Focused deal
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base sm:text-lg font-bold text-ppp-charcoal break-words leading-tight">
                {deal.title || "(untitled)"}
              </h3>
              <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border shrink-0 ${statusInfo.cls}`}>
                {opportunityStatusLabel(deal.status)}
              </span>
            </div>
            {daysInStatus !== null && !isTerminal && (
              <div className={`text-[11.5px] font-medium mt-1 ${daysTone}`}>
                {daysInStatus === 0 ? "just entered this stage" : `${daysInStatus}d in ${opportunityStatusLabel(deal.status).toLowerCase()}`}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <Link
              href={`/commercial/opportunities/${deal.id}/edit`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 hover:border-ppp-charcoal-300 min-h-[40px] touch-manipulation"
              title="Open the full deal-edit form"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </Link>
            <Link
              href={`/commercial/accounts/${accountId}?tab=opportunities`}
              className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-ppp-charcoal-500 hover:bg-ppp-charcoal-100 text-[12px] font-semibold min-h-[40px] touch-manipulation"
              title="Close this detail view"
              aria-label="Close deal drill-in"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
              Close
            </Link>
          </div>
        </div>
      </header>

      {/* KPI strip — bid / probability / weighted / decision countdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 sm:p-5">
        <DrillTile label="Bid" value={bidLabel !== "—" ? bidLabel : "Not set"} />
        <DrillTile label="Probability" value={`${deal.probability_pct}%`} />
        <DrillTile label="Weighted" value={weighted > 0 ? formatCentsCompact(weighted) : "—"} />
        <DrillTile label="Decision in" value={dueLabel} tone={dueTone} />
      </div>

      {/* Info grid — status meta, timeline, description, address */}
      <div className="px-4 sm:px-5 pb-4 space-y-3 border-t border-ppp-charcoal-100 pt-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <DrillField label="Source" value={deal.source ? opportunitySourceLabel(deal.source) : "Not set"} />
          <DrillField label="Primary lead" value={primaryLead ? primaryLead.user_full_name ?? primaryLead.user_email : "Unassigned"} />
          <DrillField label="Proposal due" value={deal.proposal_due_at ? new Date(deal.proposal_due_at).toLocaleDateString() : "Not set"} />
          <DrillField label="Decided" value={deal.decided_at ? new Date(deal.decided_at).toLocaleDateString() : "Not set"} />
          <DrillField label="Proposed start" value={deal.proposed_start_at ? new Date(deal.proposed_start_at).toLocaleDateString() : "Not set"} />
          <DrillField label="Proposed end" value={deal.proposed_end_at ? new Date(deal.proposed_end_at).toLocaleDateString() : "Not set"} />
        </div>
        {deal.description && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">Description</div>
            <p className="text-[13px] text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
              {deal.description}
            </p>
          </div>
        )}
        {(deal.property_street || deal.property_city || deal.property_state) && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">Project address</div>
            <p className="text-[13px] text-ppp-charcoal-700">
              {[deal.property_street, deal.property_city, deal.property_state, deal.property_zip].filter(Boolean).join(", ")}
            </p>
          </div>
        )}
        {(taskStats && (taskStats.open > 0 || taskStats.overdue > 0)) || fileCount > 0 || finishCount > 0 || (submittalStats && submittalStats.total > 0) ? (
          <div className="text-[11.5px] flex items-center gap-x-3 gap-y-1 flex-wrap text-ppp-charcoal-600 pt-1">
            {taskStats && taskStats.overdue > 0 && (
              <span className="text-rose-700 font-medium">
                <span aria-hidden>⚠</span> {taskStats.overdue} overdue task{taskStats.overdue === 1 ? "" : "s"}
              </span>
            )}
            {taskStats && taskStats.overdue === 0 && taskStats.open > 0 && (
              <span>{taskStats.open} open task{taskStats.open === 1 ? "" : "s"}</span>
            )}
            {fileCount > 0 && <span><span aria-hidden>📎</span> {fileCount} attachment{fileCount === 1 ? "" : "s"}</span>}
            {finishCount > 0 && <span><span aria-hidden>🎨</span> {finishCount} finish{finishCount === 1 ? "" : "es"}</span>}
            {submittalStats && submittalStats.total > 0 && (
              <span className={submittalStats.awaiting_response > 0 ? "text-sky-700 font-medium" : undefined}>
                <span aria-hidden>📋</span> {submittalStats.total} submittal{submittalStats.total === 1 ? "" : "s"}
                {submittalStats.awaiting_response > 0 && ` · ${submittalStats.awaiting_response} awaiting GC`}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {/* Move-to-next-stage form + delete action, side-by-side on desktop */}
      <div className="px-4 sm:px-5 pb-4 border-t border-ppp-charcoal-100 pt-4 flex items-center gap-2 flex-wrap">
        {nextStatuses.length > 0 && (
          <form action={quickFlipFromAccountAction} className="flex items-center gap-2 flex-wrap flex-1 min-w-[240px]">
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="opp_id" value={deal.id} />
            <select
              name="to_status"
              defaultValue=""
              required
              aria-label={`Move ${deal.title} to next stage`}
              className={`${SELECT_CLS} text-base sm:text-sm py-2 min-h-[40px] flex-1 min-w-[180px]`}
              style={SELECT_BG_STYLE}
            >
              <option value="" disabled>Move to next stage…</option>
              {nextStatuses.map((s) => {
                const isT = isTerminalOpportunityStatus(s);
                return (
                  <option key={s} value={s}>
                    {isT ? "→ Close as " : "→ "}{opportunityStatusLabel(s)}
                  </option>
                );
              })}
            </select>
            <button
              type="submit"
              className="px-3.5 py-2 text-[12px] font-semibold rounded-lg bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30"
            >
              Go
            </button>
          </form>
        )}
        {/* Delete — native <details> confirm. No client JS; native
            controls only. First click expands the confirm form; second
            click (submit with confirm=yes) fires the delete. */}
        <details className="relative group/del">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 bg-white text-[12px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[40px] touch-manipulation">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            Delete
          </summary>
          <form action={deleteDealFromAccountAction} className="absolute right-0 top-full mt-1.5 z-10 bg-white border border-rose-200 rounded-lg shadow-xl p-3 w-[280px] space-y-2.5">
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="opp_id" value={deal.id} />
            <input type="hidden" name="confirm" value="yes" />
            <p className="text-[12px] text-rose-800 leading-relaxed">
              Soft-delete <strong>{deal.title}</strong>. Rows tied to the deal hide from lists — an admin can restore from the audit log.
            </p>
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700 min-h-[36px] touch-manipulation"
            >
              Yes, delete this deal
            </button>
          </form>
        </details>
      </div>
    </section>
  );
}

function DrillTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-white px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`text-sm sm:text-base font-bold mt-0.5 tabular-nums ${tone ?? "text-ppp-charcoal"}`}>{value}</div>
    </div>
  );
}

function DrillField({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-[12.5px]">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className="text-ppp-charcoal-800 mt-0.5">{value}</div>
    </div>
  );
}
