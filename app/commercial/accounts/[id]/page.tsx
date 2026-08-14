import { flashMessage } from "@/lib/commercial/flash";
import { resolveTaxExemption } from "@/lib/commercial/tax/exemption";
import { getRatingLabels } from "@/lib/commercial/accounts/rating-labels";
import { notFound, redirect } from "next/navigation";
import { anchorDateOnlyIso } from "@/lib/commercial/dates";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import Link from "next/link";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount, formatAccountNumber, type CommercialAccount } from "@/lib/commercial/accounts/db";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { listAccountContacts, addContactToAccount, detachContactFromAccount, getPrimaryContact, setPrimaryContact, touchContact, CONTACT_ROLES, roleLabel, type ContactRole, type CommercialContact } from "@/lib/commercial/accounts/contacts";
import { listAccountTeam, listAssignableStaff, listAllPppProfileEmails, addAssignment, removeAssignment, ASSIGNMENT_ROLES, assignmentRoleLabel, type AssignmentRole } from "@/lib/commercial/accounts/assignments";
import { listAccountDocumentsWithUploaders, archiveDocument, restoreDocument, documentCategoryLabel, expiryStatus, type DocumentCategory, type CommercialAccountDocument } from "@/lib/commercial/accounts/documents";
import CommercialDocumentUploadForm from "@/components/commercial-document-upload-form";
import { FocusTrapAside } from "@/components/commercial/focus-trap-aside";
import AccountInlineCardForm from "@/components/commercial/account-inline-card";
import { DateField } from "@/components/commercial/date-field";
import { AutoOpportunityTitle } from "@/components/commercial/auto-opportunity-title";
import { listTeams, setOwnerTeam, getOwnerTeam } from "@/lib/commercial/teams/db";
import { proposalRevisionLabel } from "@/lib/commercial/proposals/constants";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { PendingFormButton } from "@/components/commercial/pending-form-button";
import { SearchableSelect } from "@/components/commercial/searchable-select";
import { StatusSubStatusPicker } from "@/components/commercial/status-sub-status-picker";
import { AccountAvatar } from "@/components/commercial/account-avatar";
import { CopyToClipboardButton } from "@/components/commercial/copy-to-clipboard-button";
import { getAccountOverview, relativeActivity, winRate, daysSinceIso, type AccountOverview } from "@/lib/commercial/accounts/overview";
import { getInvoiceRollupForAccount, splitOpenBalance, type AccountInvoiceRollup } from "@/lib/commercial/invoices/rollup";
import { formatCentsCompact, formatCentsFull, fmtEtDate, parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { monthlyBilledSeries as monthlyBilledSeriesShared } from "@/lib/commercial/invoices/monthly";
import { listChangeOrders } from "@/lib/commercial/change-orders/db";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { ProjectCard } from "@/components/commercial/project-card";
import { ProgressMeter } from "@/components/commercial/progress-meter";
import { listCommercialInvoices, addPayment, createCommercialInvoice, changeOrderLineCentsByInvoice, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { seedMilestonesFromLineItems, listMilestonesForInvoice, attachMilestoneLienWaiver, type MilestoneDraft } from "@/lib/commercial/invoices/milestones";
import { attachInvoiceLienWaiver } from "@/lib/commercial/invoices/lien-waiver";
import { DonutChart, GaugeRing, HBars, StatCard, type ChartTone, type DonutSegment } from "@/components/commercial/charts";
import { getProjectFinancials, marginFrom } from "@/lib/commercial/projects/financials";
import { PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META } from "@/lib/commercial/purchases/constants";
import { costBreakdownForOpps } from "@/lib/commercial/purchases/db";
import TrendChart from "@/components/trend-chart";
import { DealInvoiceBuilder } from "@/components/commercial/deal-invoice-builder";
import { resolveTaxForZip, thouToPct } from "@/lib/commercial/tax/constants";
import { listTaxJurisdictions } from "@/lib/commercial/tax/db";
import { deriveInvoiceStatus, invoiceStatusLabel, PAYMENT_METHODS } from "@/lib/commercial/invoices/constants";
import { listCommercialOpportunities, oppStatusDisplayLabel, formatBidRange, formatOpportunityNumber, weightedPipelineCents, dealValueCents, derivedOppName, getCommercialOpportunity, OPPORTUNITY_STATUSES, OPPORTUNITY_SOURCES, opportunitySourceLabel, type CommercialOpportunity, type OpportunityStatus } from "@/lib/commercial/opportunities/db";
import { createCommercialOpportunity, softDeleteCommercialOpportunity, updateCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { updateCommercialAccount } from "@/lib/commercial/accounts/mutations";
import { proposalDisplayId, getProposal, listCurrentProposalTotalByOpp } from "@/lib/commercial/proposals/db";
import { relativeAgoEt } from "@/lib/date-et";
// Inline delivery tools rendered under the deal's Project sub-tab (2026-08).
import { revalidatePath } from "next/cache";
import { listCurrentStatusEnteredAtByOpp, changeOpportunityStatus } from "@/lib/commercial/opportunities/status";
import { KANBAN_COLUMNS, columnKeyForOpp, kanbanMoveToLabel, resolveColumnTarget } from "@/lib/commercial/opportunities/kanban-columns";
import { listOpenTaskStatsByOpp } from "@/lib/commercial/opportunities/tasks";
import { listLastNoteByOpp } from "@/lib/commercial/opportunities/notes";
import { listPrimaryLeadByOpp } from "@/lib/commercial/opportunities/assignments";
import { listAttachmentCountByOpp } from "@/lib/commercial/opportunities/attachments";
import { listSubmittalCountByOpp } from "@/lib/commercial/opportunities/submittals";
import { listFinishCountByOpp } from "@/lib/commercial/opportunities/finishes";
import { listEligibleEstimators, type EligibleEstimator } from "@/lib/commercial/opportunities/estimator";
import { findDuplicateOpportunities } from "@/lib/commercial/opportunities/duplicates";
import { PRE_SALE_OPEN_STATUSES, IN_DELIVERY_STATUSES, TERMINAL_STATUSES, isWon, isLost, isPostSale, isPostSaleProject, dealPhase, probabilityFor } from "@/lib/commercial/opportunities/constants";
import { fetchOpportunityLifecycle } from "@/lib/commercial/opportunities/lifecycle";
import { BidLifecycleTimeline } from "@/components/commercial/bid-lifecycle-timeline";
import { IconClock, IconAlertTriangle, IconFileDoc, IconStar } from "@/components/commercial/inline-icons";
import { HashReveal } from "@/components/commercial/hash-reveal";
import { getAccountRecentActivity, describeActivity } from "@/lib/commercial/accounts/recent-activity";
import { proposalStatusLabel, isProposalEligibleOpp } from "@/lib/commercial/proposals/constants";
import NewProposalPicker from "@/components/commercial/new-proposal-picker";
import { commercialDb } from "@/lib/commercial/db";
import { listAccountTags, listAllDistinctTags, addAccountTag, removeAccountTag, MAX_TAG_LENGTH, type AccountTag } from "@/lib/commercial/accounts/tags";
import { SubmitButton } from "@/components/commercial/submit-button";
// InfoDot import removed 2026-07-08 Batch 2b — labels use native `title`
// attribute for hover tooltips instead of the visible `?` badge.

export const dynamic = "force-dynamic";

/** Cheap UUID sanity check used by every server action that pulls an
 *  id out of formData. We don't trust the client to send a real UUID —
 *  malformed values must fail fast, not propagate to Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PP = Promise<{ id: string }>;
type SP = Promise<{
  tab?: string;
  sub?: string;
  error?: string;
  /** Which of a deal's work orders is open (migration 123 allows several). */
  wo?: string;
  /**
   * Which submittal is open inside the deal drill-in.
   *
   * Named `sid`, not `sub` — `sub` is already this page's sub-nav param, and
   * reusing it would make every link ambiguous the moment sub-nav comes back.
   * Matches the convention the tools that already work in place use: `wo`,
   * `app`, `pkg`, `edit_co`, `edit_purchase`.
   */
  sid?: string;
  /** Which invoice is open inside the deal drill-in. See `sid`. */
  inv?: string;
  team_added?: string;
  contacts_added?: string;
  contacts_failed?: string;
  /** What assigning a team just applied, e.g. "Added 4 team members". */
  team_applied?: string;
  team_skipped?: string;
  /** Karan 2026-07-08: on-create tags + docs flashes from /new. */
  tags_added?: string;
  tag_skipped?: string;
  docs_added?: string;
  doc_skipped?: string;
  saved?: string;
  /** Karan 2026-07-08: right-side slide-out edit sheet for a specific
   *  deal. Replaces the DealDrillIn auto-focus behavior. Any surface
   *  that used to redirect to `/commercial/opportunities/[id]/edit`
   *  now redirects here — the standalone edit page is a shim now. */
  edit?: string;
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
  /** Small non-blocking heads-up after a payment (never-reject flow). */
  heads_up?: string;
  /** Karan 2026-07-08: inline "+ New opportunity" collapsible state. Set from
   *  the retired /commercial/opportunities/new redirect (auto-opens the
   *  form) OR from a redirect after error. `created=1` + `created_title`
   *  fire the success toast. */
  new_deal?: string;
  /** Set by the deal page's Edit link so saving returns to the deal. */
  deal_back?: string;
  created?: string;
  created_title?: string;
  /** B1 (Katie 2026-08): set when a NEW opportunity was just created and we
   *  landed on its deal drill-in. Distinct from `created` (which means "invoice
   *  created" on the Invoices sub-tab) so the two flashes never collide. */
  deal_created?: string;
  /** Phase E-6: "Start project" fired on a Won debrief. Value is the
   *  opp id that just hopped from Pre-Sale to Pre-Construction so the
   *  toast can name the deal. */
  project_started?: string;
  /** Phase B (2026-07-09) — populated by createDealInlineAction when
   *  a match on client_name + property_street exists on this account.
   *  Renders an amber "Possible duplicate" banner on the New Deal form
   *  with a "Create anyway" button. dup_id is the matched opp's UUID
   *  (drill-in link); dup_label is either its project_number or title
   *  for display. */
  dup_id?: string;
  dup_label?: string;
  /** Values typed before the duplicate warning fired, echoed back so
   *  "Create anyway" doesn't mean "retype everything". */
  d_title?: string; d_client?: string; d_street?: string; d_city?: string;
  d_state?: string; d_zip?: string; d_desc?: string; d_source?: string;
  d_due?: string; d_rfp?: string; d_contact?: string; d_team?: string;
  /** Karan 2026-07-15: bulk-delete-all-proposals toast after the action
   *  redirects back to ?tab=proposals. `bulk_deleted` is the count of
   *  drafts nuked; `bulk_skipped` is the count of Sent/Won/Lost/
   *  Replaced rows that were spared (they're historical). */
  bulk_deleted?: string;
  bulk_skipped?: string;
  /** Katie 2026-07-20: per-account "Include archived" toggle on the
   *  Deals tab. `?archived=1` reveals archived deals; default hides. */
  archived?: string;
  status_error?: string;
  /** 2026-07-29: Projects tab drills into ONE project's home (folded under
   *  the account) via ?tab=projects&project=<dealId>. */
  project?: string;
  /** Deal sub-tab (B1 content-swap): overview | proposals | invoices | project | documents. */
  dt?: string;
  /** Project sub-tab tool (the inline delivery tools under the Project tab):
   *  change-orders | aia | submittals | closeout. */
  pt?: string;
  /** Passed through to the inline delivery tools rendered under the Project
   *  sub-tab (each tool reads the ones it needs). */
  co_ok?: string;
  edit_co?: string;
  co_title?: string;
  co_amt?: string;
  co_desc?: string;
  ok?: string;
  /** Inline Work Order "Send to Field Ops" outcome flags (audit #7) — without
   *  these the inline tool swallows PDF/email failures while the standalone
   *  route warns. */
  emailed?: string;
  emailfail?: string;
  filefail?: string;
  app?: string;
  pkg?: string;
  /** Phase 2 Costs & P&L tool. */
  cost_ok?: string;
  edit_purchase?: string;
  pu_cat?: string;
  pu_vendor?: string;
  pu_amt?: string;
  pu_hours?: string;
  pu_date?: string;
  pu_desc?: string;
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
type PrimaryTab = "overview" | "people" | "deals" | "documents" | "proposals" | "invoices" | "projects" | "activity";
type SubTab =
  | "home"
  | "info"
  | "team"
  | "kpis"
  | "contacts"
  | "notes"
  | "opportunities"
  | "documents"
  | "proposals";
const PRIMARY_TABS: { key: PrimaryTab; label: string }[] = [
  // Karan 2026-07-08 reorder + 2026-07-10 fold: Overview leads
  // (at-a-glance summary — Info · Team · KPIs sub-tabs), then Deals
  // (pipeline read), Invoices (money question), People, Activity.
  // KPIs got folded into Overview because the standalone tab was a
  // scoreboard-only leaf; the sub-tab keeps it discoverable without
  // adding a top-nav slot.
  //
  // Karan 2026-07-15: Proposals promoted from a sub-tab under Deals to
  // its own top-level tab — buried one click deep in a sub-nav meant
  // Alex + Katie kept asking "where do proposals live?" Now it's one
  // click from any customer's home. Positioned right after Deals so
  // the flow reads "pipeline → proposals → invoices" left-to-right.
  // Karan 2026-07-29: "Projects" top-level tab — every Won/in-delivery deal
  // for this account with direct jumps into its Change Orders / AIA Billing /
  // Submittals / Closeout. Sits right after Invoices so the flow reads
  // "pipeline → proposals → invoices → projects (delivery)".
  // 2026-08 refinement (Karan): the account is 3 leaf tabs. Overview = an
  // all-deal KPI dashboard, Deals = the deal-blocks list, Documents = account
  // info (editable) + compliance docs + a rollup of every deal's docs. People /
  // Proposals / Invoices / Projects / Activity moved onto the deal (their routes
  // still resolve for bookmarks/bells — just unlinked here).
  // RUX-2 (2026-08): Contacts pulled OUT of the Documents catch-all into its own
  // leaf — contacts aren't documents, and burying them there hid them.
  { key: "overview", label: "Overview" },
  { key: "deals", label: "Opportunities" },
  { key: "people", label: "Contacts" },
  { key: "documents", label: "Documents" },
];
type PrimaryWithSubs = Exclude<PrimaryTab, "activity" | "invoices" | "proposals" | "projects" | "documents">;
const SUB_TABS_BY_PRIMARY: Record<PrimaryWithSubs, { key: SubTab; label: string }[]> = {
  overview: [
    { key: "home", label: "Summary" },
    { key: "info", label: "Info" },
    { key: "team", label: "Team" },
    { key: "kpis", label: "P&L" },
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
function resolveTabParam(raw: string | undefined): { primary: PrimaryTab; sub: SubTab | null } {
  // 2026-08: Overview (all-deal KPI dashboard) is the default landing.
  if (!raw) return { primary: "overview", sub: null };
  // `projects` was a SECOND list of the same deals, split by phase. Step 6
  // collapsed it into the one Opportunities list — an account shows its deals
  // once. Bookmarks and the two sidebar tool indexes still send `?tab=projects`,
  // so it aliases rather than rendering an empty tab.
  if (raw === "projects") return { primary: "deals", sub: null };
  if (raw === "overview" || raw === "deals" || raw === "documents" || raw === "people" || raw === "proposals" || raw === "activity" || raw === "invoices") {
    return { primary: raw, sub: null };
  }
  // Legacy links remap onto the 3 leaf tabs so bookmarks/bells don't 404:
  if (raw === "kpis" || raw === "performance") return { primary: "overview", sub: null };
  if (raw === "home") return { primary: "deals", sub: null }; // old Summary → Deals list
  if (raw === "opportunities") return { primary: "deals", sub: null };
  if (raw === "contacts") return { primary: "people", sub: null }; // legacy → the Contacts leaf
  // NOT "team" — it's a reachable (if unlinked-from-the-top-nav) leaf, same
  // treatment as ?tab=opportunities. It used to fall into this legacy remap,
  // which meant the account Team tab was unreachable and the whole
  // "assign a team to this customer" flow was dead code: the action even
  // redirected to ?tab=team and landed the user on Documents.
  if (raw === "info" || raw === "notes") return { primary: "documents", sub: null };
  return { primary: "overview", sub: null };
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
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const sp = await searchParams;
  const rawTab = sp.tab;
  const rawSub = sp.sub;
  const { primary: resolvedPrimary, sub: resolvedSub } = resolveTabParam(rawTab);
  // L7 — `?tab=invoices` is an orphan: nothing in the app links to it any more
  // (every invoice link goes to the account-scoped global list) and nothing
  // redirects into it, yet it renders a second, separately-maintained invoices
  // surface. Old bookmarks are the only traffic, so send them to the canonical
  // one rather than keeping two implementations that can drift apart.
  if (resolvedPrimary === "invoices") {
    redirect(`/commercial/invoices?account_id=${id}`);
  }
  // Named `primaryTab` here to avoid collision with the `primary` local
  // below that refers to the primary contact record.
  const primaryTab: PrimaryTab = resolvedPrimary;
  // 2026-08: the account is 3 LEAF tabs — no sub-navigation. Overview →
  // KPI dashboard, Deals → the deal-blocks list, Documents → info + docs. The
  // hidden legacy primaries (proposals/invoices/activity/projects) still map to
  // their content so bookmarks + the deal drill-in (?tab=projects&project=)
  // keep working.
  const hasSubTabs = false;
  const sub: SubTab | null = null;
  void rawSub;
  void resolvedSub;
  const tab: SubTab | "activity" | "invoices" | "proposals" | "projects" =
    // ?tab=opportunities stays a reachable (unlinked) create/manage surface so
    // the "New opportunity" flow keeps working after the nav slimmed to 3 tabs.
    rawTab === "opportunities" ? "opportunities"
    // ?tab=team — the account's staff roster + "assign a whole team" surface.
    : rawTab === "team" ? "team"
    : primaryTab === "overview" ? "kpis"
    : primaryTab === "deals" ? "home"
    : primaryTab === "documents" ? "documents"
    : primaryTab === "activity" ? "activity"
    : primaryTab === "proposals" ? "proposals"
    : primaryTab === "projects" ? "projects"
    : primaryTab === "people" ? "contacts"
    : "home";

  // Viewing a single deal (drill-in). The deal view carries its OWN back-link,
  // money header + sub-tab bar, so the account chrome (hero actions, financial
  // strip + primary nav) is suppressed below to avoid stacked/duplicate nav +
  // numbers. Keyed on a VALID uuid so ?project=garbage doesn't strip the chrome
  // off the projects-list fallback.
  const inDealDrillIn = tab === "projects" && typeof sp.project === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.project);

  // ── The drill-in moved out (restructure step 3, Karan 2026-08-12) ─────────
  //
  // A deal used to open *inside* the account page at
  // `?tab=projects&project=<uuid>`. It has its own page now, and the account is
  // a shelf that links to it. Every one of these URLs is in bookmarks, bell
  // notifications and sent emails, so this forwards rather than 404s.
  //
  // `dt` was the tool sub-tab; it maps onto the opportunity page's
  // `?tab=project&sub=` (and `dt=proposals` / `dt=invoices`, which were not
  // project tools, onto their own primaries).
  if (inDealDrillIn) {
    const dealId = sp.project as string;
    const dt = typeof sp.dt === "string" ? sp.dt : "overview";
    const q = new URLSearchParams();
    if (dt === "proposals") q.set("tab", "proposals");
    else if (dt === "invoices") q.set("tab", "invoices");
    else if (dt === "documents") { q.set("tab", "docs"); q.set("sub", "files"); }
    else if (dt === "pnl" || dt === "overview") q.set("tab", "overview");
    else {
      // A delivery tool. `costs` was renamed `transactions` for Katie.
      q.set("tab", "project");
      q.set("sub", dt === "costs" ? "transactions" : dt);
    }
    // Carry everything else — deep links to a specific invoice, a submittal,
    // an error toast from a save that redirected here.
    for (const [k, v] of Object.entries(sp)) {
      if (k === "tab" || k === "project" || k === "dt" || k === "sub") continue;
      const first = Array.isArray(v) ? v[0] : v;
      if (first != null) q.set(k, first);
    }
    redirect(`/commercial/opportunities/${dealId}?${q.toString()}`);
  }

  const account = await getCommercialAccount(id);
  if (!account) notFound();

  // Account 360 overview — counts pulled from the Postgres view in one
  // round-trip. Falls back to nulls if the view migration hasn't been
  // pasted yet (graceful degradation; the KPI strip just hides).
  // Primary contact loads in parallel so the header can show the
  // quick-email button without an extra round-trip.
  const [overview, primary, invoiceRollup, ratingLabels] = await Promise.all([
    getAccountOverview(account.id),
    getPrimaryContact(account.id),
    getInvoiceRollupForAccount(account.id),
    getRatingLabels(),
  ]);

  const contactsAdded = sp.contacts_added ? Number(sp.contacts_added) : 0;
  const contactsFailed = sp.contacts_failed ? Number(sp.contacts_failed) : 0;
  const teamAddedCount = sp.team_added ? Number(sp.team_added) : 0;
  const teamSkippedMsg = sp.team_skipped ?? null;
  const tagsAddedCount = sp.tags_added ? Number(sp.tags_added) : 0;
  const tagSkippedMsg = sp.tag_skipped ?? null;
  const docsAddedCount = sp.docs_added ? Number(sp.docs_added) : 0;
  const docSkippedMsg = sp.doc_skipped ?? null;
  const savedOk = sp.saved === "1";
  const statusError = sp.status_error;

  return (
    <div className="space-y-5">
      {/* 2026-07-21 re-audit (Finding B): open collapsed <details> (e.g.
          the "Decided" deals accordion) around a #deal-row hash target and
          scroll to it, so cross-page links / the command palette don't land
          on hidden content. */}
      <HashReveal />
      {/* Guidance banner from gated redirects (e.g. opening Closeout on a
          not-yet-Won deal). Amber = "do this first," not a hard error. */}
      {statusError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
          <span>{statusError}</span>
        </div>
      )}
      {/* Toast surface from the new-account team-on-create flow. Fades
          out via reload (no client component needed — the user navigating
          away clears the query string naturally). */}
      {savedOk && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
          <span>Changes saved.</span>
        </div>
      )}
      {/* Contacts typed on the create form. Reported rather than assumed —
          somebody entered a person and expects to find them. */}
      {contactsAdded > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2 flex-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
          <span className="flex-1 min-w-0">
            Saved {contactsAdded} contact{contactsAdded === 1 ? "" : "s"}. An
            estimator here is pre-filled when you send them a proposal.
          </span>
          <Link href={`/commercial/accounts/${account.id}?tab=people`} className="font-semibold underline underline-offset-2 shrink-0">
            View
          </Link>
        </div>
      )}
      {contactsFailed > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
          {contactsFailed} contact{contactsFailed === 1 ? "" : "s"} couldn&rsquo;t
          be saved — the account was created. Add them from the Contacts tab.
        </div>
      )}
      {teamAddedCount > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2 flex-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
          <span className="flex-1 min-w-0">
            Added {teamAddedCount} team member{teamAddedCount === 1 ? "" : "s"}.
            They&apos;ve been emailed a link to this account.
          </span>
          <Link
            href={`/commercial/accounts/${account.id}?tab=documents`}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-semibold bg-surface text-cc-brand-700 border border-cc-brand-300 hover:bg-cc-brand-50 min-h-[44px] sm:min-h-[36px] touch-manipulation shrink-0"
            title="Upload Certificate of Insurance (COI) and W-9 tax form"
          >
            Upload Certificate of Insurance / W-9 →
          </Link>
        </div>
      )}
      {teamSkippedMsg && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
          <span>
            Some team members couldn&apos;t be added — {teamSkippedMsg}. Try again from
            the Team tab below.
          </span>
        </div>
      )}
      {(docsAddedCount > 0 || tagsAddedCount > 0) && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2 flex-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
          <span className="flex-1 min-w-0">
            {docsAddedCount > 0 && (
              <>Uploaded {docsAddedCount} document{docsAddedCount === 1 ? "" : "s"}.</>
            )}
            {docsAddedCount > 0 && tagsAddedCount > 0 && " "}
            {tagsAddedCount > 0 && (
              <>Attached {tagsAddedCount} tag{tagsAddedCount === 1 ? "" : "s"}.</>
            )}
          </span>
        </div>
      )}
      {(docSkippedMsg || tagSkippedMsg) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
          <span>
            {docSkippedMsg && <>Some documents couldn&apos;t be uploaded: {docSkippedMsg}. Try again from the Documents tab.</>}
            {docSkippedMsg && tagSkippedMsg && <br />}
            {tagSkippedMsg && <>Some tags couldn&apos;t be attached: {tagSkippedMsg}. Add them from the Tags card.</>}
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
          CTA is "+ New opportunity" for direct action; Edit is a quieter
          secondary link. Everything wraps cleanly on mobile. */}
      {/* Karan 2026-07-08 polish: hero wrapped in a subtle gradient card
          so the account name has a distinct visual home. Same treatment
          as the dashboard hero for consistent design language. */}
      <header className="relative bg-gradient-to-br from-cc-brand-50/40 via-surface to-surface border border-cc-brand-100 rounded-2xl p-5 sm:p-6 overflow-hidden">
        <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400" />
        <div className="relative">
          <Link
            href="/commercial/accounts"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 touch-manipulation"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Accounts
          </Link>
        </div>
        <div className="relative flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Karan 2026-07-11: colored initials avatar so the hero
                  immediately identifies this account by its platform-
                  wide color. Same hue appears on pipeline group cards,
                  invoice list rows, quick-sheet header, etc. */}
              <AccountAvatar accountId={account.id} name={account.company_name} size="lg" />
              <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal break-words tracking-tight">
                {account.company_name}
              </h1>
            </div>
            {account.dba && (
              <p className="text-sm text-ppp-charcoal-500 mt-0.5">d/b/a {account.dba}</p>
            )}
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              {/* Karan 2026-07-21: ACC-#### unique account identifier
                  (migration 070). Navy mono chip — matches the ID-badge
                  language (ALT-#### / PROP-#### / INV-####) with navy as
                  the structural/ID accent. */}
              {formatAccountNumber(account.account_seq) && (
                <span className="inline-flex items-center rounded-md border border-ppp-navy-100 bg-ppp-navy-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-tight text-ppp-navy-700">
                  {formatAccountNumber(account.account_seq)}
                </span>
              )}
              {account.is_key_relationship && (
                <Pill tone="emerald"><IconStar size={11} className="shrink-0" /> Key Relationship</Pill>
              )}
              {!account.is_key_relationship && (overview?.won_opps_count ?? 0) > 0 && (
                <Pill tone="emerald"><IconStar size={11} className="shrink-0" /> Repeat customer</Pill>
              )}
              {account.do_not_bid && (
                <Pill tone="rose">
                  Do not bid
                </Pill>
              )}
              {account.rating && (
                <Pill tone={ratingTone(account.rating)}>
                  {account.rating}
                  {ratingLabels[account.rating]?.label
                    ? ` · ${ratingLabels[account.rating].label}`
                    : ""}
                </Pill>
              )}
              {/* Industry pill removed 2026-08-12 — Brendan: "We don't need
                  Industry on accounts." This was the last place it still
                  showed; the second one the parallel session caught. */}
              {/* Karan 2026-07-09 Phase A: vendor_compliance_status pill removed —
                  Compliance moves to per-Opportunity/per-Project docs in Phase C. */}
            </div>
            {primary && (
              <div className="mt-2.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px]">
                <span className="inline-flex items-center gap-1">
                  <span className="font-semibold text-ppp-charcoal">{primary.contact.full_name}</span>
                  <span className="text-ppp-charcoal-500">· {roleLabel(primary.role)}</span>
                </span>
                {primary.contact.email && (
                  <span className="inline-flex items-center gap-0.5">
                    <a
                      href={`mailto:${primary.contact.email}`}
                      className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 hover:underline underline-offset-2 min-h-[44px]"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6" />
                      </svg>
                      Email
                    </a>
                    <CopyToClipboardButton value={primary.contact.email} label="Email copied" ariaLabel={`Copy email ${primary.contact.email}`} />
                  </span>
                )}
                {primary.contact.phone && (
                  <span className="inline-flex items-center gap-0.5">
                    <a
                      href={`tel:${primary.contact.phone.replace(/[^0-9+]/g, "")}`}
                      className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 hover:underline underline-offset-2 min-h-[44px]"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                      </svg>
                      Call
                    </a>
                    <CopyToClipboardButton value={primary.contact.phone} label="Phone copied" ariaLabel={`Copy phone ${primary.contact.phone}`} />
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Primary CTA cluster — "+ New opportunity" is the visually loud
              action Alex will reach for most often (add another bid
              for this customer). Edit is a subtle ghost link — always
              reachable but doesn't compete for attention. Hidden inside a
              deal drill-in, where the deal view has its own New/Edit actions
              (no duplicate account-level CTAs stacked above one deal). */}
          {!inDealDrillIn && (
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <Link
              href={`/commercial/accounts/${account.id}?tab=opportunities&new_deal=1#new-deal`}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px]"
              title={`Log a new opportunity for ${account.company_name}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New opportunity
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
        )}
        </div>
      </header>

      {/* Financial snapshot strip removed (Karan 2026-08) — the account
          Profitability + Collections sections cover the money picture. */}

      {/* Stage 3: Expiring-doc banner — appears between the KPI strip
          and the tab bar when ANY active doc on this account expires
          within 30 days OR has already expired. Driven by the existing
          commercial_account_overview_v view (no extra query). Click
          jumps to the Documents tab. Banner is amber for "expiring
          soon" + red for "already expired" so the urgency reads at a
          glance. */}
      {/* Karan 2026-07-09 Phase A: AccountComplianceBanner removed. */}

      {/* Primary tab bar — 3 leaf tabs (Overview / Deals / Documents).
          Suppressed inside a deal drill-in, where the deal view brings its own
          back-link + sub-tab nav (no stacked account nav above it). */}
      {!inDealDrillIn && (
      <nav className="relative border-b border-ppp-charcoal-100">
        <ul className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto scroll-smooth [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {PRIMARY_TABS.map((t) => {
            const active = t.key === primaryTab;
            return (
              <li key={t.key}>
                <Link
                  href={`/commercial/accounts/${id}?tab=${t.key}`}
                  aria-current={active ? "page" : undefined}
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
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-surface to-transparent sm:hidden" aria-hidden />
      </nav>
      )}

      {/* Sub-tab pill row — only when the primary has sub-tabs.
          Activity / Invoices / Proposals are single-view leaves with no sub-nav.
          Karan 2026-07-20 UI/UX pass: added a "View:" prefix so users
          don't read the pills as a second row of primary tabs (Karan
          screenshotted 9 items back-to-back that looked flat). */}
      {hasSubTabs && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span aria-hidden className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-400 mr-1">
            View
          </span>
          {SUB_TABS_BY_PRIMARY[primaryTab as PrimaryWithSubs].map((s) => {
            const active = s.key === sub;
            return (
              <Link
                key={s.key}
                href={`/commercial/accounts/${id}?tab=${primaryTab}&sub=${s.key}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors touch-manipulation min-h-[44px] sm:min-h-[36px] ${
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
      {tab === "home" && <AccountHome account={account} />}
      {tab === "activity" && <ActivityTab accountId={account.id} />}
      {tab === "contacts" && <ContactsTab accountId={account.id} errorMessage={sp.error} />}
      {tab === "opportunities" && (
        <OpportunitiesTab
          accountId={account.id}
          account={account}
          overview={overview}
          openNewDeal={sp.new_deal === "1"}
          dealBack={sp.deal_back === "1"}
          createdTitle={sp.created === "1" ? sp.created_title ?? null : null}
          projectStartedOppId={
            typeof sp.project_started === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.project_started)
              ? sp.project_started
              : null
          }
          editDealId={
            typeof sp.edit === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.edit)
              ? sp.edit
              : null
          }
          savedFlash={sp.saved === "1"}
          deletedFlash={typeof sp.deleted === "string" ? sp.deleted : null}
          errorMessage={sp.error}
          duplicateWarning={
            typeof sp.dup_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.dup_id)
              ? { id: sp.dup_id, label: typeof sp.dup_label === "string" ? sp.dup_label : "" }
              : null
          }
          includeArchived={sp.archived === "1"}
          keptValues={{
            title: sp.d_title, client_name: sp.d_client, property_street: sp.d_street,
            property_city: sp.d_city, property_state: sp.d_state, property_zip: sp.d_zip,
            description: sp.d_desc, source: sp.d_source, proposal_due_at: sp.d_due,
            rfp_received_at: sp.d_rfp, primary_contact_id: sp.d_contact, team_id: sp.d_team,
          }}
        />
      )}
      {tab === "documents" && (
        <div className="space-y-5">
          <InfoTab account={account} errorMessage={sp.error} />
          <DocumentsTab accountId={account.id} errorMessage={sp.error} />
        </div>
      )}
      {tab === "proposals" && (
        <AccountProposalsTab
          accountId={account.id}
          accountName={account.company_name}
          bulkDeletedCount={
            typeof sp.bulk_deleted === "string" ? Number(sp.bulk_deleted) : null
          }
          bulkSkippedCount={
            typeof sp.bulk_skipped === "string" ? Number(sp.bulk_skipped) : null
          }
          errorMessage={sp.error}
        />
      )}
      {tab === "kpis" && <AccountKpisTab accountId={account.id} overview={overview} rollup={invoiceRollup} />}
      {tab === "team" && (
        <TeamTab
          accountId={account.id}
          errorMessage={typeof sp.error === "string" ? sp.error : undefined}
          appliedNote={typeof sp.team_applied === "string" ? sp.team_applied : undefined}
        />
      )}

    </div>
  );
}

/**
 * AccountHome (R1, 2026-08) — the account's default landing. The account is now
 * a LEAN container: a compact rollup strip + its deals shown as bordered blocks
 * (in-delivery projects as rich ProjectCards, pipeline deals as compact blocks,
 * completed folded away). Each block drills into that deal. Info / Team / KPIs
 * moved to sub-tabs. This is the first step of the account↔deal restructure
 * (Katie 2026-08 notes) — deals are the star, the account is the shelf.
 */
async function AccountHome({ account }: { account: CommercialAccount }) {
  const [projects, allOpps] = await Promise.all([
    listProjects({ accountId: account.id, includeClosed: true }),
    listCommercialOpportunities({ accountId: account.id }),
  ]);
  const postSaleIds = new Set(projects.map((p) => p.opp.id));
  // A just-won deal is NOT "in delivery" — nothing has been billed, nothing
  // scheduled, no crew on it. It read as in-delivery here while the deal page
  // itself said "Won · ready to start", so the same deal described itself two
  // ways one click apart. Its own group, with the honest heading.
  const wonNotStarted = projects.filter((p) => dealPhase(p.opp) === "won_not_started");
  const activeProjects = projects.filter(
    (p) => p.opp.status !== "post_sale_closed" && dealPhase(p.opp) !== "won_not_started"
  );
  const completedProjects = projects.filter((p) => p.opp.status === "post_sale_closed");
  // Finished on site but the paperwork isn't in — distinct from truly closed.
  const closeoutPending = completedProjects.filter(
    (p) => p.opp.sub_status === "closeout"
  ).length;
  const pipelineDeals = allOpps.filter(
    (o) => !postSaleIds.has(o.id) && PRE_SALE_OPEN_STATUSES.includes(o.status),
  );
  // Lost / not-pursued deals — pre_sale_closed + lost. Not in listProjects (won
  // only) and not pipeline-open, so without this they'd vanish while still
  // being counted (audit finding #1: header said "5 deals", showed 2).
  const lostDeals = allOpps.filter(
    (o) => !postSaleIds.has(o.id) && o.status === "pre_sale_closed" && o.sub_status === "lost",
  );
  const totalDeals = allOpps.length;
  // Weighted-$ on each deal block falls back to the proposal total when the deal
  // has no bid range (bid low/high left the create forms in the 2026-08 meeting;
  // pricing lives on the proposal now). Only the blocks that render Weighted —
  // pipeline + lost — need it, so scope the lookup to those ids.
  const blockOppIds = [...pipelineDeals, ...lostDeals].map((o) => o.id);
  const blockProposalTotals =
    blockOppIds.length > 0
      ? await listCurrentProposalTotalByOpp(blockOppIds)
      : new Map<string, number>();
  // Auto-open the folded sections when there's no active/pipeline work above
  // them, so an account whose deals are all completed/lost doesn't land on a
  // blank page + a single collapsed row (audit findings #1, #3).
  const hasUpfront = activeProjects.length > 0 || pipelineDeals.length > 0;

  // The account Profitability + Collections sections sit above the tab bar on
  // every tab, so the home stays lean: just the deal blocks.
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12px] text-ppp-charcoal-500">
          {totalDeals} deal{totalDeals === 1 ? "" : "s"} under {account.company_name}
        </p>
        <Link
          href={`/commercial/accounts/${account.id}?tab=opportunities&new_deal=1#new-deal`}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14 M5 12h14" /></svg>
          New opportunity
        </Link>
      </div>

      {totalDeals === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No opportunities yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Add an opportunity to this account and it&rsquo;ll show here as its own block — with its proposals, invoices, change orders, and documents inside.</p>
        </div>
      ) : (
        <>
          {wonNotStarted.length > 0 && (
            <section className="space-y-2.5">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Won · ready to start · {wonNotStarted.length}</h2>
              <ul className="space-y-2.5">
                {wonNotStarted.map((p) => <ProjectCard key={p.opp.id} p={p} hideAccountName />)}
              </ul>
            </section>
          )}
          {activeProjects.length > 0 && (
            <section className="space-y-2.5">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">In delivery · {activeProjects.length}</h2>
              <ul className="space-y-2.5">
                {activeProjects.map((p) => <ProjectCard key={p.opp.id} p={p} hideAccountName />)}
              </ul>
            </section>
          )}
          {pipelineDeals.length > 0 && (
            <section className="space-y-2.5">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Pipeline · {pipelineDeals.length}</h2>
              <ul className="space-y-2.5">
                {pipelineDeals.map((o) => <PipelineDealBlock key={o.id} accountId={account.id} opp={o} proposalTotal={blockProposalTotals.get(o.id)} />)}
              </ul>
            </section>
          )}
          {completedProjects.length > 0 && (
            <details className="group" open={!hasUpfront}>
              <summary className="list-none cursor-pointer flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500 min-h-[44px] sm:min-h-[36px] select-none">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
                Completed · {completedProjects.length}
                {/* M3: a job at `post_sale_closed·closeout` still OWES paperwork
                    — warranty, transmittal, lien waivers — and it was folded
                    away inside a collapsed "Completed" group, which is where
                    outstanding work goes to be forgotten. Say so on the summary
                    so it's visible without expanding. */}
                {closeoutPending > 0 && (
                  <span className="normal-case tracking-normal text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 text-[10px] font-bold">
                    {closeoutPending} awaiting close-out docs
                  </span>
                )}
              </summary>
              <ul className="space-y-2.5 mt-2">
                {completedProjects.map((p) => <ProjectCard key={p.opp.id} p={p} hideAccountName />)}
              </ul>
            </details>
          )}
          {lostDeals.length > 0 && (
            <details className="group" open={!hasUpfront && completedProjects.length === 0}>
              <summary className="list-none cursor-pointer flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500 min-h-[44px] sm:min-h-[36px] select-none">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
                Lost / not pursued · {lostDeals.length}
              </summary>
              <ul className="space-y-2.5 mt-2">
                {lostDeals.map((o) => <PipelineDealBlock key={o.id} accountId={account.id} opp={o} proposalTotal={blockProposalTotals.get(o.id)} />)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Compact pipeline (pre-sale) deal block for the account home — the deal isn't
 *  in delivery yet, so it shows its bid + stage and drills into the deal sheet. */
function PipelineDealBlock({ accountId, opp, proposalTotal }: { accountId: string; opp: CommercialOpportunity; proposalTotal?: number | null }) {
  const name = derivedOppName(opp, null);
  const code = formatOpportunityNumber(opp.project_number);
  const lo = opp.bid_value_low_cents;
  const hi = opp.bid_value_high_cents;
  const bid = lo != null && hi != null ? `${formatCentsCompact(lo)}–${formatCentsCompact(hi)}` : lo != null ? formatCentsCompact(lo) : hi != null ? formatCentsCompact(hi) : "—";
  // Stage-derived, not the stored column — see `probabilityFor`.
  const stageProb = probabilityFor(opp.status, opp.sub_status);
  // Weighted falls back to the proposal total when the deal has no bid range,
  // so a new (bid-less) deal doesn't read $0 here while the dashboard shows it.
  const weighted = weightedPipelineCents(opp, proposalTotal);
  const location = opp.property_street?.trim() || null;
  const href = `/commercial/opportunities/${opp.id}`;
  // Stage tone — the accent stripe + pill read the pipeline stage at a glance
  // (Proposal = hot/brand, Estimating = blue, earlier = neutral).
  // Matches `statusPillTone` on this same page, which they used to contradict:
  // Proposal was RED here and blue there, Estimating blue here and amber there.
  // Red is the ACTION colour platform-wide and never a status — that rule is
  // written into statusPillTone and was being broken twenty rows above it.
  // ONE source for a status's colour — `statusPillTone`, which reads the
  // sub-status too. Hand-aligning two maps closed the cases anyone had noticed
  // and left the rest: `proposal·follow_up` was blue here and amber there,
  // `qualifying·rfp` charcoal here and blue there, on the same account.
  const tone = pipelineBlockTone(opp.status, opp.sub_status);
  // Bid-due urgency (proposal_due_at). Overdue → rose, ≤3 days → amber.
  const dueMs = opp.proposal_due_at ? new Date(opp.proposal_due_at).getTime() - Date.now() : null;
  const dueDays = dueMs != null ? Math.ceil(dueMs / 86_400_000) : null;
  const dueTone = dueDays == null ? "" : dueDays < 0 ? "text-rose-700" : dueDays <= 3 ? "text-amber-700" : "text-ppp-charcoal-500";
  const dueLabel = dueDays == null ? null : dueDays < 0 ? `Bid ${Math.abs(dueDays)}d overdue` : dueDays === 0 ? "Bid due today" : `Bid due in ${dueDays}d`;
  return (
    <li className="relative bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden hover:border-cc-brand-200 hover:shadow-md transition-all">
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${tone.stripe}`} />
      <div className="pl-5 pr-4 py-3.5">
        <div className="flex items-center justify-between gap-2 mb-1">
          {code ? <span className="text-[9.5px] font-mono text-ppp-navy-600 truncate" title="Opportunity ID">{code}</span> : <span />}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide shrink-0 ${tone.pill}`}>
            {oppStatusDisplayLabel(opp.status, opp.sub_status)}
          </span>
        </div>

        <Link href={href} className="block text-[15px] font-bold text-ppp-charcoal hover:text-cc-brand-800 leading-snug break-words">
          {name}
        </Link>
        {location && <div className="mt-0.5 text-[11px] text-ppp-charcoal-500 truncate">{location}</div>}

        {/* Quick KPIs — the numbers Alex scans a pipeline deal by. */}
        <div className="mt-3 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 px-3 py-2.5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Bid range</div>
              <div className="font-condensed text-[15px] font-black text-ppp-charcoal tabular-nums leading-none mt-0.5">{bid}</div>
            </div>
            {/* "Win prob." tile + its bar removed — Brendan: "Probability? I
                don't use this." Weighted stays, because it is a real pipeline
                number; the title says what weights it, since a weighted figure
                with no stated basis is the kind of number people distrust. */}
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Weighted</div>
              <div
                className="font-condensed text-[15px] font-black text-ppp-charcoal tabular-nums leading-none mt-0.5"
                title={`${stageProb}% of value — the standard weighting for ${oppStatusDisplayLabel(opp.status, opp.sub_status)}`}
              >
                {weighted > 0 ? formatCentsCompact(weighted) : "—"}
              </div>
            </div>
          </div>
        </div>

        {dueLabel && (
          <div className={`mt-2 inline-flex items-center gap-1 text-[10.5px] font-semibold ${dueTone}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            {dueLabel}
          </div>
        )}
      </div>
    </li>
  );
}



/**
 * Create an invoice/milestone directly on the deal (Phase 1, Katie: invoices
 * are created under the project). Single line item; bill against an accepted
 * proposal or enter a progress amount. Redirects back to the deal Invoices tab.
 */
function parseDueDate(raw: string): string | undefined {
  const v = raw.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T16:00:00.000Z` : undefined;
}

export async function createDealInvoiceAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account_id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opp_id)) redirect("/commercial/accounts");
  // Return to the surface the builder was opened on — its deal Invoices tab, OR
  // its own page in the Invoices section — so New-invoice from the Invoices list
  // stays in Invoices instead of teleporting to the account (Karan 2026-08).
  // Whitelisted to those two shapes so it can never be an open redirect.
  const dealTab = `/commercial/opportunities/${opp_id}?tab=invoices`;
  const rt = String(formData.get("return_to") ?? "");
  // Return to the DEAL, always.
  //
  // This used to honour a return_to pointing at /commercial/invoices — the
  // standalone index. The restructure moved invoices under the deal and that
  // page was dropped from the sidebar, so it is now unreachable by navigation:
  // creating an invoice and pressing Back was the ONLY way to land on it, and
  // once there you are stranded. Karan hit it in smoke testing 2026-08-14.
  //
  // Whether that index should exist at all is a separate call; until it has a
  // way in, nothing should send anyone to it.
  const back = dealTab;
  void rt;
  const mode = String(formData.get("mode") ?? "flat") === "milestones" ? "milestones" : "flat";

  const taxRaw = String(formData.get("tax_pct") ?? "").trim();
  const taxParsed = taxRaw !== "" ? parseFloat(taxRaw) : NaN;
  const tax_pct = Number.isFinite(taxParsed) && taxParsed >= 0 && taxParsed <= 100 ? taxParsed : undefined;

  // Bill against a proposal (progress billing) — chain-of-trust: it must belong
  // to this deal, else the link is dropped.
  const propRaw = String(formData.get("proposal_id") ?? "").trim();
  let proposal_id: string | null = null;
  let proposal_total_cents_at_bill: number | null = null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propRaw)) {
    const prop = await getProposal(propRaw);
    if (prop && prop.opportunity_id === opp_id) {
      proposal_id = prop.id;
      proposal_total_cents_at_bill = prop.total_cents;
    }
  }

  // Build the line items (+ milestone drafts, if any) that define the invoice.
  let lineItems: Array<{ description: string; quantity: number; unit_price_cents: number }>;
  let milestones: MilestoneDraft[] = [];
  // Which form-row each milestone draft came from — so the ms_waiver_<row> file
  // pairs to the right created milestone even when blank rows are skipped.
  const milestoneRowIndex: number[] = [];
  let invoiceDue: string | undefined;

  if (mode === "milestones") {
    const count = Math.min(50, Math.max(0, parseInt(String(formData.get("ms_count") ?? "0"), 10) || 0));
    for (let i = 0; i < count; i++) {
      const amt = parseDollarsToCents(String(formData.get(`ms_amount_${i}`) ?? ""));
      if (amt === null || amt <= 0) continue; // skip blank rows
      const rawName = String(formData.get(`ms_name_${i}`) ?? "").trim();
      const name = (rawName || `Milestone ${milestones.length + 1}`).slice(0, 200);
      const due = parseDueDate(String(formData.get(`ms_due_${i}`) ?? "")) ?? null;
      milestones.push({ name, amount_cents: amt, due_at: due });
      milestoneRowIndex.push(i);
    }
    if (milestones.length === 0) redirect(`${back}&error=${encodeURIComponent("Add at least one milestone with an amount.")}`);
    lineItems = milestones.map((m) => ({ description: m.name, quantity: 1, unit_price_cents: m.amount_cents }));
    // The invoice's own due date = the earliest milestone due date (if any).
    invoiceDue = milestones
      .map((m) => m.due_at)
      .filter((d): d is string => !!d)
      .sort()[0];
  } else {
    const description = String(formData.get("description") ?? "").trim();
    if (!description) redirect(`${back}&error=${encodeURIComponent("Describe what this invoice bills for.")}`);
    const amount_cents = parseDollarsToCents(String(formData.get("amount") ?? ""));
    if (amount_cents === null || amount_cents <= 0) redirect(`${back}&error=${encodeURIComponent("Enter a valid amount.")}`);
    invoiceDue = parseDueDate(String(formData.get("due_at") ?? ""));
    lineItems = [{ description: description.slice(0, 500), quantity: 1, unit_price_cents: amount_cents }];
  }

  const result = await createCommercialInvoice({
    opportunity_id: opp_id,
    account_id,
    created_by_user_id: user.id,
    tax_pct,
    due_at: invoiceDue,
    proposal_id,
    proposal_total_cents_at_bill,
    line_items: lineItems,
    // Creating from the deal = billing the deal → count it as Invoiced now.
    issue: true,
  });
  if (!result.ok) redirect(`${back}&error=${encodeURIComponent(result.error)}`);
  if (milestones.length > 0) {
    await seedMilestonesFromLineItems(result.invoice.id, milestones);
  }

  // Optional lien waivers attached right on the create form (best-effort — a
  // failed upload never blocks the invoice; the waiver can always be added
  // later from the invoice). Files ride the submit (25 MB server-action cap).
  const readWaiver = async (key: string): Promise<{ name: string; type: string; data: Uint8Array } | null> => {
    const f = formData.get(key);
    if (!(f instanceof File) || f.size === 0) return null;
    if (!["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"].includes(f.type)) return null;
    return { name: f.name || "lien-waiver.pdf", type: f.type, data: new Uint8Array(await f.arrayBuffer()) };
  };
  if (mode === "flat") {
    const w = await readWaiver("flat_waiver");
    if (w) await attachInvoiceLienWaiver({ invoiceId: result.invoice.id, file_name: w.name, mime_type: w.type, data: w.data, actorUserId: user.id }).catch(() => {});
  } else if (milestones.length > 0) {
    // Re-fetch the created milestones (position order == draft order) so each
    // ms_waiver_<row> file pairs to the right milestone.
    const created = await listMilestonesForInvoice(result.invoice.id);
    for (let k = 0; k < created.length && k < milestoneRowIndex.length; k++) {
      const w = await readWaiver(`ms_waiver_${milestoneRowIndex[k]}`);
      if (w) await attachMilestoneLienWaiver({ milestoneId: created[k].id, file_name: w.name, mime_type: w.type, data: w.data, actorUserId: user.id }).catch(() => {});
    }
  }

  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/invoices");
  revalidatePath("/commercial/accounts"); // list AR/tiles (audit 1B #2)
  revalidatePath("/commercial"); // dashboard AR tiles (audit 1B #2)
  redirect(`${back}&created=1`);
}

/** "New invoice for this opportunity" — flat OR milestone-broken, via the client
 *  builder. Invoices are created under the project (Phase 1, Katie). */
export async function DealNewInvoiceForm({ accountId, oppId, propertyZip, proposals, invoices, returnTo }: { accountId: string; oppId: string; propertyZip: string | null; proposals: import("@/lib/commercial/proposals/db").CommercialProposal[]; invoices: CommercialInvoice[]; returnTo?: string }) {
  // Pre-fill the tax rate from the deal's property ZIP (same engine as the
  // global invoices page). Editable on the form + the invoice. A TAX-EXEMPT GC
  // always defaults to 0% — never the ZIP rate (audit 1B: a taxed default on an
  // exempt customer is a silent mis-bill).
  // Resolve through the shared rule so the JOB's override wins — otherwise
  // this form pre-fills the ZIP rate on a job flagged "Exempt - this job only",
  // and the note claims the tax was pre-filled for a jurisdiction while the
  // saved invoice will strip it back to 0%. Two different numbers for the same
  // invoice, seconds apart.
  const [taxAccount, taxOpp] = await Promise.all([
    getCommercialAccount(accountId),
    getCommercialOpportunity(oppId),
  ]);
  const taxResolution = resolveTaxExemption({
    opportunityTaxExempt: taxOpp?.tax_exempt ?? null,
    accountTaxExempt: taxAccount?.tax_exempt ?? null,
  });
  const taxExempt = taxResolution.exempt;
  const taxHit = resolveTaxForZip(propertyZip, await listTaxJurisdictions({ activeOnly: true }));
  const defaultTax = taxExempt ? "0" : taxHit ? thouToPct(taxHit.jurisdiction.combined_rate_thou).toFixed(3).replace(/\.?0+$/, "") : "";
  const wonProposals = proposals.filter((pr) => pr.status === "won" || pr.status === "sent");
  // Already billed (pre-tax) against each proposal across this deal's ISSUED
  // invoices — drafts excluded so "left to bill" ties out with the issued-only
  // Invoiced figure the rollup shows (audit 1B #4).
  const billableInvoices = invoices.filter(
    (inv) => inv.proposal_id && inv.status !== "void" && inv.status !== "draft" && !inv.deleted_at,
  );
  // A change-order line rides in an invoice's subtotal but is scope BEYOND the
  // proposal — counting it as "billed against the proposal" understates what's
  // left (audit F6). Subtract CO-tagged line cents per invoice.
  const coLineCentsByInvoice = await changeOrderLineCentsByInvoice(billableInvoices.map((inv) => inv.id));
  const billedByProposal = new Map<string, number>();
  for (const inv of billableInvoices) {
    const proposalScope = inv.subtotal_cents - (coLineCentsByInvoice.get(inv.id) ?? 0);
    billedByProposal.set(inv.proposal_id!, (billedByProposal.get(inv.proposal_id!) ?? 0) + Math.max(0, proposalScope));
  }
  return (
    <DealInvoiceBuilder
      action={createDealInvoiceAction}
      accountId={accountId}
      oppId={oppId}
      returnTo={returnTo}
      defaultTax={defaultTax}
      taxNote={taxExempt ? (taxResolution.source === "opportunity" ? "This JOB is flagged tax-exempt, so tax defaulted to 0%." : "This customer is flagged tax-exempt, so tax defaulted to 0%. Type a rate here if this job is taxable.") : taxHit ? `Tax pre-filled for ${taxHit.jurisdiction.name} (${propertyZip}). Edit if needed.` : null}
      proposals={wonProposals.map((pr) => {
        const billed = billedByProposal.get(pr.id) ?? 0;
        const remaining = Math.max(0, pr.total_cents - billed);
        return {
          id: pr.id,
          label: `${proposalDisplayId(pr) || `R${pr.revision_number}`} · ${formatCentsFull(pr.total_cents)}${billed > 0 ? ` · ${formatCentsFull(remaining)} left` : ""} · ${pr.status}`,
          totalCents: pr.total_cents,
          remainingCents: remaining,
        };
      })}
    />
  );
}


function monthlyBilledSeries(invoices: { status: string; created_at: string | null; subtotal_cents: number }[]): { label: string; value: number }[] {
  return monthlyBilledSeriesShared(invoices, { months: 6, nowIso: new Date().toISOString() });
}

/** Deal P&L tab — ONE deal's complete financial picture, combined from every
 *  tool (contract = bid + approved COs, billed from invoices/AIA, collected,
 *  costs from purchases). Same getProjectFinancials the Costs tab + portfolio
 *  Revenue page use, so a deal's P&L reconciles at every level. Gross = billed,
 *  Net = billed − costs (Karan's definitions). */
const PNL_COST_TONE: Record<string, ChartTone> = {
  materials: "blue", labor: "brand", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};
// Field-ops crew labor (Option A) — an auto cost source alongside purchases, its
// own donut slice so "where the money goes" shows in-house labor distinctly.
const CREW_LABOR_TONE: ChartTone = "emerald";




async function updateAccountSectionAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const section = String(formData.get("section") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
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
  // Whitelist per section — a stray input outside the current section
  // can't patch unrelated fields even if the form was tampered with.
  type Patch = Parameters<typeof updateCommercialAccount>[1];
  let patch: Patch = {};
  switch (section) {
    case "identity":
      patch = {
        company_name: get("company_name") ?? undefined,
        dba: get("dba"),
        // Not on any form any more, so writing it would blank whatever is
        // stored — the same absent-field-writes-null trap as the dates above.
        website: get("website"),
      };
      break;
    case "billing":
      patch = {
        billing_street: get("billing_street"),
        billing_street2: get("billing_street2"),
        billing_city: get("billing_city"),
        billing_state: get("billing_state"),
        billing_zip: get("billing_zip"),
      };
      break;
    case "site":
      patch = {
        site_street: get("site_street"),
        // Belongs to THIS section. It was added to the billing patch by
        // mistake on 2026-08-13, which broke it both ways: the billing card
        // has no site_street2 input, so saving billing wrote null over the
        // company suite line; and the site card never wrote the field at all,
        // so typing a suite there was silently discarded. Found by the persona
        // audit the same day.
        site_street2: get("site_street2"),
        site_city: get("site_city"),
        site_state: get("site_state"),
        site_zip: get("site_zip"),
      };
      break;
    case "contact":
      patch = {
        phone: get("phone"),
        ap_phone: get("ap_phone"),
      };
      break;
    // Karan 2026-07-10: "compliance" section removed from Accounts UI
    // (Katie/Brendan notes). Case removed — inline card no longer
    // renders, so this branch is unreachable from the UI.
    case "tax":
      patch = {
        tax_exempt: formData.get("tax_exempt") === "on",
        tax_exempt_cert_number: get("tax_exempt_cert_number"),
      };
      break;
    default:
      redirect(`/commercial/accounts/${account_id}?error=${encodeURIComponent("Unknown section.")}`);
  }
  // Company name is required — refuse an empty save on Identity.
  if (section === "identity" && !patch.company_name) {
    redirect(`/commercial/accounts/${account_id}?error=${encodeURIComponent("Company name is required.")}`);
  }
  const result = await updateCommercialAccount(account_id, patch, user.id);
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/accounts");
  // Return the user to the tab they were on, not the default one.
  const returnTab = String(formData.get("return_tab") ?? "").trim();
  const tabQs = returnTab ? `&tab=${encodeURIComponent(returnTab)}` : "";
  redirect(`/commercial/accounts/${account_id}?saved=1${tabQs}#card-${section}`);
}

async function quickFlipFromAccountAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  const rawToStatus = String(formData.get("to_status") ?? "");
  const rawToSubStatus = String(formData.get("to_sub_status") ?? "").trim();
  // This dropdown posts the same VISUAL COLUMN KEYS as the pipeline
  // kanban, so it resolves them the same way — one shared map
  // (lib/commercial/opportunities/kanban-columns) instead of the parallel
  // if-chain that used to live here and drift from the pipeline's copy.
  // `no_bid` is a retired v1 shorthand kept as a Lost alias for any stale
  // form still posting it.
  const rawKey = rawToStatus === "no_bid" ? "lost" : rawToStatus;
  const columnTarget = resolveColumnTarget(rawKey);
  const to_status = columnTarget?.status ?? rawToStatus;
  const to_sub_status: string | undefined =
    rawToSubStatus || columnTarget?.sub_status || undefined;
  const isLostFlip = to_status === "pre_sale_closed" && to_sub_status === "lost";
  const isWonFlip = to_status === "pre_sale_closed" && to_sub_status === "won";
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!UUID_RE.test(opp_id)) redirect(`/commercial/accounts/${account_id}?tab=deals`);
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect(`/commercial/accounts/${account_id}?tab=deals&error=${encodeURIComponent("Invalid status.")}`);
  }
  // Audit fix (IDOR): verify the opp belongs to THIS account. A forged
  // opp_id belonging to a different account would otherwise let a user
  // flip that account's deals from the wrong URL.
  const ownershipCheck = await getCommercialOpportunity(opp_id);
  if (!ownershipCheck || ownershipCheck.account_id !== account_id) {
    redirect(
      `/commercial/accounts/${account_id}?tab=deals&error=${encodeURIComponent("That opportunity doesn't belong to this customer.")}`
    );
  }
  // Lost / No-bid need loss_reason capture — bounce to detail page.
  // Won flips immediately, drops the placeholder auto-note, then routes
  // to the opp page so the DebriefOnlyCard is right there for optional
  // structured-debrief follow-through.
  if (isLostFlip) {
    // Stays in the account. This used to jump to the global opportunity shell
    // with no account context — losing the tab, the scroll position and the
    // deal drawer — for the one outcome that is hardest to record in the first
    // place. The account-scoped page now collects the reason AND performs the
    // close, the same way Won already stays here.
    redirect(`/commercial/accounts/${account_id}/debrief/${opp_id}?close=lost`);
  }
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    to_sub_status,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=deals&error=${encodeURIComponent(result.error)}`);
  }
  if (isWonFlip) {
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({ opportunityId: opp_id, outcome: "won", actorUserId: user.id });
    // Karan 2026-07-13: debrief now lives under the account, not the
    // opportunities detail page. Route Won flips fired from the account
    // page directly to the account-scoped debrief so the user never
    // hops back to the pipeline surface.
    redirect(`/commercial/accounts/${account_id}/debrief/${opp_id}?just_closed=1`);
  }
  // Non-Won flip → land on the deal itself, not the retired opportunities list.
  redirect(`/commercial/opportunities/${opp_id}`);
}

/** Karan 2026-07-08 — inline "+ New opportunity" server action for the Account
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
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");

  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&new_deal=1&error=${encodeURIComponent("Opportunity title is required.")}`);
  }

  const statusRaw = String(formData.get("status") ?? "qualifying").trim();
  const status = (OPPORTUNITY_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as OpportunityStatus)
    : "qualifying";
  // Phase E-4 (2026-07-13): sub_status + follow-up captured on CREATE
  // via the shared picker. Server-side isValidSubStatus enforcement lives
  // in mutations.createCommercialOpportunity, so we forward the raw value.
  const subStatusRaw = String(formData.get("sub_status") ?? "").trim();
  const sub_status = subStatusRaw || null;
  const followUpAtRaw = String(formData.get("follow_up_at") ?? "").trim();
  const follow_up_at = followUpAtRaw && /^\d{4}-\d{2}-\d{2}$/.test(followUpAtRaw)
    ? followUpAtRaw
    : null;
  const followUpNotesRaw = String(formData.get("follow_up_notes") ?? "").trim();
  const follow_up_notes = followUpNotesRaw ? followUpNotesRaw.slice(0, 200) : null;

  const sourceRaw = String(formData.get("source") ?? "").trim();
  const source = (OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as (typeof OPPORTUNITY_SOURCES)[number])
    : null;

  const proposalDueRaw = String(formData.get("proposal_due_at") ?? "").trim();
  const proposal_due_at = proposalDueRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposalDueRaw)
    ? `${proposalDueRaw}T16:00:00.000Z`
    : null;
  // Migration 069 (Katie 2026-07-20) — RFP received. Captured at
  // create-time when the deal originates from a fresh bid request so
  // time-to-proposal starts counting from day 1.
  const rfpReceivedRaw = String(formData.get("rfp_received_at") ?? "").trim();
  // Migration 133 made this a DATE. It is a calendar day — no time to anchor,
  // and no zone to shift it across.
  const rfp_received_at =
    rfpReceivedRaw && /^\d{4}-\d{2}-\d{2}$/.test(rfpReceivedRaw) ? rfpReceivedRaw : null;

  const description = String(formData.get("description") ?? "").trim() || null;
  const property_street = String(formData.get("property_street") ?? "").trim() || null;
  const property_city = String(formData.get("property_city") ?? "").trim() || null;
  const property_state = String(formData.get("property_state") ?? "").trim() || null;
  const property_zip = String(formData.get("property_zip") ?? "").trim() || null;
  // Phase B (Plan v1.1) — CEO structural fields.
  // Phase G Q2 (2026-07-20): location_short retired; property_street is
  // the canonical site address now. Duplicate check keyed on the same.
  const client_name = String(formData.get("client_name") ?? "").trim() || null;
  const estimatorRaw = String(formData.get("estimator_user_id") ?? "").trim();
  const estimator_user_id = estimatorRaw && UUID_RE.test(estimatorRaw) ? estimatorRaw : null;
  // Migration 049 (Karan 2026-07-10) — free-text estimator name for
  // subs/off-roster estimators. The mutation clears this if
  // estimator_user_id is set, so no dueling-writes concern here.
  const estimator_name_raw = String(formData.get("estimator_name") ?? "").trim();
  const estimator_name = estimator_name_raw ? estimator_name_raw.slice(0, 120) : null;

  // Karan 2026-07-08: capture proposed_start / proposed_end / probability
  // override on create so the user doesn't have to bounce through the
  // Edit form after logging a deal that already has a signed schedule.
  // A field that is NOT ON THE FORM must not be written. `formData.get`
  // returns null when a field is absent and "" when it is present-but-empty —
  // collapsing both to null is what turned "I removed the input" into "every
  // save wipes the stored value". Caught by the parallel session, and it was
  // mine: I removed these inputs for Brendan and left the action writing them.
  //
  // `undefined` reaches updateCommercialOpportunity as "don't touch".
  const proposedStartField = formData.get("proposed_start_at");
  const proposedStartRaw = String(proposedStartField ?? "").trim();
  const proposed_start_at =
    proposedStartField === null
      ? undefined
      : proposedStartRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedStartRaw)
        ? `${proposedStartRaw}T09:00:00.000Z`
        : null;
  const proposedEndField = formData.get("proposed_end_at");
  const proposedEndRaw = String(proposedEndField ?? "").trim();
  const proposed_end_at =
    proposedEndField === null
      ? undefined
      : proposedEndRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedEndRaw)
        ? `${proposedEndRaw}T17:00:00.000Z`
        : null;
  // Same trap: the Probability input came out for Brendan, so an absent field
  // would have reset every deal's probability to null on save — and the
  // forecast on the dashboard reads it.
  const probField = formData.get("probability_pct");
  const probRaw = String(probField ?? "").trim();
  const probParsed = probRaw ? Number(probRaw) : NaN;
  const probability_pct =
    probField === null
      ? undefined
      : Number.isFinite(probParsed) && probParsed >= 0 && probParsed <= 100
        ? Math.round(probParsed)
        : null;

  // Duplicate check (Phase B). Skipped when the user submits with the
  // hidden `confirm_duplicate=1` field from the "Create anyway" button.
  // Phase G Q2: keyed on property_street now (was location_short).
  const forceCreate = String(formData.get("confirm_duplicate") ?? "") === "1";
  if (!forceCreate && client_name && property_street) {
    const dups = await findDuplicateOpportunities({
      accountId: account_id,
      clientName: client_name,
      propertyStreet: property_street,
    });
    if (dups.length > 0) {
      const first = dups[0];
      const label = formatOpportunityNumber(first.project_number) || first.title;
      // Carry the typed values back. The redirect used to send only dup_id, so
      // the form re-rendered from account defaults and everything the user had
      // entered — title, address, notes, source, dates — was gone. "Create
      // anyway" then meant "retype the whole form", which is a strong nudge to
      // just not report the duplicate.
      const keep = new URLSearchParams();
      for (const [k, field] of [
        ["d_title", "title"],
        ["d_client", "client_name"],
        ["d_street", "property_street"],
        ["d_city", "property_city"],
        ["d_state", "property_state"],
        ["d_zip", "property_zip"],
        ["d_desc", "description"],
        ["d_source", "source"],
        ["d_due", "proposal_due_at"],
        ["d_rfp", "rfp_received_at"],
        ["d_contact", "primary_contact_id"],
        ["d_team", "team_id"],
      ] as const) {
        const v = String(formData.get(field) ?? "").trim();
        if (v) keep.set(k, v.slice(0, 300));
      }
      redirect(
        `/commercial/accounts/${account_id}?tab=opportunities&new_deal=1&dup_id=${first.id}&dup_label=${encodeURIComponent(label)}&${keep.toString()}#new-deal`
      );
    }
  }

  // Katie gap #1 — Attention contact. Blank/unrecognized → leave unset so the
  // create mutation auto-inherits the GC's default primary. A valid pick MUST
  // belong to this GC (a forged id is ignored, not smuggled in).
  const contactRaw = String(formData.get("primary_contact_id") ?? "").trim();
  let primary_contact_id: string | undefined = undefined;
  if (contactRaw !== "" && UUID_RE.test(contactRaw)) {
    const accountContacts = await listAccountContacts(account_id);
    if (accountContacts.some((r) => r.contact.id === contactRaw)) primary_contact_id = contactRaw;
  }
  // Team on the deal (meeting 2026-08) — "" = none. Validated live in the mutation.
  const teamRaw = String(formData.get("team_id") ?? "").trim();
  const team_id = teamRaw && UUID_RE.test(teamRaw) ? teamRaw : null;

  // The form renders a "Project nickname" input posting title_override, and
  // this action never read it — so the nickname was accepted and thrown away.
  // It matters more than a label: title_override is what wins on the proposal
  // PDF's PROJECT line and on the project card.
  const nicknameRaw = String(formData.get("title_override") ?? "").trim();

  const result = await createCommercialOpportunity({
    account_id,
    title,
    title_override: nicknameRaw ? nicknameRaw.slice(0, 200) : null,
    status,
    sub_status,
    follow_up_at,
    follow_up_notes,
    source,
    proposal_due_at,
    proposed_start_at,
    proposed_end_at,
    probability_pct,
    description,
    property_street,
    property_city,
    property_state,
    property_zip,
    client_name,
    estimator_user_id,
    estimator_name,
    rfp_received_at,
    primary_contact_id,
    team_id,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&new_deal=1&error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  void result.opportunity.title;
  // B1 (Katie 2026-08): land on the new deal's drill-in with a distinct
  // deal-created flash (NOT `created=1`, which the Invoices sub-tab reads as
  // "Invoice created"). The drill-in Overview now shows the bid fields entered.
  redirect(`/commercial/opportunities/${result.opportunity.id}?deal_created=1`);
}

/**
 * Karan 2026-07-08: edit a deal from the account-page slide-out sheet.
 * Same field set as the standalone /commercial/opportunities/[id]/edit
 * page (title, source, bid range, probability, all four date fields,
 * description, project address override). On save the sheet closes
 * (drops ?edit=) and the user lands back on the Deals tab with a
 * green "Saved" flash. Cross-account defense: the deal is re-fetched
 * from the mutation lib, and we validate account_id in the redirect.
 */
async function editDealFromAccountAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!UUID_RE.test(opp_id)) redirect(`/commercial/accounts/${account_id}?tab=deals`);
  const back = `/commercial/accounts/${account_id}?tab=opportunities&edit=${opp_id}`;

  const title = String(formData.get("title") ?? "").trim();
  if (!title) redirect(`${back}&error=${encodeURIComponent("Title is required.")}#deal-edit-sheet`);

  const sourceRaw = String(formData.get("source") ?? "").trim();
  const source = sourceRaw && (OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as (typeof OPPORTUNITY_SOURCES)[number])
    : null;

  // Bid low/high parsing removed with the fields (2026-08 meeting — pricing
  // lives on the proposal). The patch simply omits them now, so an existing
  // range on a legacy deal is left untouched rather than being cleared by
  // every save. (updateCommercialOpportunity maps null -> undefined anyway,
  // so this was already a no-op; the code was just misleading.)

  const probRaw = String(formData.get("probability_pct") ?? "").trim();
  let probability_pct: number | null | undefined = undefined;
  if (probRaw !== "") {
    const p = Number(probRaw);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      redirect(`${back}&error=${encodeURIComponent("Probability must be a number 0-100.")}#deal-edit-sheet`);
    }
    probability_pct = Math.round(p);
  }

  const proposalDueRaw = String(formData.get("proposal_due_at") ?? "").trim();
  const proposal_due_at = proposalDueRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposalDueRaw)
    ? `${proposalDueRaw}T16:00:00.000Z`
    : null;
  // A field that is NOT ON THE FORM must not be written. `formData.get`
  // returns null when a field is absent and "" when it is present-but-empty —
  // collapsing both to null is what turned "I removed the input" into "every
  // save wipes the stored value". Caught by the parallel session, and it was
  // mine: I removed these inputs for Brendan and left the action writing them.
  //
  // `undefined` reaches updateCommercialOpportunity as "don't touch".
  const proposedStartField = formData.get("proposed_start_at");
  const proposedStartRaw = String(proposedStartField ?? "").trim();
  const proposed_start_at =
    proposedStartField === null
      ? undefined
      : proposedStartRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedStartRaw)
        ? `${proposedStartRaw}T09:00:00.000Z`
        : null;
  const proposedEndField = formData.get("proposed_end_at");
  const proposedEndRaw = String(proposedEndField ?? "").trim();
  const proposed_end_at =
    proposedEndField === null
      ? undefined
      : proposedEndRaw && /^\d{4}-\d{2}-\d{2}$/.test(proposedEndRaw)
        ? `${proposedEndRaw}T17:00:00.000Z`
        : null;
  // Migration 069 — RFP arrival date. Anchor at noon UTC so the ET
  // display doesn't drift a day either side of the date line.
  const rfpReceivedRaw = String(formData.get("rfp_received_at") ?? "").trim();
  // Migration 133 made this a DATE. It is a calendar day — no time to anchor,
  // and no zone to shift it across.
  const rfp_received_at =
    rfpReceivedRaw && /^\d{4}-\d{2}-\d{2}$/.test(rfpReceivedRaw) ? rfpReceivedRaw : null;

  const description = String(formData.get("description") ?? "").trim() || null;
  const property_street = String(formData.get("property_street") ?? "").trim() || null;
  const property_city = String(formData.get("property_city") ?? "").trim() || null;
  const property_state = String(formData.get("property_state") ?? "").trim() || null;
  const property_zip = String(formData.get("property_zip") ?? "").trim() || null;
  // Phase B (Plan v1.1) — CEO structural fields.
  // Phase G Q2 (2026-07-20): location_short retired; property_street is canonical.
  const client_name = String(formData.get("client_name") ?? "").trim() || null;
  const estimatorSheetRaw = String(formData.get("estimator_user_id") ?? "").trim();
  const estimator_user_id = estimatorSheetRaw && UUID_RE.test(estimatorSheetRaw) ? estimatorSheetRaw : null;
  // Migration 049 — free-text estimator name (see createDealInlineAction).
  const estimatorNameSheetRaw = String(formData.get("estimator_name") ?? "").trim();
  const estimator_name = estimatorNameSheetRaw ? estimatorNameSheetRaw.slice(0, 120) : null;
  // Migration 069 — user-supplied custom display name. Blank = clear.
  const titleOverrideRaw = String(formData.get("title_override") ?? "").trim();
  const title_override = titleOverrideRaw ? titleOverrideRaw.slice(0, 200) : null;

  // Katie gap #1 — Attention contact. Empty = clear. A non-empty value MUST be
  // one of THIS GC's contacts (a forged POST can't smuggle another account's
  // contact PII into the proposal); an unrecognized value is left untouched
  // (undefined) so a dangling "removed but still assigned" reference survives.
  const contactRaw = String(formData.get("primary_contact_id") ?? "").trim();
  let primary_contact_id: string | null | undefined = undefined;
  if (contactRaw === "") {
    primary_contact_id = null;
  } else if (UUID_RE.test(contactRaw)) {
    const accountContacts = await listAccountContacts(account_id);
    if (accountContacts.some((r) => r.contact.id === contactRaw)) primary_contact_id = contactRaw;
  }

  const result = await updateCommercialOpportunity({
    id: opp_id,
    title,
    source,
    primary_contact_id,
    probability_pct,
    proposal_due_at,
    proposed_start_at,
    proposed_end_at,
    rfp_received_at,
    description,
    property_street,
    property_city,
    property_state,
    property_zip,
    client_name,
    estimator_user_id,
    estimator_name,
    title_override,
    updated_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`${back}&error=${encodeURIComponent(result.error)}#deal-edit-sheet`);
  }
  // Cross-account sanity: the updated row's account_id MUST equal the
  // form-posted account_id. If not, someone posted a smuggled opp_id
  // from a different customer's page — bounce with a generic error.
  if (result.opportunity.account_id !== account_id) {
    redirect(`/commercial/accounts?error=${encodeURIComponent("Opportunity moved. Refresh the page.")}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  // Success — drop ?edit= so the sheet closes + land on Deals tab with
  // the saved flash. User never leaves the account context.
  // Came from the deal page? Go back to the deal. Otherwise the account's
  // Deals tab, as before.
  if (String(formData.get("deal_back") ?? "") === "1") {
    redirect(`/commercial/opportunities/${opp_id}?tab=info&saved=1`);
  }
  redirect(`/commercial/accounts/${account_id}?tab=deals&saved=1`);
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
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  const confirm = formData.get("confirm") === "yes";
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!UUID_RE.test(opp_id)) redirect(`/commercial/accounts/${account_id}?tab=deals`);
  if (!confirm) {
    // Karan 2026-07-10 audit fix (P3): use ?edit= not ?deal= so the
    // DealEditSheet reopens with the error banner visible. The tab
    // only listens to ?edit= for sheet-open state.
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&edit=${opp_id}&error=${encodeURIComponent("Confirmation required to delete.")}#deal-edit-sheet`);
  }
  // Peek the title BEFORE deleting so we can surface it in the toast.
  // Lazy import to keep the top-of-module bundle lean (this action fires
  // once per manual delete, not on every account-page render).
  const { commercialDb: _cdb } = await import("@/lib/commercial/db");
  const sb = _cdb();
  // Phase B: pull structural fields + account name so the toast shows
  // the CEO's derived name ({account} - {client} - {location}) instead
  // of just the raw title. Falls back to the raw title if any piece
  // is missing.
  const { data: pre } = await sb
    .from("commercial_opportunities")
    .select("title, account_id, client_name, property_street")
    .eq("id", opp_id)
    .eq("account_id", account_id)
    .maybeSingle();
  if (!pre) {
    redirect(`/commercial/accounts/${account_id}?tab=deals&error=${encodeURIComponent("Opportunity not found on this account.")}`);
  }
  const preRow = pre as { title?: string; client_name?: string | null; property_street?: string | null };
  const { data: preAcct } = await sb
    .from("commercial_accounts")
    .select("company_name")
    .eq("id", account_id)
    .maybeSingle();
  const acctName = (preAcct as { company_name?: string | null } | null)?.company_name ?? null;
  const title = derivedOppName(
    {
      title: preRow.title || "Opportunity",
      client_name: preRow.client_name ?? null,
      property_street: preRow.property_street ?? null,
    },
    acctName,
  );
  const result = await softDeleteCommercialOpportunity(opp_id, user.id);
  if (!result.ok) {
    // Karan 2026-07-10 audit fix (P3): reopen the sheet with the error
    // banner rather than dumping the user to the tab list. Uses ?edit=.
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&edit=${opp_id}&error=${encodeURIComponent(result.error)}#deal-edit-sheet`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/opportunities");
  revalidatePath("/commercial");
  // Karan 2026-07-11 (signature-moments): pass undo params so the
  // client-side UndoToast (mounted in the commercial layout) shows a
  // 5-second Undo button that POSTs to /api/commercial/opportunities/
  // <id>/restore. Fire-and-forget — the existing ?deleted=<title>
  // flash is kept for continuity (the pipeline tab reads it), and the
  // undo params live alongside it.
  redirect(
    `/commercial/accounts/${account_id}?tab=deals&deleted=${encodeURIComponent(title)}&undo_id=${opp_id}&undo_kind=deal&undo_label=${encodeURIComponent(title)}`
  );
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
/**
 * Karan 2026-07-15: bulk-delete every DRAFT proposal for this account.
 * Sent / Won / Lost / Replaced proposals are LEGAL HISTORY — the lib
 * skips them and the button copy tells Alex how many will be spared.
 */
async function bulkDeleteAllProposalsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const confirm = formData.get("confirm") === "yes";
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  if (!confirm) {
    redirect(
      `/commercial/accounts/${account_id}?tab=proposals&error=${encodeURIComponent("Confirmation required to delete all proposal drafts.")}`
    );
  }
  const { bulkDeleteProposalDraftsForAccount } = await import(
    "@/lib/commercial/proposals/db"
  );
  const result = await bulkDeleteProposalDraftsForAccount(account_id, user.id);
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${account_id}?tab=proposals&error=${encodeURIComponent(result.error)}`
    );
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  redirect(
    `/commercial/accounts/${account_id}?tab=proposals&bulk_deleted=${result.deletedCount}&bulk_skipped=${result.skippedNonDraftCount}`
  );
}

async function recordPaymentInlineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const invoice_id = String(formData.get("invoice_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const returnUrl = `/commercial/accounts/${account_id}?tab=invoices`;
  if (!UUID_RE.test(invoice_id)) redirect(`${returnUrl}&error=${encodeURIComponent("Invalid invoice.")}`);
  // Milestone invoices are normally paid per-milestone, but we never reject a
  // stale invoice-level post (Karan rule) — addPayment records it invoice-level
  // and returns a warning we surface as a small heads-up.
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const cents = parseDollarsToCents(amountRaw);
  if (cents === null || cents <= 0) {
    redirect(`${returnUrl}&error=${encodeURIComponent("Enter a positive dollar amount (e.g., 250.00).")}#inv-${invoice_id}`);
  }
  const paidAtRaw = String(formData.get("paid_at") ?? "").trim();
  // Anchor a picked date at noon ET (shared helper); empty/malformed → now.
  // Was T12 here vs T16 everywhere else — standardized (2026-08 cleanup).
  const paid_at = anchorDateOnlyIso(paidAtRaw) ?? new Date().toISOString();
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
  const headsUpMsg = result.warning ? `&heads_up=${encodeURIComponent(result.warning)}` : "";
  redirect(`${returnUrl}&payment_ok=1${cappedMsg}${headsUpMsg}#inv-${invoice_id}`);
}

async function addTagAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
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
  await assertCommercialAccess(user.id);
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
  const [tags, allTags] = await Promise.all([
    listAccountTags(account.id),
    listAllDistinctTags(),
  ]);
  // Filter suggestions to tags NOT already on this account (case-
  // insensitive) — saves the picker from showing dupes.
  const existingLower = new Set(tags.map((t) => t.tag.toLowerCase()));
  const suggestions = allTags.filter((s) => !existingLower.has(s.toLowerCase()));
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
      {/* Karan 2026-07-09 Phase A: ComplianceChecklistCard + KeyDatesCard
          removed per post-meeting notes. Compliance surfaces move to the
          Documents scope (per Opportunity / per Project) in Phase C. The
          underlying account columns remain in the DB behind an admin flag
          for safety-rollback. */}
      <InfoCards account={account} />
    </div>
  );
}

/** Recent Activity card — chronological feed of opp events for this
 *  account. Quiet when the account has no opps or no events yet. */
function RecentActivityCard({
  entries,
  className,
  accountId,
  scope = "account",
}: {
  entries: import("@/lib/commercial/accounts/recent-activity").AccountActivityEntry[];
  className?: string;
  /** When set, each entry links to the account-folded deal view instead of the
   *  standalone global opportunity page (keeps the restructure's IA intact). */
  accountId?: string;
  /** "deal" → the feed is one deal; "account" → across all the account's deals.
   *  Drives the header caption independent of how many entries are present. */
  scope?: "deal" | "account";
}) {
  if (entries.length === 0) {
    // Hide entirely on quiet accounts — better than rendering a blank
    // card. The Opportunities tab + KPI strip already communicate
    // "nothing happening here."
    return null;
  }
  return (
    <section className={`bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden ${className ?? ""}`}>
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ppp-charcoal">Recent activity</h2>
        <span className="text-[11px] text-ppp-charcoal-500">
          {scope === "deal" ? "This opportunity" : "Across this account's opportunities"}
        </span>
      </div>
      <ol className="divide-y divide-ppp-charcoal-100">
        {entries.map((entry) => {
          const when = new Date(entry.occurred_at);
          // Karan 2026-07-20 UI/UX pass: replaced emoji glyphs
          // (→ / ✓ / 📝) with SVG icons for consistent line-weight +
          // color inheritance. Emojis rendered differently across OSes
          // and clashed with the design-system stroke icons elsewhere.
          const iconCls =
            entry.kind === "status_change"
              ? "bg-cc-brand-100 text-cc-brand-700"
              : entry.kind === "task_completed"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-ppp-charcoal-100 text-ppp-charcoal-700";
          const icon =
            entry.kind === "status_change" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14 M13 6l6 6-6 6" />
              </svg>
            ) : entry.kind === "task_completed" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            );
          return (
            <li key={entry.id} className="px-4 py-3 flex items-start gap-3">
              <span
                className={`flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full ${iconCls}`}
                aria-hidden
              >
                {icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ppp-charcoal flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{describeActivity(entry)}</span>
                  <span className="text-ppp-charcoal-400">on</span>
                  <Link
                    href={accountId ? `/commercial/opportunities/${entry.opportunity_id}` : `/commercial/opportunities/${entry.opportunity_id}`}
                    className="text-cc-brand-700 hover:text-cc-brand-800 underline break-words"
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
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-10 text-center">
        <div className="text-sm font-semibold text-ppp-charcoal mb-1">No activity yet</div>
        <p className="text-[12px] text-ppp-charcoal-500 max-w-md mx-auto leading-relaxed">
          Status changes, notes, and completed tasks on this account&apos;s deals show up here as a chronological feed.
        </p>
      </div>
    );
  }
  return <RecentActivityCard entries={activity} accountId={accountId} scope="account" />;
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
    <section className={`bg-surface border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
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
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[12px] font-medium border bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
            >
              {t.tag}
              <form action={removeTagAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="tag_id" value={t.id} />
                <SubmitButton
                  aria-label={`Remove ${t.tag}`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-cc-brand-700/60 hover:text-cc-brand-800 touch-manipulation"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18"/></svg>
                </SubmitButton>
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
          <label htmlFor="new_tag" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
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
        <SubmitButton
          className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] shrink-0"
        >
          Add
        </SubmitButton>
      </form>
    </section>
  );
}

function InfoCards({ account }: { account: CommercialAccount }) {
  // Karan 2026-07-08: EVERY card is now inline-editable. Each Card
  // renders its own tiny form scoped to that section. Fields look
  // like text until focused, then reveal a subtle border. Save button
  // sits at the bottom of each card. Notes stays on the /edit page
  // (long-form, doesn't fit the inline pattern well).
  return (
    <>
      <Card title="Company" section="identity" accountId={account.id}>
        <EditableField name="company_name" label="Company name" defaultValue={account.company_name} required />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <EditableField name="dba" label="DBA" defaultValue={account.dba} placeholder="Doing business as…" />
          {/* Industry removed 2026-08-12 — Brendan: "We don't need Industry on
              accounts." The column stays so nothing already typed is lost; it
              is simply no longer asked for, shown or filtered on. */}
        </div>
        <EditableField name="website" label="Website" defaultValue={account.website} type="url" placeholder="https://…" />
      </Card>

      <Card title="Billing address" section="billing" accountId={account.id}>
        <EditableField name="billing_street" label="Street" defaultValue={account.billing_street} />
        <EditableField name="billing_street2" label="Floor / unit / suite" defaultValue={account.billing_street2} />
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-6">
            <EditableField name="billing_city" label="City" defaultValue={account.billing_city} />
          </div>
          <div className="sm:col-span-3">
            <EditableField name="billing_state" label="State" defaultValue={account.billing_state} placeholder="NY" />
          </div>
          <div className="sm:col-span-3">
            <EditableField name="billing_zip" label="ZIP" defaultValue={account.billing_zip} placeholder="11746" />
          </div>
        </div>
      </Card>

      <Card title="Company address" section="site" accountId={account.id}>
        <EditableField name="site_street" label="Street" defaultValue={account.site_street} />
        <EditableField name="site_street2" label="Floor / unit / suite" defaultValue={account.site_street2} />
        {/* Responsive like the billing block above — grid-cols-3 crushed
            City to ~90px at 320px. City spans 6, State/ZIP 3 each on sm+. */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-6"><EditableField name="site_city" label="City" defaultValue={account.site_city} /></div>
          <div className="sm:col-span-3"><EditableField name="site_state" label="State" defaultValue={account.site_state} /></div>
          <div className="sm:col-span-3"><EditableField name="site_zip" label="ZIP" defaultValue={account.site_zip} /></div>
        </div>
      </Card>

      <Card title="Contact" section="contact" accountId={account.id}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <EditableField name="phone" label="Main phone" defaultValue={account.phone} type="tel" placeholder="(555) 555-1234" />
          <EditableField name="ap_phone" label="Accounts Payable phone" defaultValue={account.ap_phone} type="tel" placeholder="(555) 555-9876" />
        </div>
      </Card>

      {/* Karan 2026-07-10 (Katie/Brendan notes): Compliance card removed
          from account Overview. Compliance now lives per-Opportunity —
          upload COI + prequal certs as Files (category "Insurance") on
          the opp detail. DB columns preserved for audit trail. */}

      {/* Tax-exemption card removed per the 2026-08 meeting ("No tax exemption
          on the Account page") — exemption is decided per JOB, from the
          property's ZIP jurisdiction, not held as a customer-level flag. The
          create and edit forms dropped it then; this card was missed, so the
          field was still editable here — i.e. the setting Karan asked us to
          remove was still on the page he was looking at.
          DB columns preserved for audit trail; nothing reads them for tax
          maths (Settings → Sales tax by ZIP owns that). */}

      {account.notes && (
        <Card title="Notes" className="lg:col-span-2">
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">{account.notes}</p>
          <Link
            href={`/commercial/accounts/${account.id}/edit#edit-notes`}
            className="inline-flex items-center gap-0.5 mt-3 text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 hover:underline underline-offset-2"
          >
            Edit notes
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Link>
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
  await assertCommercialAccess(user.id);

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
  await assertCommercialAccess(user.id);
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
  await assertCommercialAccess(user.id);
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

/**
 * Katie 2026-08-13: there was no way to edit a contact once created — a typo in
 * a GC's name meant detaching and re-adding, which loses the row's history and
 * its links. Edits the PERSON; role and default-for live on the join row and
 * have their own controls.
 */
async function editContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const account_id = String(formData.get("account_id") ?? "");
  const contact_id = String(formData.get("contact_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(contact_id)) {
    redirect("/commercial/accounts");
  }
  const { updateAccountContact } = await import("@/lib/commercial/accounts/contacts");
  const res = await updateAccountContact({
    contact_id,
    full_name: String(formData.get("full_name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    title: String(formData.get("title") ?? ""),
    actor_user_id: user.id,
  });
  if (!res.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=contacts&error=${encodeURIComponent(res.error)}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  redirect(`/commercial/accounts/${account_id}?tab=contacts`);
}

async function detachContactAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

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
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal">Add contact</h2>
        <p className="text-[11.5px] text-ppp-charcoal-500 mb-3 mt-0.5 leading-snug">
          People at the <strong>account&apos;s (GC) company</strong> — decision-maker, PM, estimator, AP contact, etc.
          For our own staff on this customer, use{" "}
          <Link href={`/commercial/accounts/${accountId}?tab=team`} className="font-semibold text-cc-brand-700 hover:underline">
            Team
          </Link>
          .
        </p>
        <form action={addContactAction} className="space-y-3">
          <input type="hidden" name="account_id" value={accountId} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ContactInput id="full_name" label="Name *" required />
            <ContactInput id="title" label="Title" placeholder="VP Facilities, Property Mgr…" />
            <ContactInput id="email" label="Email" type="email" />
            <ContactInput id="phone" label="Phone" type="tel" />
          </div>
          <div>
            <label htmlFor="role" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
              Role
            </label>
            <select
              id="role"
              name="role"
              defaultValue="decision_maker"
              className={`${SELECT_CLS} sm:w-auto`}
              style={SELECT_BG_STYLE}
            >
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="contact_notes" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
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
            <SubmitButton
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
            >
              Add contact
            </SubmitButton>
          </div>
        </form>
      </section>

      {/* Existing contacts */}
      {contacts.length === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No contacts yet. Add the decision-maker, estimator, PM, or anyone else from the account (GC) side.
        </div>
      ) : (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
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
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z" /></svg>
              Primary
            </span>
          )}
        </div>
        {contact.title && (
          <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{contact.title}</div>
        )}
        <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="inline-flex items-center min-h-[44px] text-cc-brand-700 hover:text-cc-brand-800 break-all">
              {contact.email}
            </a>
          )}
          {contact.phone && (
            // Strip formatting from the tel: target so "(555) 123-4567" dials
            // correctly (matches the hero); keep the pretty text for display.
            <a href={`tel:${contact.phone.replace(/[^0-9+]/g, "")}`} className="inline-flex items-center min-h-[44px] text-ppp-charcoal-700 hover:text-ppp-charcoal">
              {contact.phone}
            </a>
          )}
          {touchedDisplay && (
            <span className="text-ppp-charcoal-500">Last touched {touchedDisplay}</span>
          )}
        </div>

        {/* Katie 2026-08-13: "after creating a Contact, we should be able to
            Edit the Contact." A <details> so it costs no JS and stays closed
            until wanted — the row is for reading, and an always-open form on
            every contact would bury the list it belongs to. */}
        <details className="mt-2 group/edit">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1 text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[28px]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            Edit contact
          </summary>
          <form action={editContactAction} className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl">
            <input type="hidden" name="account_id" value={accountId} />
            <input type="hidden" name="contact_id" value={contact.id} />
            <label className="block">
              <span className={LABEL_CLS}>Name</span>
              <input name="full_name" defaultValue={contact.full_name} required maxLength={160} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Title</span>
              <input name="title" defaultValue={contact.title ?? ""} maxLength={120} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Email</span>
              <input name="email" type="email" defaultValue={contact.email ?? ""} maxLength={200} className={INPUT_CLS} />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Phone</span>
              <input name="phone" type="tel" defaultValue={contact.phone ?? ""} maxLength={60} className={INPUT_CLS} />
            </label>
            <div className="sm:col-span-2">
              <SubmitButton
                pendingLabel="Saving…"
                className="inline-flex items-center px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-bold hover:bg-cc-brand-700 min-h-[44px]"
              >
                Save contact
              </SubmitButton>
            </div>
          </form>
        </details>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.account_contact_id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
              title={a.notes ?? undefined}
            >
              {roleLabel(a.role)}
              <form action={detachContactAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="account_contact_id" value={a.account_contact_id} />
                <SubmitButton
                  aria-label={`Remove ${roleLabel(a.role)} role`}
                  className="-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-cc-brand-700/80 hover:text-cc-brand-800 touch-manipulation"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18"/></svg>
                </SubmitButton>
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
              <SubmitButton
                className="text-[11px] text-ppp-charcoal-500 hover:text-amber-700 underline underline-offset-2 touch-manipulation min-h-[44px] px-1 inline-flex items-center"
              >
                {primaryAttachment ? "Unstar primary" : "Mark as primary"}
              </SubmitButton>
            </form>
            <form action={touchContactAction} className="inline">
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="account_contact_id" value={attachments[0].account_contact_id} />
              <SubmitButton
                className="text-[11px] text-ppp-charcoal-500 hover:text-cc-brand-700 underline underline-offset-2 touch-manipulation min-h-[44px] px-1 inline-flex items-center"
                title="Record that you just emailed or called this contact"
              >
                I just touched base
              </SubmitButton>
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
  return relativeAgoEt(iso, "just now");
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
      <label htmlFor={id} className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
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
  await assertCommercialAccess(user.id);

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

/**
 * Karan 2026-07-08: add by email variant. Mirrors the on-create picker
 * — looks up the profile row by email, auto-grants Commercial CC
 * access if missing (admin already said "add this person"), then
 * fires the same addAssignment call so the email notification goes
 * out identically.
 */
async function addAssignmentByEmailAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const rawEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent("Enter a valid email.")}`);
  }
  const role = String(formData.get("role") ?? "other") as AssignmentRole;
  const is_primary = formData.get("is_primary") === "on";
  const notes = (formData.get("notes") as string) || null;
  const { commercialDb } = await import("@/lib/commercial/db");
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("user_id, is_active, has_new_platform_access")
    .ilike("email", rawEmail)
    .maybeSingle();
  if (!profile) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(`${rawEmail} isn't in profiles yet — they need to sign in to PPP Command Center once first, then come back.`)}`);
  }
  const p = profile as { user_id: string; is_active: boolean | null; has_new_platform_access: boolean | null };
  if (p.is_active === false) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(`${rawEmail}'s account is inactive.`)}`);
  }
  // Security (2026-08 sweep): do NOT auto-grant commercial platform access as a
  // side-effect of adding a team member — that let any non-admin commercial user
  // provision arbitrary accounts, unaudited. Granting access is admin-only and
  // lives at Settings → Access (audited via access_audit). Here we only surface
  // a clear next step; addAssignment also refuses an assignee without the flag.
  if (!p.has_new_platform_access) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(`${rawEmail} doesn't have Commercial access yet — an admin has to grant it at Settings → Access first, then you can add them here.`)}`);
  }
  const result = await addAssignment({
    account_id,
    user_id: p.user_id,
    role,
    is_primary,
    notes,
    assigned_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath(`/commercial/accounts/${account_id}`);
  redirect(`/commercial/accounts/${account_id}?tab=team&team_added=1`);
}

async function removeAssignmentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

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

async function assignTeamAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const teamRaw = String(formData.get("team_id") ?? "").trim();
  const teamId = teamRaw && UUID_RE.test(teamRaw) ? teamRaw : null; // "" clears it
  const res = await setOwnerTeam("account", account_id, teamId, user.id);
  revalidatePath(`/commercial/accounts/${account_id}`);
  if (!res.ok) {
    redirect(`/commercial/accounts/${account_id}?tab=team&error=${encodeURIComponent(res.error)}`);
  }
  // Small, honest heads-up about what applying the team actually did — the
  // members are now real role assignments, and any member we couldn't assign
  // (deactivated, no platform access) is named rather than silently dropped.
  const ap = res.applied;
  let note = "";
  if (ap && (ap.added > 0 || ap.skipped.length > 0)) {
    const bits: string[] = [];
    if (ap.added > 0) bits.push(`Added ${ap.added} team member${ap.added === 1 ? "" : "s"} to this customer`);
    if (ap.alreadyThere > 0) bits.push(`${ap.alreadyThere} already assigned`);
    if (ap.skipped.length > 0) bits.push(`couldn't add ${ap.skipped.join(", ")}`);
    note = `&team_applied=${encodeURIComponent(bits.join(" · "))}`;
  }
  redirect(`/commercial/accounts/${account_id}?tab=team${note}`);
}

async function TeamTab({
  accountId,
  errorMessage,
  appliedNote,
}: {
  accountId: string;
  errorMessage?: string;
  /** What assigning a team just did, e.g. "Added 4 team members to this
   *  customer". Rendered as a quiet confirmation strip, not a banner. */
  appliedNote?: string;
}) {
  const [team, assignableStaff, allPppEmails, allTeams, account] = await Promise.all([
    listAccountTeam(accountId),
    listAssignableStaff(),
    listAllPppProfileEmails(),
    listTeams(),
    getCommercialAccount(accountId),
  ]);
  const assignedTeam = await getOwnerTeam(account?.team_id ?? null);
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
      {appliedNote && (
        <p className="text-[12px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {appliedNote}
        </p>
      )}

      {/* Assigned team (Karan meeting 2026-08) — apply a whole preset team by
          name; the individual roles below still work as per-account overrides. */}
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-ppp-charcoal">Assigned team</h3>
            {assignedTeam ? (
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 break-words"><span className="font-semibold text-ppp-charcoal">{assignedTeam.name}</span> · {assignedTeam.members.length} member{assignedTeam.members.length === 1 ? "" : "s"}{assignedTeam.members.length ? ` — ${assignedTeam.members.map((m) => m.name).join(", ")}` : ""}</p>
            ) : (
              <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">No team assigned. Pick one to apply a whole crew at once.</p>
            )}
          </div>
          <form action={assignTeamAction} className="flex items-end gap-2 shrink-0">
            <input type="hidden" name="account_id" value={accountId} />
            <select name="team_id" defaultValue={account?.team_id ?? ""} className={`${SELECT_CLS} w-[200px]`} style={SELECT_BG_STYLE}>
              <option value="">— No team —</option>
              {allTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <SubmitButton
              className="px-3 min-h-[44px] rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700"
            >Set</SubmitButton>
          </form>
        </div>
        {allTeams.length === 0 && <p className="text-[11px] text-ppp-charcoal-400 mt-2">No teams yet — create one in <Link href="/commercial/settings/teams" className="font-semibold text-cc-brand-700 hover:underline">Settings → Teams</Link>.</p>}
      </div>

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
      <section id="assign-ppp-staff" className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 scroll-mt-24">
        <h2 className="text-sm font-bold text-ppp-charcoal">Assign PPP staff</h2>
        <p className="text-[11.5px] text-ppp-charcoal-500 mb-3 mt-0.5 leading-snug">
          People from <strong>PPP</strong> working this account (sales rep, PM, estimator). For the
          customer&apos;s own team, use the <strong>Contacts</strong> tab under People. Newly assigned
          staff get an email with a link to this account.
        </p>
        <form action={addAssignmentAction} className="space-y-3">
          <input type="hidden" name="account_id" value={accountId} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
                PPP staff *
              </span>
              {/* Searchable combobox (>10 staff) — type-to-filter the roster
                  instead of a long native select (searchable-dropdown rule). */}
              <SearchableSelect
                name="user_id"
                required
                defaultValue=""
                placeholder="Type a name to pick someone…"
                ariaLabel="PPP staff member to assign"
                options={assignableStaff.map((s) => {
                  const base = s.full_name ? `${s.full_name} (${s.email})` : s.email;
                  const already = teamUserIds.has(s.user_id);
                  return { value: s.user_id, label: already ? `${base} · already on team` : base };
                })}
              />
              {assignableStaff.length > 0 && assignableStaff.every((s) => teamUserIds.has(s.user_id)) && (
                <p className="text-[11px] text-ppp-charcoal-500 mt-1">
                  Everyone with Commercial CC access is already on this team — pick a
                  different role to add them again, or grant new access on the admin
                  Users page first.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="role" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
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
          <label className="flex items-center gap-2 text-sm min-h-[44px] sm:min-h-0">
            <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30" />
            Mark as primary in this role (replaces any current primary)
          </label>
          <div>
            <label htmlFor="team_notes" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
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
            <SubmitButton
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation"
            >
              Add to team
            </SubmitButton>
          </div>
        </form>

        {/* Karan 2026-07-08: "or add by email" collapsible below the
            main picker. Autocompletes from every PPP profile (not just
            those with CC access — the server action auto-grants access
            on add). Same role / primary / notes wiring. */}
        <details className="mt-5 border-t border-ppp-charcoal-100 pt-4 group/emailAdd">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px] touch-manipulation">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/emailAdd:rotate-90">
              <path d="M9 18l6-6-6-6" />
            </svg>
            Not on the list? Add by email
          </summary>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-2 leading-snug">
            Type any PPP teammate&apos;s email. Autocompletes from known
            PPP profiles. If they don&apos;t have Commercial CC access yet,
            we&apos;ll grant it as part of the add. They&apos;ll get an
            email with a link to this account and their role.
          </p>
          <form action={addAssignmentByEmailAction} className="space-y-3 mt-3">
            <input type="hidden" name="account_id" value={accountId} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="team_email" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
                  Email *
                </label>
                <input
                  id="team_email"
                  name="email"
                  type="email"
                  required
                  list="ppp-staff-emails"
                  placeholder="firstname@precisionpaintingplus.net"
                  className={INPUT_CLS}
                />
                <datalist id="ppp-staff-emails">
                  {allPppEmails.map((s) => (
                    <option key={s.email} value={s.email}>
                      {s.full_name ? `${s.full_name} — ${s.email}` : s.email}
                    </option>
                  ))}
                </datalist>
              </div>
              <div>
                <label htmlFor="email_role" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
                  Role *
                </label>
                <select
                  id="email_role"
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
            <label className="flex items-center gap-2 text-sm min-h-[44px] sm:min-h-0">
              <input type="checkbox" name="is_primary" className="h-4 w-4 rounded border-ppp-charcoal-300 focus:ring-cc-brand-600/30" />
              Mark as primary in this role
            </label>
            <div>
              <label htmlFor="email_team_notes" className="block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5">
                Notes
              </label>
              <input
                id="email_team_notes"
                name="notes"
                type="text"
                placeholder="Optional"
                className={INPUT_CLS}
              />
            </div>
            <div className="flex justify-end">
              <SubmitButton
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-cc-brand-300 bg-surface text-cc-brand-700 text-sm font-semibold hover:bg-cc-brand-50 min-h-[44px] touch-manipulation"
              >
                Add by email
              </SubmitButton>
            </div>
          </form>
        </details>
      </section>

      {/* Current team */}
      {team.length === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
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
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
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
          className="text-[11px] text-cc-brand-700 hover:text-cc-brand-800 break-all"
        >
          {person.user_email}
        </a>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {person.assignments.map((a) => {
            // Was a FIFTH copy of the same relative-time ladder, on its own
            // UTC divide. One implementation now, so a job can't read "6d ago"
            // here and "yesterday" on the page next door.
            const since = relativeAgoEt(a.assigned_at, "just now");
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
                  ? "bg-cc-brand-600 text-white border-cc-brand-700"
                  : "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
              }`}
              title={tipBits.join("\n")}
            >
              {a.is_primary && <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z" /></svg>}
              {assignmentRoleLabel(a.role)}
              <form action={removeAssignmentAction} className="inline">
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="assignment_id" value={a.id} />
                <SubmitButton
                  aria-label={`Remove ${assignmentRoleLabel(a.role)} role from ${person.user_full_name ?? person.user_email}`}
                  className={`-mr-1 ml-0.5 px-2 py-1 min-h-[44px] min-w-[44px] inline-flex items-center justify-center touch-manipulation ${a.is_primary ? "text-white/80 hover:text-white" : "text-cc-brand-700/80 hover:text-cc-brand-800"}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18"/></svg>
                </SubmitButton>
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
  await assertCommercialAccess(user.id);

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
  await assertCommercialAccess(user.id);

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
/** Inline "+ New opportunity" form — Karan 2026-07-08. Shared between the
 *  empty state (renders bare) and the header collapsible (renders inside
 *  a <details>). Two required rows visible immediately (title, status)
 *  plus optional bid/due/source. Property + description behind a
 *  progressive-disclosure <details>. Zero page jumps. */
async function NewDealForm({
  accountId,
  estimators,
  contactOptions,
  duplicateWarning,
  account,
  keptValues,
}: {
  accountId: string;
  estimators: EligibleEstimator[];
  /** Katie gap #1 — this GC's contacts, for the Attention-contact picker. */
  contactOptions: Array<{ value: string; label: string; hint?: string }>;
  duplicateWarning: { id: string; label: string } | null;
  /** Values typed before a duplicate warning, echoed back into the form. */
  keptValues?: Record<string, string | undefined>;
  /** F.6+ (Katie 2026-07-19): new-deal form now pre-fills client_name
   *  and property_* defaults from the parent account so Alex isn't
   *  retyping the same address every deal. Alex can override for
   *  a specific site contact / off-site project. */
  account: {
    company_name: string | null;
    billing_street: string | null;
    billing_street2: string | null;
    do_not_bid?: boolean;
    do_not_bid_reason?: string | null;
    do_not_bid_set_at?: string | null;
    billing_city: string | null;
    billing_state: string | null;
    billing_zip: string | null;
    site_street: string | null;
    site_street2: string | null;
    site_city: string | null;
    site_state: string | null;
    site_zip: string | null;
    team_id: string | null;
  };
}) {
  const inputCls =
    "w-full px-2.5 py-1.5 border border-ppp-charcoal-200 rounded-md text-base sm:text-[13px] min-h-[44px] touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 bg-surface";
  // Karan 2026-07-10 (second flag on gray selects): the OS-default
  // <select> chevron on Mac/Chrome renders the whole control in a
  // grayscale gradient that reads as "disabled" even when it isn't.
  // Every select in this form pins appearance-none + our own chevron
  // via SELECT_BG_STYLE so it visually matches the text inputs.
  const selectCls = `${inputCls} appearance-none bg-no-repeat pr-9 cursor-pointer`;
  const labelCls = "block text-[11px] font-semibold text-ppp-charcoal-600 mb-0.5";
  // RFP Received defaults to today (Karan meeting 2026-08) — most bids are logged
  // the day the request lands; still editable.
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const teams = await listTeams();
  // Repeat-customer prefill (Karan 2026-08): carry forward from this customer's
  // MOST RECENT opportunity only the things that genuinely repeat — the GC
  // contact you deal with, the crew you send, and the estimator who knows the
  // account. Everything else is left blank on purpose: the address, the dates
  // and the stage are different every job, and a wrong default is worse than an
  // empty field because it gets saved without being read.
  const priorDeals = await listCommercialOpportunities({ accountId });
  const lastDeal = priorDeals
    .slice()
    .sort((a2, b2) => (b2.created_at ?? "").localeCompare(a2.created_at ?? ""))[0] ?? null;
  // Name the account's team in the inherit option so "Customer's team" isn't a
  // blind pick.
  const accountTeamName = account.team_id
    ? teams.find((t) => t.id === account.team_id)?.name ?? null
    : null;
  return (
    <form action={createDealInlineAction} className="space-y-3">
      {/* Stephanie 2026-08-13 asked for a "do not bid" marker. This is where it
          earns its keep: at the moment someone starts new work for that
          customer, not buried on a tab.

          It warns and lets them carry on. Blocking would push the deal onto a
          different account and lose the history — and the reason is shown, so
          the call can actually be judged rather than just obeyed. */}
      {account.do_not_bid && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-900"
        >
          <strong className="font-semibold">This customer is flagged do not bid.</strong>{" "}
          {account.do_not_bid_reason?.trim()
            ? account.do_not_bid_reason.trim()
            : "No reason was recorded."}
          {account.do_not_bid_set_at && (
            <span className="block text-[12px] text-rose-800/80 mt-0.5">
              Flagged {fmtEtDate(account.do_not_bid_set_at)}.
            </span>
          )}
          <span className="block text-[12px] text-rose-800/80 mt-1">
            You can still create the job — this is a heads-up, not a block.
          </span>
        </div>
      )}
      <input type="hidden" name="account_id" value={accountId} />
      {duplicateWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900 space-y-1.5">
          <div className="font-semibold">Possible duplicate</div>
          <div>
            Another opportunity on this account already has the same client + location:{" "}
            <Link
              href={`/commercial/opportunities/${duplicateWarning.id}`}
              className="underline decoration-amber-500 underline-offset-2 hover:text-amber-950"
            >
              {duplicateWarning.label}
            </Link>. If this bid is separate (different scope or phase), pick <em>Create anyway</em> below.
          </div>
          {/* When present, this hidden field skips the duplicate check on
              the next submit — the user has acknowledged the match. */}
          <input type="hidden" name="confirm_duplicate" value="1" />
        </div>
      )}
      <div>
        <label className={labelCls} htmlFor="deal-title">Opportunity title <span className="font-normal text-ppp-charcoal-400">(auto-fills from date · builder · client · address — edit freely)</span></label>
        <AutoOpportunityTitle builder={account.company_name ?? ""} defaultValue={keptValues?.title} className={inputCls} />
      </div>
      {/* Phase E-4 (2026-07-13): status + sub-status now cascade via a
          shared client picker (also exposes optional follow-up date +
          notes for waiting-on-GC bids). Server action already parses
          sub_status + follow_up_at + follow_up_notes. */}
      {/* Katie's ask (2026-08), verbatim: "For Existing builder, only enter the
          address of the new Opportunity, name of the new Opportunity, select
          Customer's Contact, Add Team." Those four stay in the open; everything
          else folds away.
          Collapsed rather than deleted, because each of these still matters
          somewhere — Source feeds the win/loss report, RFP received powers
          time-to-proposal, Estimator is who owns the bid — and every one of
          them already has a sensible default (Stage = Qualifying, RFP = today).
          So the fast path is: title, address, contact, team, Create. */}
      {/* ── Brendan 2026-08-12 ──────────────────────────────────────────────
          "More options section should be always available (expanded)", and a
          field order he wrote out: client name · project address · nickname ·
          proposal contact · proposal due · RFP received · estimator · lead
          source · notes.

          Both collapsible sections are gone. They hid nine fields behind two
          different disclosures, one nested inside the other, so the answer to
          "where do I put the estimator?" was two clicks and a guess. A form
          people fill in every day should not have to be explored.

          Also gone: Proposed start / Proposed end — "too early to determine at
          the opportunity level." Dates for the WORK live on the project.

          Order below is his, exactly. Stage and Team are not on his list but
          are real and both default sensibly, so they sit at the end rather
          than interrupting the sequence he asked for. */}
      <label className="block">
        <span className={labelCls}>Client name</span>
        {/* NO default. Stephanie 2026-08-13: "Proposals autofills the GC/
            Builders name, not the opportunity/project name."
            This was the source. `client_name` is the GC's CUSTOMER — Katie's
            JD-Sports convention — and it was being seeded with the ACCOUNT's
            company name, i.e. the GC itself. The proposal's PROJECT line reads
            client_name, so every deal created here printed the builder's name
            as the project. The pipeline's new-deal form never did this; this
            one was the outlier, down to a placeholder that offered Tomco (our
            own company) as the example of a GC's customer. */}
        <input
          type="text"
          name="client_name"
          maxLength={200}
          defaultValue={keptValues?.client_name ?? ""}
          placeholder="Who the work is for (the GC's customer)"
          className={inputCls}
        />
      </label>

      <div>
        <div className={labelCls}>
          Project address{" "}
          <span className="font-normal text-ppp-charcoal-400">
            (this job&apos;s location — every job is somewhere different)
          </span>
        </div>
        <input
          type="text"
          name="property_street"
          maxLength={200}
          defaultValue={keptValues?.property_street ?? ""}
          placeholder="Street"
          className={inputCls}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
          <input type="text" name="property_city" maxLength={80} defaultValue={keptValues?.property_city ?? ""} placeholder="City" className={inputCls} />
          <input type="text" name="property_state" maxLength={2} defaultValue={keptValues?.property_state ?? ""} placeholder="State" className={inputCls} />
          <input type="text" name="property_zip" maxLength={10} defaultValue={keptValues?.property_zip ?? ""} placeholder="ZIP" className={inputCls} />
        </div>
        {/* Stephanie 2026-08-13: "Autofills GC/Builders address, rarely the
            same as the opportunity address." The label already said every job
            is somewhere different while the fields quietly disagreed.

            The ZIP mattered most: it picks the sales-tax jurisdiction
            (resolveTaxForZip), so a leftover builder ZIP taxes the job at the
            builder's rate — wrong money, not just a wrong label.

            Shown rather than filled, so the shortcut survives for the rare job
            at the GC's own address without putting it in the record by
            default. */}
        {(account.site_street || account.billing_street) && (
          <p className="mt-1.5 text-[11px] text-ppp-charcoal-500">
            Account address:{" "}
            {[
              account.site_street || account.billing_street,
              account.site_city || account.billing_city,
              account.site_state || account.billing_state,
              account.site_zip || account.billing_zip,
            ]
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
      </div>

      {/* New on this form. The writer already accepted it — only the edit sheet
          ever offered it, so a nickname could not be set at the moment the job
          is actually being named. */}
      <label className="block">
        <span className={labelCls}>
          Project nickname{" "}
          <span className="font-normal text-ppp-charcoal-400">(optional — what the team calls it)</span>
        </span>
        <input
          type="text"
          name="title_override"
          maxLength={200}
          placeholder="e.g. Jericho Turnpike lobby"
          className={inputCls}
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Proposal contact</span>
          <SearchableSelect
            name="primary_contact_id"
            options={contactOptions}
            defaultValue={
              lastDeal?.primary_contact_id &&
              contactOptions.some((c) => c.value === lastDeal.primary_contact_id)
                ? lastDeal.primary_contact_id
                : ""
            }
            placeholder={contactOptions.length === 0 ? "No contacts on this GC yet" : "Search this GC's contacts…"}
            ariaLabel="Proposal contact"
            disabled={contactOptions.length === 0}
            emptyMessage="No contacts match. Add one on the GC's Contacts tab."
          />
          <span className="block text-[10px] text-ppp-charcoal-400 mt-0.5">
            {contactOptions.length === 0
              ? "No contacts yet — the GC’s primary will be used once added."
              : "Blank uses the GC’s default primary contact."}
          </span>
        </label>
        <div>
          <span className={labelCls}>Proposal due</span>
          <DateField name="proposal_due_at" placeholder="Pick a due date" ariaLabel="Proposal due date" />
        </div>
      </div>

      <div>
        <span className={labelCls}>RFP received</span>
        <DateField name="rfp_received_at" defaultValue={todayIso} placeholder="When the RFP / bid request arrived" ariaLabel="RFP received date" />
        <span className="block text-[10px] text-ppp-charcoal-400 mt-0.5">Powers time-to-proposal on the opportunity card.</span>
      </div>

      <label className="block">
        <span className={labelCls}>Estimator</span>
        <SearchableSelect
          name="estimator_user_id"
          options={estimators.map((e) => ({ value: e.user_id, label: e.name }))}
          defaultValue={
            lastDeal?.estimator_user_id &&
            estimators.some((e) => e.user_id === lastDeal.estimator_user_id)
              ? lastDeal.estimator_user_id
              : ""
          }
          placeholder={estimators.length === 0 ? "No teammates on the roster yet" : "Search team roster…"}
          ariaLabel="Estimator"
          disabled={estimators.length === 0}
          emptyMessage="No teammates match. Try a different search or type a name below."
        />
        <input type="text" name="estimator_name" maxLength={120} placeholder="…or type a name manually" className={`${inputCls} mt-1`} />
        <span className="block text-[10px] text-ppp-charcoal-400 mt-0.5">
          Assigning one moves this opportunity to Estimating.
        </span>
      </label>

      <label className="block">
        <span className={labelCls}>Lead source</span>
        <select name="source" defaultValue="" className={selectCls} style={SELECT_BG_STYLE}>
          <option value="">Choose a source</option>
          {OPPORTUNITY_SOURCES.map((s) => (
            <option key={s} value={s}>{opportunitySourceLabel(s)}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className={labelCls}>Notes</span>
        <textarea
          name="description"
          rows={2}
          maxLength={1000}
          placeholder="e.g. Scope: repaint 3-story lobby + 4 corridors. Existing latex, no lead."
          className={`${inputCls} min-h-[60px]`}
        />
      </label>

      {/* Not on Brendan's list, but real — and both default, so they sit after
          the sequence he asked for rather than interrupting it. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={labelCls}>Team</span>
          <select
            name="team_id"
            defaultValue={lastDeal?.team_id && teams.some((t) => t.id === lastDeal.team_id) ? lastDeal.team_id : ""}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            <option value="">{accountTeamName ? `Customer's team (${accountTeamName})` : "— No team —"}</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="block text-[10px] text-ppp-charcoal-400 mt-0.5">
            Build teams in Settings → Teams. You can change this later.
          </span>
        </label>
        <div>
          <span className={labelCls}>Stage</span>
          <StatusSubStatusPicker mode="create" />
        </div>
      </div>
      <div className="flex justify-end pt-1">
        <PendingSubmitButton
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/40 disabled:hover:bg-cc-brand-600"
          pendingLabel="Creating…"
        >
          {duplicateWarning ? "Create anyway" : "Create opportunity"}
        </PendingSubmitButton>
      </div>
    </form>
  );
}

async function OpportunitiesTab({
  accountId,
  account,
  overview,
  openNewDeal,
  dealBack,
  createdTitle,
  editDealId,
  savedFlash,
  deletedFlash,
  errorMessage,
  duplicateWarning,
  projectStartedOppId,
  includeArchived = false,
  keptValues,
}: {
  accountId: string;
  /** True when the edit sheet was opened from the DEAL page, so saving
   *  returns there rather than to this account's Deals tab. */
  dealBack?: boolean;
  /** Katie 2026-07-19: new-deal form pre-fills client_name + property
   *  address from this account so Alex isn't retyping the same info
   *  every deal. */
  account: CommercialAccount;
  overview: AccountOverview | null;
  openNewDeal?: boolean;
  createdTitle?: string | null;
  /** Phase E-6 signature moment: emerald toast when a Won deal was just
   *  handed off to Pre-Construction via the debrief page's Start Project. */
  projectStartedOppId?: string | null;
  /** When set, open a right-side slide-out edit sheet for the deal.
   *  Loaded from `?edit=<uuid>` on the URL. Cross-account access
   *  blocked by the account_id-scoped fetch below (the sheet only
   *  opens when the deal belongs to `accountId`; a mismatched pair
   *  silently ignores the param). */
  editDealId?: string | null;
  savedFlash?: boolean;
  deletedFlash?: string | null;
  errorMessage?: string;
  /** Phase B duplicate detection — set on redirect back from
   *  createDealInlineAction when the client/location combo matches
   *  an existing non-deleted opp on this account. The NewDealForm
   *  renders a "Create anyway" resubmit path when this is populated. */
  duplicateWarning?: { id: string; label: string } | null;
  /** Values typed before the duplicate warning fired, echoed back so
   *  "Create anyway" doesn't mean "retype the whole form". */
  keptValues?: Record<string, string | undefined>;
  /** Katie 2026-07-20: per-account "Include archived" toggle. URL
   *  param ?archived=1 on ?tab=opportunities. When true, listing
   *  fetches archived opps too — otherwise they're hidden (matches
   *  the pipeline pattern shipped 2026-07-20). */
  includeArchived?: boolean;
}) {
  // Pass includeArchived through — listCommercialOpportunities defaults
  // to hiding archived (active pipeline behavior). Also fetch archived
  // count separately so the chip label shows "(N)" even when the toggle
  // is off, so users know the button will surface something.
  const [all, archivedRows] = await Promise.all([
    listCommercialOpportunities({ accountId, includeArchived }),
    listCommercialOpportunities({ accountId, onlyArchived: true }),
  ]);
  const archivedCount = archivedRows.length;
  const ids = all.map((o) => o.id);

  // Bulk-fetch every row signal in parallel — keeps the tab a single
  // batch query regardless of opp count. Also preload the eligible
  // estimator list for the New + Edit forms (Phase B) so we don't need
  // a client-side fetch per form render.
  const [statusEnteredMap, taskStatsMap, lastNoteMap, primaryLeadMap, attachmentMap, submittalMap, finishMap, estimators, contactRows] = await Promise.all([
    listCurrentStatusEnteredAtByOpp(ids),
    listOpenTaskStatsByOpp(ids),
    listLastNoteByOpp(ids),
    listPrimaryLeadByOpp(ids),
    listAttachmentCountByOpp(ids),
    listSubmittalCountByOpp(ids),
    listFinishCountByOpp(ids),
    listEligibleEstimators(accountId),
    listAccountContacts(accountId),
  ]);
  // Katie gap #1 — Attention-contact options for the New-deal form (choose the
  // GC contact this job's proposals will address; blank auto-inherits the GC's
  // default primary via the create mutation).
  const contactOptions = contactRows.map(({ contact }) => ({
    value: contact.id,
    label: contact.full_name,
    hint: [contact.title, contact.phone].filter(Boolean).join(" · ") || undefined,
  }));

  // 2026-07-29 re-audit fix: three mutually-exclusive buckets covering all 7
  // statuses so a won-in-delivery deal isn't mislabeled "Open" (it was, via
  // OPEN_OPP_STATUSES, contradicting the scorecard's Won tile). "Open" now
  // means active pre-sale ONLY, matching the scorecard's open_opps_count and
  // the dashboard/pipeline definition.
  const open = all.filter((o) => PRE_SALE_OPEN_STATUSES.includes(o.status));
  const inDelivery = all.filter((o) => IN_DELIVERY_STATUSES.includes(o.status));
  const decided = all.filter((o) => TERMINAL_STATUSES.has(o.status));

  // Bid Lifecycle (Katie 2026-07-20): fetch the 4 dates + 2 durations
  // for the deal being edited so the slide-out sheet can show the
  // lifecycle timeline at the top. Only fires when a sheet is open —
  // one lightweight query, not per-row. This is where the timeline
  // lives now that /opportunities/[id] redirects live deals here
  // (2026-07-21 audit: the timeline was previously unreachable).
  const editDealRow = editDealId ? all.find((d) => d.id === editDealId) ?? null : null;
  const editLifecycle = editDealRow
    ? await fetchOpportunityLifecycle(editDealRow)
    : null;

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
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
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
          <NewDealForm accountId={accountId} estimators={estimators} contactOptions={contactOptions} duplicateWarning={duplicateWarning ?? null} account={account} keptValues={keptValues} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Karan 2026-07-08: header-strip "+ New opportunity" Link →
          inline "+ New opportunity" collapsible. Same activity summary; the
          CTA is now a native <details> that expands the form right
          here instead of jumping to a full-page form. Auto-opens when
          the URL has ?new_deal=1 (set by the retired
          /commercial/opportunities/new redirect shim). */}
      {createdTitle && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span>
            <strong>{flashMessage(createdTitle)}</strong> logged.
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {projectStartedOppId && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span>
              Project started — deal moved into <strong>Pre-Construction</strong>.
              Delivery pipeline takes it from here.
            </span>
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {savedFlash && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            <span>Changes saved.</span>
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {deletedFlash && (
        <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-start justify-between gap-3">
          <span>
            <strong className="text-ppp-charcoal">{flashMessage(deletedFlash)}</strong> deleted. Soft-delete — restorable by admin from the audit log.
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
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
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {/* Karan 2026-07-08 rewrite: primary "+ New opportunity" CTA is now a
          proper red-accent card (matches the pipeline "New opportunity" +
          "New account" CTAs on the list pages). Reads as the primary
          action, not a nested collapsible chevron. When open exists the
          card stays collapsed; when it's the customer's only next move
          it opens by default with a "Start the next bid" label change. */}
      {/* Karan 2026-07-08 rewrite: right-side slide-out edit sheet.
          Killed the auto-focus DealDrillIn — user's feedback: "when i
          click on an already existing deal it focuses the deal i dont
          like that". Now ?edit=<uuid> opens a GHL-style right sheet
          where the user edits the deal in place and saves. On save the
          sheet closes and the deal lives back in the collapsible list
          below. Cross-account defense — `all` is already scoped to
          this accountId at the top of the tab; a smuggled UUID from
          another account silently ignores the param. */}
      {editDealId && (() => {
        const dealRow = all.find((d) => d.id === editDealId);
        if (!dealRow) return null;
        return (
          <DealEditSheet
            deal={dealRow}
            accountId={accountId}
            accountName={account.company_name}
            primaryLead={primaryLeadMap.get(dealRow.id) ?? null}
            estimators={estimators}
            errorMessage={errorMessage}
            lifecycle={editLifecycle}
            dealBack={dealBack}
          />
        );
      })()}

      {/* Katie 2026-07-20 (Phase G Q3 per-account variant): "Include
          archived" toggle scoped to THIS account. Mirrors the pipeline
          chip pattern. Shows archived count in the label so users know
          the button will surface deals even when the toggle is off.
          Rendered only when there's at least one archived deal (or the
          toggle is currently ON) — no dead chip on brand-new accounts. */}
      {(archivedCount > 0 || includeArchived) && (
        <div className="flex items-center justify-end -mt-1">
          <Link
            href={`/commercial/accounts/${accountId}?tab=opportunities${includeArchived ? "" : "&archived=1"}#deal-list`}
            // Audit fix: min-h 44px on mobile (tap target standard),
            // 28px on desktop where it's a chip. Vertical padding
            // scales the same so text stays centered.
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 sm:px-2.5 sm:py-1 rounded-full text-[11.5px] font-medium border min-h-[44px] sm:min-h-[28px] transition-colors touch-manipulation ${
              includeArchived
                ? "bg-ppp-charcoal-100 text-ppp-charcoal-800 border-ppp-charcoal-300 hover:bg-ppp-charcoal-200"
                : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
            }`}
            aria-pressed={includeArchived}
            title={
              includeArchived
                ? "Currently showing archived opportunities — click to hide"
                : "Archived opportunities are hidden by default. Click to include them in the list."
            }
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="2" y="4" width="20" height="4" rx="1" />
              <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
              <line x1="10" y1="13" x2="14" y2="13" />
            </svg>
            {includeArchived ? "Hide archived" : `Include archived (${archivedCount})`}
          </Link>
        </div>
      )}

      <details
        open={openNewDeal || open.length === 0}
        className="group/newdeal bg-surface border border-cc-brand-200 rounded-xl overflow-hidden shadow-sm shadow-cc-brand-100/40"
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
                  : "New opportunity for this customer"}
              </span>
              <span className="text-[11px] text-ppp-charcoal-500 leading-tight mt-0.5">
                {open.length === 0 && decided.length > 0
                  ? "Log the next opportunity — repeat customer, warm lead."
                  : "Title + bid range gets you moving; details later."}
              </span>
            </span>
          </span>
          <span aria-hidden className="text-cc-brand-500 transition-transform group-open/newdeal:rotate-180 shrink-0"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
        </summary>
        <div className="p-4 border-t border-cc-brand-100 bg-cc-brand-50/20">
          <NewDealForm accountId={accountId} estimators={estimators} contactOptions={contactOptions} duplicateWarning={duplicateWarning ?? null} account={account} keptValues={keptValues} />
        </div>
      </details>

      {open.length > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
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

      {/* Won & under contract — active delivery work. Sits between the
          open bids and the decided history so a won job in production reads
          as "we're building this," not as an open bid or closed history. */}
      {inDelivery.length > 0 && (
        <section className="bg-surface border border-emerald-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-emerald-100 flex items-center justify-between bg-emerald-50/40">
            <h2 className="text-sm font-semibold text-emerald-900">
              In delivery · {inDelivery.length}
            </h2>
            <span className="text-[11px] font-medium text-emerald-700">Won · under contract</span>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {inDelivery.map((opp) => (
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
          className="group/decided bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden"
        >
          <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] hover:bg-ppp-charcoal-50/60 touch-manipulation focus:outline-none focus:ring-2 focus:ring-ppp-charcoal-300/40">
            <h2 className="text-sm font-semibold text-ppp-charcoal-700">
              Decided · {decided.length}
            </h2>
            <span aria-hidden className="text-ppp-charcoal-400 transition-transform group-open/decided:rotate-180"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
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
  const statusInfo = statusPillTone(opp.status, opp.sub_status);
  const daysInStatus = daysSinceIso(statusEnteredAt);
  const daysTone =
    daysInStatus === null
      ? "text-ppp-charcoal-500"
      : daysInStatus > 14
      ? "text-rose-700"
      : daysInStatus > 7
      ? "text-amber-700"
      : "text-cc-brand-700";
  // First name from "Sarah Connor" → "Sarah". Falls back to the local
  // part of the email when no full name is set.
  const leadLabel = primaryLead
    // `||` not `??`: a Salesforce name can be an EMPTY string (not null), which
    // ?? wouldn't catch → a blank chip. Fall through to the email local-part,
    // and stay null-safe if the email is somehow missing (2026-08 edge audit).
    ? ((primaryLead.user_full_name?.trim().split(" ")[0] || primaryLead.user_email?.split("@")[0]) ?? "—")
    : null;
  // DAG-filtered next statuses for inline quick-flip. Empty list →
  // dropdown hides (terminal states have no forward motion; reopened
  // is the only legal exit and that's handled on the detail page).
  // Every column except the one this deal already sits in. (The flat DAG
  // means every other stage is a legal move, so "not where you are" IS
  // the option set — and unlike a status-level filter it keeps
  // Qualifying ⇄ Request for Proposal reachable, since those two columns
  // share the real status `qualifying`.)
  const here = columnKeyForOpp(opp.status, opp.sub_status);
  const moveToOptions = KANBAN_COLUMNS.filter((c) => c.key !== here).map((c) => ({
    key: c.key,
    label: kanbanMoveToLabel(c.key),
  }));
  const isTerminal = TERMINAL_STATUSES.has(opp.status);
  // The debrief only exists for a deal at Closed — see the note on the other
  // CTA. `isTerminal` also matches post_sale_closed, where the link dead-ends.
  const canDebrief = opp.status === "pre_sale_closed";
  const bidLabel = formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents);
  return (
    // 2026-07-21 audit: anchor target for #deal-row-<id>. Two links
    // (this row's own link + the pipeline deal-click redirect) point
    // here, but no element carried the id, so the scroll-to-row was a
    // silent no-op. `scroll-mt-24` clears the sticky header on landing.
    <li id={`deal-row-${opp.id}`} className="scroll-mt-24">
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
                {/* Phase B derived-name rule (Karan 2026-07-10 audit
                    fix): show {client}-{location} on account-context
                    rows. accountName is passed as null since we're
                    already on Bob's page — including "Bob-John-123
                    Main St" would just repeat the page context.
                    Falls back to opp.title if structural fields
                    are unset (pre-Phase-B rows). */}
                {derivedOppName(opp, null)}
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border shrink-0 ${statusInfo.cls}`}
              >
                {oppStatusDisplayLabel(opp.status, opp.sub_status)}
              </span>
            </div>
            <div className="mt-1 text-[12.5px] text-ppp-charcoal-600 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              {/* Karan 2026-07-21: OPP-#### id chip for scannable cross-ref
                  (consistent with kanban + pipeline list). */}
              {formatOpportunityNumber(opp.project_number) && (
                <>
                  <span className="font-mono text-[10.5px] text-ppp-navy-600">
                    {formatOpportunityNumber(opp.project_number)}
                  </span>
                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                </>
              )}
              <span className="font-semibold text-ppp-charcoal-800">
                {bidLabel !== "—" ? bidLabel : "No bid set"}
              </span>
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
              lastNote ||
              (opp.follow_up_at && !isTerminal)
            ) && (
              <div className="mt-1.5 text-[11.5px] flex items-center gap-x-3 gap-y-0.5 flex-wrap text-ppp-charcoal-500">
                {taskStats && taskStats.overdue > 0 && (
                  <span className="text-rose-700 font-medium">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg> {taskStats.overdue} overdue task{taskStats.overdue === 1 ? "" : "s"}
                  </span>
                )}
                {submittalStats && submittalStats.awaiting_response > 0 && (
                  <span className="text-ppp-blue-700 font-medium inline-flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    {submittalStats.awaiting_response} awaiting GC
                  </span>
                )}
                {leadLabel && (
                  <span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z" /></svg> {leadLabel} lead
                  </span>
                )}
                {!isTerminal && daysInStatus !== null && daysInStatus > 7 && (
                  <span className={daysTone}>
                    {daysInStatus}d in stage
                  </span>
                )}
                {/* Phase E-4: pending follow-up. Rose when overdue, cyan
                    when upcoming, so Katie's team can scan the pipeline
                    and know "which bids am I chasing today?" at a glance. */}
                {opp.follow_up_at && !isTerminal && (() => {
                  const due = new Date(opp.follow_up_at);
                  const now = new Date();
                  const days = Math.round((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                  const overdue = days < 0;
                  const label = overdue
                    ? `Follow-up ${Math.abs(days)}d overdue`
                    : days === 0
                    ? "Follow up today"
                    : days === 1
                    ? "Follow up tomorrow"
                    : `Follow up in ${days}d`;
                  return (
                    <span
                      className={`inline-flex items-center gap-1 ${overdue ? "text-rose-700 font-medium" : "text-ppp-blue-700 font-medium"}`}
                      title={opp.follow_up_notes ?? undefined}
                    >
                      <IconClock size={12} className="shrink-0" /> {label}
                    </span>
                  );
                })()}
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
      {/* Karan 2026-07-13: persistent "Debrief" entry point on decided
          deal rows. Without it, the only way to reach the debrief was
          the toast right after a Won drop. Amber pill for pending
          debrief; emerald for filed. Renders below the row link so it
          doesn't nest anchors. */}
      {canDebrief && (
        <div className="px-4 pb-3 -mt-1">
          <Link
            href={`/commercial/accounts/${accountId}/debrief/${opp.id}`}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold min-h-[44px] sm:min-h-[28px] ${
              opp.win_loss_debriefed_at
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100"
                : "bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100"
            }`}
          >
            {opp.win_loss_debriefed_at ? "View debrief" : "Log debrief"}
            <span aria-hidden>→</span>
          </Link>
        </div>
      )}
      {/* Karan 2026-07-08 Batch 2: dropped the "QUICK FLIP" caps label —
          the placeholder text inside the select tells the same story
          without shouting. Terminal states still route to detail for
          loss_reason + note capture.
          Karan 2026-07-16: list matches the pipeline kanban's columns.
          Explicit Won/Lost picks (was falling through to
          `pre_sale_closed` with a default-to-Won sub_status — silently
          marked deals as Won when user meant to close as Lost).
          Karan 2026-08: generated from KANBAN_COLUMNS rather than
          hand-listed, so it can't fall behind the board again — this copy
          still said "Proposal Drafted / Proposal Sent" after the flatten.
          Omits the column the deal is already in (no-op move). */}
      {moveToOptions.length > 0 && (
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
            className={`${SELECT_CLS} text-base sm:text-sm py-1.5 min-h-[44px] sm:min-h-[36px]`}
            style={SELECT_BG_STYLE}
          >
            <option value="" disabled>
              Move to…
            </option>
            {moveToOptions.map((col) => (
              <option key={col.key} value={col.key}>
                → {col.label}
              </option>
            ))}
          </select>
          <PendingSubmitButton
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-ppp-charcoal-700 text-surface hover:bg-ppp-charcoal-800 min-h-[44px] touch-manipulation disabled:hover:bg-ppp-charcoal-700"
            pendingLabel="Moving…"
          >
            Go
          </PendingSubmitButton>
        </form>
      )}
    </li>
  );
}

/** Status pill color tone — mirrors the global pipeline page.
 *  Accepts a (status, sub_status) tuple. v2 model:
 *    Qualifying → Solicitation/RFP/Estimating
 *    Estimating → Proposal Pending Approval
 *    Proposal → Sent / Follow Up
 *    Pre-Sale/Closed → Won / Lost
 *    Post-Sale statuses (Pre-Construction, In Progress, Billing, Closed).
 *  Sub-status choice picks the tone when the parent status is ambiguous
 *  (e.g. Pre-Sale/Closed is either won emerald or lost rose). */
/**
 * The pipeline block's stripe/bar tones, derived from the ONE status→colour
 * map rather than a parallel copy of it.
 */
function pipelineBlockTone(
  status: string,
  subStatus?: string | null
): { stripe: string; pill: string; bar: string; val: string } {
  const pill = statusPillTone(status, subStatus).cls;
  // Written out in full on purpose: Tailwind generates classes by scanning the
  // source, so a composed `bg-${family}-500` produces NO class at all — it type
  // -checks, it builds, and the stripe renders colourless.
  const byFamily: Record<string, { solid: string; text: string }> = {
    amber: { solid: "bg-amber-500", text: "text-amber-800" },
    rose: { solid: "bg-rose-500", text: "text-rose-700" },
    emerald: { solid: "bg-emerald-500", text: "text-emerald-700" },
    "ppp-navy": { solid: "bg-ppp-navy-500", text: "text-ppp-navy-700" },
    "ppp-blue": { solid: "bg-ppp-blue-500", text: "text-ppp-blue-700" },
    "ppp-charcoal": { solid: "bg-ppp-charcoal-300", text: "text-ppp-charcoal-600" },
  };
  const family = pill.includes("amber")
    ? "amber"
    : pill.includes("rose")
      ? "rose"
      : pill.includes("emerald")
        ? "emerald"
        : pill.includes("ppp-navy")
          ? "ppp-navy"
          : pill.includes("ppp-blue")
            ? "ppp-blue"
            : "ppp-charcoal";
  const t = byFamily[family];
  return { stripe: t.solid, pill, bar: t.solid, val: t.text };
}

function statusPillTone(
  status: OpportunityStatus | string,
  sub_status?: string | null,
): { cls: string } {
  // Terminal (v2 + v1 legacy).
  // Won is NAVY, not emerald — Karan's call, and the won-not-started card on
  // this same page is navy. A green pill sitting directly above that navy card
  // read as two different states for one deal.
  if (status === "pre_sale_closed" && sub_status === "won") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "pre_sale_closed" && sub_status === "lost") return { cls: "bg-rose-50 text-rose-800 border-rose-200" };
  if (status === "won") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "lost") return { cls: "bg-rose-50 text-rose-800 border-rose-200" };
  // 2026-07-28 color audit: semantic palette only (cc-brand red is the action
  // color, never a status). Active stage → ppp-blue, working/attention →
  // amber, done → emerald, lost → rose, early → charcoal. Labels distinguish
  // stages that share a tone.
  // v2 Post-Sale lane.
  if (status === "pre_construction") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "in_progress") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "billing") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  // A finished job is navy too — it is the same "won" family, further along.
  if (status === "post_sale_closed") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  // v2 Pre-Sale intermediate.
  if (status === "proposal" && sub_status === "follow_up") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "proposal") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "estimating") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "qualifying" && sub_status === "rfp") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "qualifying") return { cls: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200" };
  // v1.1 legacy fallbacks (shouldn't hit post-migration but defensive).
  if (status === "follow_up") return { cls: "bg-amber-50 text-amber-800 border-amber-200" };
  if (status === "proposal_sent") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  if (status === "proposal_pending_approval") return { cls: "bg-ppp-navy-50 text-ppp-navy-700 border-ppp-navy-200" };
  if (status === "rfp") return { cls: "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200" };
  return { cls: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100" };
}

// ─────────────── Account Proposals sub-tab (Karan 2026-07-15) ───────────────
// Surfaces every proposal revision on every deal for THIS account, grouped
// by parent deal so Alex can scan "this customer's whole proposal history"
// in one place. Includes the same NewProposalPicker (locked to this
// account) so a new revision can be started without leaving the tab.
async function AccountProposalsTab({
  accountId,
  accountName,
  bulkDeletedCount,
  bulkSkippedCount,
  errorMessage,
}: {
  accountId: string;
  accountName: string;
  bulkDeletedCount: number | null;
  bulkSkippedCount: number | null;
  errorMessage: string | undefined;
}) {
  const sb = commercialDb();
  // Post-audit fix: previously fetched newest 300 proposals globally
  // then filtered by account client-side — at scale that silently
  // truncated older revisions belonging to this account. Push both
  // scoping filters into SQL so we get every non-deleted proposal
  // whose parent opp belongs to this live account.
  const { data: proposalsData } = await sb
    .from("commercial_proposals")
    .select(
      `id, revision_number, proposal_seq, status, total_cents, sent_at, updated_at, opportunity_id, header_json, snapshot_document_id,
       opportunity:commercial_opportunities!commercial_proposals_opportunity_id_fkey!inner(id, title, title_override, client_name, property_street, project_number, account_id, deleted_at, archived_at, status, sub_status)`
    )
    .is("deleted_at", null)
    .eq("opportunity.account_id", accountId)
    .is("opportunity.deleted_at", null)
    // Katie 2026-07-20 audit fix (HIGH): archived deals' proposals were
    // leaking into this tab even though the parent deal is hidden from
    // the Deals tab. Mirror the Deals tab behavior — archived deals'
    // proposals hide by default. Toggle at Deals tab reveals them.
    .is("opportunity.archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(300);

  type Row = {
    id: string;
    revision_number: number;
    proposal_seq: number | null;
    status: string;
    total_cents: number;
    sent_at: string | null;
    updated_at: string;
    opportunity_id: string;
    header_json: { gc_company?: string; project_name?: string } | null;
    snapshot_document_id: string | null;
    opportunity: {
      id: string;
      title: string | null;
      title_override: string | null;
      client_name: string | null;
      property_street: string | null;
      project_number: string | null;
      account_id: string;
      deleted_at: string | null;
      archived_at: string | null;
      status: string;
      sub_status: string | null;
    } | null;
  };
  // SQL already enforced account_id + soft-delete + archived filters;
  // defensively filter again in JS in case the join shape ever drops a row.
  const proposals = ((proposalsData as unknown as Row[]) ?? [])
    .filter((r) => r.opportunity && !r.opportunity.deleted_at && !r.opportunity.archived_at)
    // `proposalDisplayId` needs the DEAL's shared number, which only the
    // proposal readers hydrate. This query builds its own rows, so without
    // this the same proposal renders `PROP-2026-0042` on the deal and
    // `PROP-0031` here — the exact two-ids-one-document problem H6 removed.
    .map((r) => ({ ...r, project_number: r.opportunity?.project_number ?? null }));

  // Group by parent deal. Within each deal, sort by revision_number
  // desc so R3 always appears above R2 above R1 (the query orders by
  // updated_at desc, which usually matches revision order but not
  // always — e.g. a Draft R2 last edited yesterday would appear
  // above a Sent R3 last edited last week).
  const byDeal = new Map<string, { deal: Row["opportunity"]; rows: Row[] }>();
  for (const r of proposals) {
    if (!r.opportunity) continue;
    const key = r.opportunity.id;
    const bucket = byDeal.get(key) ?? { deal: r.opportunity, rows: [] };
    bucket.rows.push(r);
    byDeal.set(key, bucket);
  }
  for (const bucket of byDeal.values()) {
    bucket.rows.sort((a, b) => b.revision_number - a.revision_number);
  }

  // Pull this account's proposal-eligible deals so the picker can offer them.
  // Uses the shared isProposalEligibleOpp() so /commercial/proposals and this
  // tab pick from the same set (pre-sale open lanes + WON).
  const openOpps = await listCommercialOpportunities({ accountId });
  const pickerDeals = openOpps
    .filter((o) => isProposalEligibleOpp(o))
    .map((o) => ({
      id: o.id,
      account_id: o.account_id,
      display_name: derivedOppName(o, accountName) || "(untitled opportunity)",
      status: o.status,
    }));

  const pillCls = (status: string): string => {
    // Karan 2026-07-17: toned down per meeting — "looks really tacky".
    // Cleaner subtle pills, less carnival-color. Semantic meaning kept
    // (brand for sent, emerald for won, rose for lost/expired) but with
    // reduced saturation so pills sit quietly next to the row content.
    switch (status) {
      case "sent":
        return "bg-cc-brand-50 text-cc-brand-800 border-transparent";
      case "won":
        return "bg-emerald-50 text-emerald-800 border-transparent";
      case "lost":
      case "expired":
        return "bg-rose-50 text-rose-700 border-transparent";
      case "pending_approval":
        return "bg-ppp-navy-50 text-ppp-navy-700 border-transparent";
      case "approved":
        return "bg-ppp-green-50 text-ppp-green-700 border-transparent";
      case "superseded":
        return "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-transparent";
      default:
        return "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-transparent";
    }
  };
  const fmt = (c: number) =>
    `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  // Count only DRAFT proposals — the bulk-delete button only touches
  // drafts (Sent/Won/Lost/Replaced are legal history and get skipped
  // server-side, but showing the button as "Delete N drafts" is honest).
  const draftCount = proposals.filter((p) => p.status === "draft").length;

  return (
    <div className="space-y-4">
      {/* Bulk delete + create toast banners */}
      {typeof bulkDeletedCount === "number" && bulkDeletedCount >= 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-900">
          <strong>Deleted {bulkDeletedCount} draft{bulkDeletedCount === 1 ? "" : "s"}.</strong>{" "}
          {bulkSkippedCount && bulkSkippedCount > 0
            ? `Skipped ${bulkSkippedCount} non-draft (Sent / Won / Lost / Replaced) — those are historical and can't be deleted.`
            : "Sent / Won / Lost / Replaced proposals are always spared."}
        </div>
      )}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2.5 text-sm text-rose-800" role="alert">
          {errorMessage}
        </div>
      )}

      {/* Karan 2026-07-17 (round 2): dark hero looked out of place
          on the nested account tab (it competed with the page-level
          hero and clashed with the surrounding white surfaces).
          Switched to a light card that fits the account page theme:
          white bg + cc-brand red accent stripe + light-blue tint for
          sent, emerald for won. Same scorecard shape, colors that
          match. */}
      {(() => {
        const sentCount = proposals.filter((p) => p.status === "sent").length;
        const wonCount = proposals.filter((p) => p.status === "won").length;
        const outstandingCents = proposals
          .filter((p) => p.status === "sent" || p.status === "pending_approval" || p.status === "approved")
          .reduce((s, p) => s + p.total_cents, 0);
        return (
          <div className="relative bg-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5 shadow-sm overflow-hidden">
            <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-cc-brand-600 to-cc-brand-500" />
            <span aria-hidden className="pointer-events-none absolute -top-10 -right-10 h-32 w-32 rounded-full bg-cc-brand-100/50 blur-2xl" />
            <div className="relative flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-1">Proposals</div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-condensed text-3xl sm:text-4xl font-black text-ppp-charcoal leading-none">{proposals.length}</span>
                  <span className="text-[12px] text-ppp-charcoal-500">total revision{proposals.length === 1 ? "" : "s"} · {byDeal.size} {byDeal.size === 1 ? "opportunity" : "opportunities"}</span>
                </div>
              </div>
              <div className="flex items-center gap-4 sm:gap-6 flex-wrap">
                {/* Karan 2026-07-21 (zero-state discipline): hide Sent/Won
                    when 0 — matches the Outstanding pattern below. No dead
                    "Sent 0 / Won 0" clutter on accounts with no send history. */}
                {sentCount > 0 && (
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-widest text-cc-brand-700">Sent</div>
                    <div className="font-condensed text-xl font-bold text-ppp-charcoal leading-none mt-0.5">{sentCount}</div>
                  </div>
                )}
                {wonCount > 0 && (
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-widest text-emerald-700">Won</div>
                    <div className="font-condensed text-xl font-bold text-emerald-700 leading-none mt-0.5">{wonCount}</div>
                  </div>
                )}
                {outstandingCents > 0 && (
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-widest text-ppp-charcoal-500">Outstanding</div>
                    <div className="font-condensed text-xl font-bold text-ppp-charcoal leading-none mt-0.5">{fmt(outstandingCents)}</div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {draftCount > 0 && (
                  <form action={bulkDeleteAllProposalsAction} className="inline-flex">
                    <input type="hidden" name="account_id" value={accountId} />
                    <input type="hidden" name="confirm" value="yes" />
                    <ConfirmSubmitButton
                      message={`Delete all ${draftCount} draft proposal${draftCount === 1 ? "" : "s"} for ${accountName}? Sent / Won / Lost / Replaced revisions are historical and will be SPARED. This can't be undone.`}
                      pendingLabel="Deleting…"
                      className="inline-flex items-center px-3 py-1.5 rounded-lg border border-rose-200 bg-surface text-rose-700 text-[11px] font-semibold hover:bg-rose-50 min-h-[44px] sm:min-h-[32px]"
                    >
                      Delete {draftCount} draft{draftCount === 1 ? "" : "s"}
                    </ConfirmSubmitButton>
                  </form>
                )}
                {pickerDeals.length > 0 ? (
                  <NewProposalPicker
                    accounts={[{ id: accountId, company_name: accountName }]}
                    deals={pickerDeals}
                    lockedAccountId={accountId}
                    buttonLabel="+ Start proposal"
                  />
                ) : (
                  <span
                    className="inline-flex items-center px-3 py-1.5 rounded-lg border border-dashed border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-400 text-[11px] font-semibold"
                    title="Add an open opportunity in the Pipeline tab to start a proposal."
                  >
                    Add a deal first
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {proposals.length === 0 ? (
        <div className="bg-surface border border-dashed border-ppp-charcoal-200 rounded-xl p-8 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal mb-1">
            No proposals for {accountName} yet.
          </p>
          <p className="text-[13px] text-ppp-charcoal-500 max-w-md mx-auto">
            {pickerDeals.length > 0
              ? "Click + Start proposal above to build the first revision on an open opportunity."
              : "Add an open opportunity in the Pipeline tab, then start a proposal on it."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from(byDeal.entries()).map(([dealId, bucket]) => {
            if (!bucket.deal) return null;
            const dealTitle =
              bucket.deal.title?.trim() ||
              bucket.deal.client_name?.trim() ||
              bucket.deal.property_street?.trim() ||
              "(untitled opportunity)";
            // Karan 2026-07-17: killed the deal-hue border + tinted
            // header per meeting feedback ("looks really tacky"). Clean
            // neutral card now: white bg, single subtle border, standard
            // ppp-charcoal typography for the deal name. The current-row
            // emerald tint below still signals which revision is active.
            return (
              <section
                key={dealId}
                id={`deal-${dealId}`}
                className="bg-surface border border-ppp-charcoal-200 rounded-xl overflow-hidden shadow-sm scroll-mt-24"
              >
                <header className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap bg-surface">
                  <div className="min-w-0">
                    <Link
                      href={`/commercial/opportunities/${dealId}`}
                      className="block truncate text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-700"
                      title={dealTitle}
                    >
                      {dealTitle}
                    </Link>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                      {bucket.rows.length} revision{bucket.rows.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Link
                    href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new`}
                    className="text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 inline-flex items-center gap-1 min-h-[44px] px-1 -mr-1 touch-manipulation"
                  >
                    + New revision
                  </Link>
                </header>
                {(() => {
                  // Karan 2026-07-15 (Option A): pick the "current"
                  // revision = highest revision_number that's still
                  // non-terminal (draft/pending/sent) OR highest
                  // revision overall if all are terminal. This is
                  // what the cascade + kanban treat as the active
                  // proposal for this deal. Renders expanded up top
                  // with a "Current" pill; older revs collapse into
                  // a <details> below to cut clutter.
                  const NON_TERMINAL = new Set(["draft", "pending_approval", "approved", "sent"]);
                  const rows = bucket.rows; // already sorted revision desc
                  const currentIdx = rows.findIndex((r) => NON_TERMINAL.has(r.status));
                  const currentRow = currentIdx >= 0 ? rows[currentIdx]! : rows[0]!;
                  const olderRows = rows.filter((r) => r.id !== currentRow.id);
                  // Karan 2026-07-17 (round 2): full row redesign — prior
                  // layout crammed R# + Current pill + status pill +
                  // project name + sent date + total all on one line
                  // which read as noise. Two-line rows now: primary
                  // row (revision + status + total + actions), caption
                  // row (project name / GC name), so the hierarchy is
                  // scannable at a glance.
                  // Revision numbering starts only once the CLIENT has been
                  // sent something on this deal (Karan 2026-08) — `rows` is
                  // already scoped to one deal, so this is the right set.
                  const dealAnySent = rows.some((x) => x.sent_at != null);
                  const renderRow = (r: typeof rows[number], isCurrent: boolean) => {
                    const projectName = r.header_json?.project_name?.trim();
                    const gcCompany = r.header_json?.gc_company?.trim();
                    // Karan 2026-07-17: hide the caption if it just
                    // duplicates the deal title (very common — Alex
                    // often names proposals the same as the deal).
                    // Prevents visual noise like "Testtt 5" showing
                    // twice per row (header + row caption).
                    const captionRaw = projectName || gcCompany || null;
                    const caption =
                      captionRaw && captionRaw !== dealTitle ? captionRaw : null;
                    // Karan 2026-07-17: Make Current now works from
                    // ANY older revision (draft / pending / sent /
                    // won / lost / expired) — it creates a fresh R+1
                    // draft based on the picked revision, giving a
                    // clean path to reopen a Lost bid or spin off a
                    // revised copy of a Won proposal. Superseded is
                    // still excluded (it's already a historical
                    // replacement — no reason to bump twice).
                    const canMakeCurrent = !isCurrent && r.status !== "superseded";
                    // Copy label — "Make current" for open work,
                    // "Reopen" for closed outcomes so the button reads
                    // like the action it performs.
                    const bumpLabel =
                      r.status === "lost" || r.status === "won" || r.status === "expired"
                        ? "Reopen as R+1"
                        : "Make current";
                    // Only render "sent Jul 15" chip when the row's
                    // current status is sent-derived (sent/won/lost/
                    // expired). Draft/Pending rows with a stale sent_at
                    // (reverted via kanban) hide it — proposal isn't
                    // currently out with the customer.
                    const showSentDate =
                      r.sent_at &&
                      (r.status === "sent" ||
                        r.status === "won" ||
                        r.status === "lost" ||
                        r.status === "expired");
                    const editorHref = `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${r.id}`;
                    return (
                      <li
                        key={r.id}
                        className={
                          isCurrent
                            ? "border-l-4 border-emerald-500 bg-emerald-50/50 hover:bg-emerald-50 transition-colors"
                            : "hover:bg-ppp-charcoal-50/60 transition-colors"
                        }
                      >
                        <div className="flex items-stretch">
                          {/* Primary content — clickable, opens the editor */}
                          <Link
                            href={editorHref}
                            className={`flex-1 min-w-0 flex flex-col justify-center ${isCurrent ? "px-4 py-3" : "px-4 py-2"} min-h-[52px]`}
                          >
                            {/* Row 1: R# + Current pill + status pill + total.
                                2026-07-21 audit: flex-wrap so the total drops
                                to a second line on a narrow phone instead of
                                clipping (all chips are shrink-0). */}
                            <div className="flex items-center gap-2 gap-y-1 min-w-0 flex-wrap">
                              {/* No R# until the client has seen something on
                                  this deal (Karan 2026-08). */}
                              <span className={`font-bold text-ppp-charcoal tabular-nums shrink-0 ${isCurrent ? "text-[15px]" : "text-[12.5px] text-ppp-charcoal-600"}`}>
                                {proposalRevisionLabel(r, dealAnySent) || "Proposal"}
                              </span>
                              {proposalDisplayId(r) && (
                                <span className="font-mono text-[10px] text-ppp-navy-600 shrink-0" title="Global proposal number">
                                  {proposalDisplayId(r)}
                                </span>
                              )}
                              {isCurrent && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wider bg-emerald-600 text-white shrink-0">
                                  <IconStar size={9} className="shrink-0" /> Current
                                </span>
                              )}
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 ${pillCls(r.status)}`}
                              >
                                {proposalStatusLabel(r.status)}
                              </span>
                              {showSentDate && (
                                <span className="text-[10.5px] text-ppp-charcoal-500 shrink-0">
                                  sent {new Date(r.sent_at!).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                                </span>
                              )}
                              <span
                                className={`ml-auto font-semibold tabular-nums shrink-0 ${r.total_cents ? "text-ppp-charcoal-800" : "text-ppp-charcoal-400"} ${isCurrent ? "text-[15px]" : "text-[12.5px]"}`}
                                title={r.total_cents ? undefined : "Not priced yet — no line items"}
                              >
                                {r.total_cents ? fmt(r.total_cents) : "—"}
                              </span>
                            </div>
                            {/* Row 2: caption (project name or GC) — only render if there IS a caption */}
                            {caption && (
                              <div
                                className={`truncate mt-0.5 ${isCurrent ? "text-[12.5px] font-semibold text-ppp-charcoal-700" : "text-[11.5px] text-ppp-charcoal-500"}`}
                                title={caption}
                              >
                                {caption}
                              </div>
                            )}
                          </Link>
                          {/* Action buttons — vertically centered */}
                          <div className="flex items-center border-l border-ppp-charcoal-100">
                            {canMakeCurrent && (
                              <Link
                                href={`/commercial/accounts/${accountId}/deals/${dealId}/proposal/new?bump=${r.id}`}
                                className="inline-flex items-center justify-center gap-1 px-3 min-w-[44px] h-full text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 border-r border-ppp-charcoal-100 touch-manipulation"
                                title={
                                  bumpLabel === "Reopen as R+1"
                                    ? `Reopen R${r.revision_number} as a new R+1 draft — line items copy forward, parent deal returns to Estimating.`
                                    : `Bump R${r.revision_number} forward as a new revision — becomes the current draft.`
                                }
                                aria-label={`${bumpLabel}: use R${r.revision_number} as the base for a new revision`}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <polyline points="9 18 15 12 9 6" />
                                </svg>
                                <span className="hidden sm:inline">{bumpLabel}</span>
                              </Link>
                            )}
                            {/* Won proposal → hand off to invoicing so there's
                                a "bill this opportunity" path right where the win is
                                (audit fix — no more leaving for the Invoices
                                tab with no link). */}
                            {r.status === "won" && (
                              <Link
                                href={`/commercial/opportunities/${dealId}?tab=invoices#deal-invoices`}
                                className="inline-flex items-center justify-center gap-1 px-3 min-w-[44px] h-full text-[11px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 border-r border-ppp-charcoal-100 touch-manipulation"
                                title="Create an invoice for this opportunity"
                                aria-label={`Bill this deal from revision ${r.revision_number}`}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                                </svg>
                                <span className="hidden sm:inline">Bill this opportunity</span>
                              </Link>
                            )}
                            <a
                              // A non-draft proposal serves the FROZEN snapshot the GC received —
                              // a live re-render could show different exclusions/prices than what
                              // was sent. Matches the global proposals list branching (R5).
                              href={r.status !== "draft" && r.snapshot_document_id
                                ? `/api/commercial/documents/${r.snapshot_document_id}/download`
                                : `/api/commercial/proposals/${r.id}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center gap-1 px-3 min-w-[44px] h-full text-[11px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 hover:bg-cc-brand-50 touch-manipulation"
                              title="Open the customer PDF in a new tab"
                              aria-label={`Open PDF for revision ${r.revision_number}`}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                              </svg>
                              <span className="hidden sm:inline">PDF</span>
                            </a>
                          </div>
                        </div>
                      </li>
                    );
                  };
                  return (
                    <>
                      <ul className="divide-y divide-ppp-charcoal-100">
                        {renderRow(currentRow, true)}
                      </ul>
                      {olderRows.length > 0 && (
                        <details className="group/older bg-ppp-charcoal-50/40 border-t border-ppp-charcoal-100">
                          <summary className="cursor-pointer px-4 py-2 text-[11px] font-semibold text-ppp-charcoal-500 hover:bg-ppp-charcoal-100/40 list-none [&::-webkit-details-marker]:hidden flex items-center justify-between min-h-[44px] sm:min-h-[36px]">
                            <span>
                              Older revisions · {olderRows.length}
                            </span>
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                              className="text-ppp-charcoal-400 transition-transform group-open/older:rotate-180"
                            >
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </summary>
                          <ul className="divide-y divide-ppp-charcoal-100 bg-surface">
                            {olderRows.map((r) => renderRow(r, false))}
                          </ul>
                        </details>
                      )}
                    </>
                  );
                })()}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
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
          <strong className="inline-flex items-center gap-1"><IconClock size={13} className="shrink-0" /> Expired:</strong>{" "}
          {expired.map((e) => documentCategoryLabel(e.category)).join(", ")}. Upload a new version to clear.
        </div>
      )}
      {expiringSoon.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <strong className="inline-flex items-center gap-1"><IconAlertTriangle size={13} className="shrink-0" /> Expiring soon:</strong>{" "}
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
      <details className="bg-surface border border-ppp-charcoal-100 rounded-lg overflow-hidden group">
        <summary className="px-4 py-2 cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
          <span>What do the badges mean?</span>
          <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
        </summary>
        <ul className="px-4 py-3 border-t border-ppp-charcoal-100 text-[12px] text-ppp-charcoal-700 space-y-1.5">
          <li>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200 mr-1">
              v3
            </span>
            Active version. Highest version number wins. Older versions stack into &ldquo;History&rdquo;.
          </li>
          <li>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-100 text-cc-brand-800 border-cc-brand-200 mr-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden><path d="M20 6 9 17l-5-5" /></svg> Valid 6mo
            </span>
            Document is in good standing &mdash; expires more than 30 days out (or never).
          </li>
          <li className="text-amber-800">
            <strong className="inline-flex items-center gap-1"><IconAlertTriangle size={13} className="shrink-0" /> Expires in N days</strong> &middot; within 30 days. Plan a renewal now.
          </li>
          <li className="text-rose-700">
            <strong className="inline-flex items-center gap-1"><IconClock size={13} className="shrink-0" /> Expired N days ago</strong> &middot; document is past its expiry date. Upload a new version.
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
    // Karan 2026-07-08: id + scroll-mt so the compliance checklist's
    // "Upload →" quick-links (href=?tab=documents#upload-{category})
    // land on the right card with breathing room from the sticky tab
    // bar. Without this, the anchor pointed at a non-existent DOM node.
    <section id={`upload-${category}`} className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden scroll-mt-24">
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
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-rose-50 text-rose-700 border-rose-200">
          <IconClock size={12} className="shrink-0" /> Expired {n}d ago
        </span>
      );
    }
    if (exp.status === "soon") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-amber-50 text-amber-800 border-amber-200">
          <IconAlertTriangle size={12} className="shrink-0" /> Expires in {exp.daysUntil}d
        </span>
      );
    }
    if (doc.expires_at) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden><path d="M20 6 9 17l-5-5" /></svg> Valid
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
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200">
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
          className="text-sm font-medium text-cc-brand-700 hover:text-cc-brand-800 break-all"
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
          <SubmitButton
            className="w-full sm:w-auto px-3 py-2 text-[12px] font-medium text-cc-brand-700 border border-cc-brand-200 rounded-lg hover:bg-cc-brand-50 min-h-[44px] touch-manipulation whitespace-nowrap"
            title="Make this the active version. Adds a new entry to the chain so the audit trail stays intact."
          >
            Restore as active
          </SubmitButton>
        </form>
      )}
      {isActive && !doc.archived && (
        <form action={archiveDocumentAction} className="shrink-0 w-full sm:w-auto">
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="document_id" value={doc.id} />
          <SubmitButton
            className="w-full sm:w-auto px-3 py-2 text-[12px] font-medium text-ppp-charcoal-700 border border-ppp-charcoal-100 rounded-lg hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation whitespace-nowrap"
            title="Archive without replacement. File stays downloadable in History."
          >
            Archive
          </SubmitButton>
        </form>
      )}
    </div>
  );
}


/**
 * Karan 2026-07-08: inline-edit Card with AUTOSAVE. When `section` +
 * `accountId` are provided, the card body wraps its children in a
 * client autosave form that submits to updateAccountSectionAction on
 * blur (when any input changes). No Save buttons — user just tabs
 * away and the value persists. A "Saving…" → "Saved ✓" chip shows
 * at the top-right of the card body.
 */
function Card({
  title,
  children,
  className,
  section,
  accountId,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  section?: string;
  accountId?: string;
}) {
  const isEditable = !!section && !!accountId;
  const body = (
    <>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-sm font-bold text-ppp-charcoal">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </>
  );
  if (isEditable) {
    return (
      <section
        id={`card-${section}`}
        className={`bg-surface border border-ppp-charcoal-100 rounded-xl p-5 focus-within:border-cc-brand-300 transition-colors ${className ?? ""}`}
      >
        <AccountInlineCardForm action={updateAccountSectionAction}>
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="section" value={section as string} />
          {body}
        </AccountInlineCardForm>
      </section>
    );
  }
  return (
    <section className={`bg-surface border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      {body}
    </section>
  );
}

/** Karan 2026-07-08: stacked label + input, autosave-friendly. Reads
 *  clean at rest (input has subtle background so it's visibly clickable),
 *  visible border + ring on focus. Full-width so labels never crowd
 *  each other on address rows. */
function EditableField({
  name,
  label,
  defaultValue,
  type = "text",
  placeholder = "not set",
  required = false,
}: {
  name: string;
  label: string;
  defaultValue: string | null;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[10.5px] uppercase tracking-wider font-bold text-ppp-charcoal-500 mb-1">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm rounded-md border border-ppp-charcoal-200 bg-ppp-charcoal-50/40 hover:bg-surface hover:border-ppp-charcoal-300 focus:bg-surface focus:border-cc-brand-500 focus:outline-none focus:ring-2 focus:ring-cc-brand-600/25 placeholder:text-ppp-charcoal-500 placeholder:italic min-h-[44px] text-ppp-charcoal transition-colors"
      />
    </label>
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
            className="text-cc-brand-700 hover:text-cc-brand-800 break-all"
          >
            {value}
          </a>
        ) : (
          <span className="text-ppp-charcoal break-words">{value}</span>
        )
      ) : (
        <span className="text-ppp-charcoal-500 italic text-[12px]">not set</span>
      )}
    </div>
  );
}

// AccountComplianceBanner removed in Phase A (2026-07-09) with the rest
// of the account-level compliance UI. Compliance surfaces move to the
// Documents scope (per Opportunity / per Project) in Phase C. Function
// deleted 2026-07-09 PM after post-Phase-A.1 UI/UX audit flagged the
// ~70-line orphan.

/** "67% win · ~32d to close" subtitle when there's history; "" when none. */
function renderWinRateSub(overview: AccountOverview): string | undefined {
  const rate = winRate(overview);
  const avg = overview.avg_days_to_close;
  if (rate === null && (avg === null || avg === undefined)) return undefined;
  const rateText = rate === null ? null : `${Math.round(rate * 100)}% win`;
  const avgText = avg === null || avg === undefined ? null : `~${Math.round(avg)}d close`;
  return [rateText, avgText].filter(Boolean).join(" · ");
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "emerald" | "blue" | "amber" | "rose" | "neutral" }) {
  // Karan 2026-06-24: boosted saturation from -50/-700/-200 to
  // -100/-800/-300 to match the brighter status pills on opp page.
  // Karan 2026-07-10 audit fix: `emerald` was silently rendering blue
  // — the tone key literally mapped to bg-cc-brand-100/text-cc-brand-800. Any
  // consumer asking for the emerald-scored variant (Rating A on the
  // account financial snapshot, etc.) got the wrong color for weeks.
  const cls = {
    emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
    blue: "bg-ppp-blue-100 text-ppp-blue-800 border-ppp-blue-200",
    amber: "bg-amber-100 text-amber-900 border-amber-300",
    rose: "bg-rose-100 text-rose-800 border-rose-300",
    neutral: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}`}>
      {children}
    </span>
  );
}

function ratingTone(r: "A" | "B" | "C"): "emerald" | "blue" | "amber" {
  return r === "A" ? "emerald" : r === "B" ? "blue" : "amber";
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
  paymentHeadsUp = null,
  errorMessage,
}: {
  accountId: string;
  rollup: AccountInvoiceRollup;
  paymentOk?: boolean;
  paymentCapped?: boolean;
  paymentRequested?: number | null;
  paymentApplied?: number | null;
  paymentHeadsUp?: string | null;
  errorMessage?: string;
}) {
  const [invoices, accountOpps] = await Promise.all([
    listCommercialInvoices({ accountId }),
    listCommercialOpportunities({ accountId }),
  ]);
  const paidPct =
    rollup.invoiced_cents > 0
      ? Math.min(100, Math.round((rollup.paid_cents / rollup.invoiced_cents) * 100))
      : 0;
  // Karan 2026-07-09: group by DEAL instead of status. Each deal that has
  // billing history renders as its own section — deal title, mini
  // roll-up (invoiced/paid/balance), then the invoices. A single
  // "Orphaned" section catches any invoice whose parent opp was deleted
  // so nothing goes hidden.
  const oppById = new Map(accountOpps.map((o) => [o.id, o]));
  const dealGroups = new Map<string, CommercialInvoice[]>();
  const orphaned: CommercialInvoice[] = [];
  for (const inv of invoices) {
    if (inv.opportunity_id && oppById.has(inv.opportunity_id)) {
      const arr = dealGroups.get(inv.opportunity_id) ?? [];
      arr.push(inv);
      dealGroups.set(inv.opportunity_id, arr);
    } else {
      orphaned.push(inv);
    }
  }
  // Sort deals: most-recent invoice first (so the deal you're actively
  // billing floats to the top).
  const dealOrder = Array.from(dealGroups.entries()).sort((a, b) => {
    const aLatest = Math.max(...a[1].map((i) => new Date(i.created_at).getTime()));
    const bLatest = Math.max(...b[1].map((i) => new Date(i.created_at).getTime()));
    return bLatest - aLatest;
  });
  return (
    <div className="space-y-4">
      {/* Flash toasts from the inline "Record payment" action. Same
          shape as the invoice-detail flash — emerald for success,
          amber for the overpayment-capped edge case. */}
      {paymentOk && !paymentCapped && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            <span>Payment recorded.</span>
          </span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=invoices`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {paymentOk && paymentCapped && paymentRequested !== null && paymentApplied !== null && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
          <div className="flex items-center gap-2 font-semibold">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            <span>Payment recorded — capped to invoice balance</span>
          </div>
          <div className="mt-1 text-[12.5px] text-amber-800">
            You entered <span className="font-mono">${((paymentRequested ?? 0) / 100).toFixed(2)}</span>{" "}
            but only <span className="font-mono">${((paymentApplied ?? 0) / 100).toFixed(2)}</span> was owed. The extra{" "}
            <span className="font-mono">${(((paymentRequested ?? 0) - (paymentApplied ?? 0)) / 100).toFixed(2)}</span> was not recorded.
          </div>
        </div>
      )}
      {paymentHeadsUp && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-[12.5px] text-amber-900 flex items-start gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 mt-0.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>{paymentHeadsUp}</span>
        </div>
      )}
      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
          <span>{errorMessage}</span>
          <Link
            href={`/commercial/accounts/${accountId}?tab=invoices`}
            className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      {/* Rollup strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RollupTile label="Invoiced" value={formatCentsFull(rollup.invoiced_cents)} sub={`${rollup.invoice_count} invoice${rollup.invoice_count === 1 ? "" : "s"}`} tone="neutral" />
        <RollupTile label="Paid" value={formatCentsFull(rollup.paid_cents)} sub={`${paidPct}% collected`} tone="emerald" />
        <RollupTile label={rollup.open_balance_cents === 0 && rollup.credit_cents > 0 ? "Credit" : "Balance"} value={formatCentsFull(rollup.open_balance_cents > 0 ? rollup.open_balance_cents : rollup.credit_cents)} sub={rollup.open_balance_cents > 0 ? (rollup.credit_cents > 0 ? `unpaid · ${formatCentsFull(rollup.credit_cents)} credit` : "unpaid") : rollup.credit_cents > 0 ? "overpaid" : "settled"} tone={rollup.open_balance_cents > 0 ? "warn" : rollup.credit_cents > 0 ? "emerald" : "neutral"} />
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
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
        >
          Full invoicing surface →
        </Link>
        {/* Open-invoice AR statement (Phase 1C) — branded PDF of everything the
            GC still owes. Gate on the TRUE open balance (Σ per-invoice max(0,…)),
            not the netted balance, so a credit on one invoice can't hide a real
            open balance on another + wrongly suppress the link (audit F3). */}
        {rollup.open_balance_cents > 0 && (
          <a
            href={`/api/commercial/accounts/${accountId}/statement`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6" />
            </svg>
            Statement
          </a>
        )}
      </div>

      {/* Empty state */}
      {invoices.length === 0 && (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <div className="flex justify-center mb-2 text-ppp-charcoal-300" aria-hidden><IconFileDoc size={36} /></div>
          <div className="text-sm font-semibold text-ppp-charcoal">No invoices yet</div>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 max-w-md mx-auto">
            Convert a Won deal into an invoice from the Deals tab, or start a new one above.
          </p>
        </div>
      )}

      {/* Deal-grouped invoice list. Each deal that has been billed shows
          its own section — Karan 2026-07-09: "under the accounts invoices
          tab the two deals with separate invoice(s) for each". */}
      {invoices.length > 0 && (
        <div className="space-y-4">
          {dealOrder.map(([oppId, dealInvoices]) => {
            const opp = oppById.get(oppId)!;
            const issued = dealInvoices.filter((i) => i.status !== "void" && i.status !== "draft");
            const dealInvoiced = issued.reduce((s, i) => s + i.total_cents, 0);
            const dealPaid = issued.reduce((s, i) => s + i.paid_cents, 0);
            // Per-invoice clamped, issued-only — one "Outstanding" definition
            // everywhere (a credit/deduct invoice can't understate the balance).
            // dealCredit = Σ max(0, −balance): an overpayment, surfaced separately.
            const { openBalance: dealBalance, credit: dealCredit } = splitOpenBalance(issued.map((i) => i.balance_cents));
            const dealOverdue = dealInvoices.some((i) => deriveInvoiceStatus(i) === "overdue");
            const dealPct = dealInvoiced > 0 ? Math.min(100, Math.round((dealPaid / dealInvoiced) * 100)) : 0;
            const barTone = dealPaid >= dealInvoiced && dealInvoiced > 0
              ? "bg-emerald-500"
              : dealOverdue
              ? "bg-rose-500"
              : dealPaid > 0
              ? "bg-ppp-blue-500"
              : "bg-ppp-charcoal-300";
            return (
              <section
                key={oppId}
                className={`rounded-xl overflow-hidden border ${dealOverdue ? "border-rose-200" : "border-ppp-charcoal-100"} bg-surface`}
              >
                <div className={`px-4 py-3 border-b ${dealOverdue ? "border-rose-200 bg-rose-50/40" : "border-ppp-charcoal-100 bg-gradient-to-br from-surface to-ppp-charcoal-50/60"}`}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <Link
                          href={`/commercial/opportunities/${opp.id}?tab=invoices`}
                          title={derivedOppName(opp, null)}
                          className="text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-700 hover:underline underline-offset-2 truncate"
                        >
                          {/* Phase B derived-name (Karan 2026-07-10 audit
                              fix). accountName=null on account-context. */}
                          {derivedOppName(opp, null)}
                        </Link>
                        <span className="text-[10px] font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-100 border border-ppp-charcoal-200 rounded px-1.5 py-0.5">
                          {dealInvoices.length} invoice{dealInvoices.length === 1 ? "" : "s"}
                        </span>
                        {dealOverdue && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800 bg-rose-100 border border-rose-300 rounded px-1.5 py-0.5">
                            Overdue
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11.5px] text-ppp-charcoal-600 tabular-nums">
                        <strong className="text-ppp-charcoal">{formatCentsFull(dealPaid)}</strong>
                        <span className="text-ppp-charcoal-500"> of {formatCentsFull(dealInvoiced)}</span>
                        {dealBalance > 0 && (
                          <span className="text-ppp-charcoal-500">
                            {" · "}
                            <strong className={dealOverdue ? "text-rose-700" : "text-ppp-charcoal"}>
                              {formatCentsFull(dealBalance)}
                            </strong>{" "}
                            owed
                          </span>
                        )}
                        {dealCredit > 0 && (
                          <span className="text-ppp-charcoal-500">
                            {" · "}
                            <strong className="text-emerald-700">{formatCentsFull(dealCredit)}</strong>{" "}
                            credit
                          </span>
                        )}
                      </div>
                    </div>
                    <Link
                      href={`/commercial/invoices/new?opp=${opp.id}`}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-cc-brand-200 text-[11.5px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[44px] sm:min-h-[36px] touch-manipulation"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 5v14 M5 12h14" />
                      </svg>
                      New invoice
                    </Link>
                  </div>
                  {dealInvoiced > 0 && (
                    <div className="mt-2 h-1.5 bg-ppp-charcoal-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${barTone}`} style={{ width: `${dealPct}%` }} />
                    </div>
                  )}
                </div>
                <ul className="divide-y divide-ppp-charcoal-100">
                  {dealInvoices
                    .sort((a, b) => a.created_at.localeCompare(b.created_at))
                    .map((inv) => (
                      <AccountInvoiceRow key={inv.id} invoice={inv} accountId={accountId} />
                    ))}
                </ul>
              </section>
            );
          })}
          {orphaned.length > 0 && (
            <section className="rounded-xl overflow-hidden border border-amber-200 bg-amber-50/20">
              <div className="px-4 py-2.5 border-b border-amber-200 bg-amber-50/40">
                <h3 className="text-[13px] font-bold text-amber-900">
                  Orphaned (parent deal deleted) · {orphaned.length}
                </h3>
              </div>
              <ul className="divide-y divide-ppp-charcoal-100">
                {orphaned.map((inv) => (
                  <AccountInvoiceRow key={inv.id} invoice={inv} accountId={accountId} />
                ))}
              </ul>
            </section>
          )}
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
      : "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200";
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
      <div className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-cc-brand-50/40 transition-colors">
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
                <div className="h-full bg-emerald-500" style={{ width: `${paidPct}%` }} aria-label={`${paidPct}% paid`} />
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
              <summary className="list-none cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[44px] sm:min-h-[28px] touch-manipulation">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 5v14 M5 12h14" />
                </svg>
                Record payment
              </summary>
              <form
                action={recordPaymentInlineAction}
                className="mt-2 bg-surface border border-ppp-charcoal-100 rounded-lg shadow-sm p-3 space-y-2 w-full sm:w-[260px] text-left"
              >
                <input type="hidden" name="account_id" value={accountId} />
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <div className="text-[10.5px] text-ppp-charcoal-500">
                  Balance owed: <strong className="text-ppp-charcoal">{formatCentsFull(invoice.balance_cents)}</strong>
                </div>
                <label className="block">
                  <span className="text-[12px] font-semibold text-ppp-charcoal-700">Amount</span>
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
                    <span className="text-[12px] font-semibold text-ppp-charcoal-700">Date</span>
                    <DateField ariaLabel="Payment date" name="paid_at" defaultValue={new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })} placeholder="Pick a date" className="mt-0.5" />
                  </label>
                  <label className="block">
                    <span className="text-[12px] font-semibold text-ppp-charcoal-700">Method</span>
                    <select
                      name="method"
                      defaultValue=""
                      className="w-full mt-0.5 px-2 py-1.5 pr-8 text-[13px] bg-surface border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 appearance-none bg-no-repeat cursor-pointer"
                      style={SELECT_BG_STYLE}
                    >
                      <option value="">Choose method</option>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="text-[12px] font-semibold text-ppp-charcoal-700">Reference (optional)</span>
                  <input
                    type="text"
                    name="reference"
                    maxLength={120}
                    placeholder="Check #, transaction ID…"
                    className="w-full mt-0.5 px-2 py-1.5 text-[13px] border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
                  />
                </label>
                <PendingSubmitButton
                  className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation disabled:hover:bg-cc-brand-600"
                  pendingLabel="Recording…"
                >
                  Record payment
                </PendingSubmitButton>
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
  sub?: string;
  tone: "neutral" | "blue" | "emerald" | "warn" | "danger";
}) {
  // Color-audit 2026-07-28: "blue" now uses the real brand cyan (ppp-blue),
  // not cc-brand red; added "emerald" for positive money (Paid). Value type is
  // Roboto Condensed black to match the dashboard KPI treatment.
  const ring =
    tone === "blue"
      ? "border-ppp-blue-200 bg-gradient-to-br from-surface to-ppp-blue-50/50"
      : tone === "emerald"
      ? "border-emerald-200 bg-gradient-to-br from-surface to-emerald-50/50"
      : tone === "warn"
      ? "border-amber-200 bg-gradient-to-br from-surface to-amber-50/40"
      : tone === "danger"
      ? "border-rose-200 bg-gradient-to-br from-surface to-rose-50/50"
      : "border-ppp-charcoal-100 bg-surface";
  const stripe =
    tone === "blue" ? "bg-ppp-blue-500" : tone === "emerald" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : tone === "danger" ? "bg-rose-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">
        {label}
      </div>
      <div className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal mt-1 leading-none tabular-nums">
        {value}
      </div>
      {sub && <div className="text-[11px] text-ppp-charcoal-500 mt-1">{sub}</div>}
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
async function AccountKpisTab({
  accountId,
  overview,
  rollup,
}: {
  accountId: string;
  overview: AccountOverview | null;
  rollup: AccountInvoiceRollup;
}) {
  // ── Data ── one project fetch (incl. closed jobs) + the account's invoices.
  // "Under contract" is scoped to ACTIVE jobs; the P&L gross spans ALL deals
  // incl. closed (a finished job's revenue is still revenue) so a closed deal's
  // own P&L stays a subset of the account's — deal ⊂ account ⊂ portfolio
  // (2026-08 money audit #5). Costs MUST be scoped to the SAME live deal rows the
  // gross covers (costBreakdownForOpps) — costBreakdownForAccount counted costs
  // account-wide, so a soft-deleted deal's orphaned purchases inflated account
  // net/margin even though its gross had dropped out (audit #3).
  // "Under contract" / production is scoped to real jobs (post-sale/won). The
  // P&L rollup uses EVERY deal (allDeals) — the same universe the deal drill-in
  // P&L is reachable on — so a pre-sale bid's costs (and its typically-$0 billed
  // gross) roll into the account too; otherwise a cost shown in a bid's own P&L
  // would be missing from the account/portfolio and break deal ⊂ account (audit #6).
  const [allAccountRows, pnlRows] = await Promise.all([
    listProjects({ accountId, includeClosed: true }),
    listProjects({ accountId, includeClosed: true, allDeals: true }),
  ]);
  const activeRows = allAccountRows.filter((p) => p.opp.status !== "post_sale_closed");
  const production = summarizeProduction(activeRows);
  const [accountInvoices, accountCosts] = await Promise.all([
    listCommercialInvoices({ accountId }),
    costBreakdownForOpps(pnlRows.map((p) => p.opp.id)),
  ]);
  // ── Account-wide P&L (all this GC's deals combined) — Gross = billed pre-tax,
  // Net = billed − costs. Same definitions as the deal P&L + Revenue page. ──
  const acctGrossCents = pnlRows.reduce((acc, p) => acc + p.billedContractCents, 0);
  // Field-ops crew labor (Option A) is folded into each row's costsCents, so
  // summing the rows' labor gives the account crew-labor total — Σ p.costsCents =
  // purchases (accountCosts.total) + crew labor, keeping deal ⊂ account exact.
  const acctCrewLaborCents = pnlRows.reduce((acc, p) => acc + p.fieldOpsLaborCents, 0);
  const acctLaborUnratedHours = pnlRows.reduce((acc, p) => acc + p.laborUnratedHours, 0);
  const acctCostsCents = accountCosts.total + acctCrewLaborCents;
  const acctNetCents = acctGrossCents - acctCostsCents;
  // Same margin rule as the deal surfaces. This block used to print "100% ·
  // net ÷ gross" beside "Job costs $0 · none logged" — arithmetically true and
  // completely misleading: it means nothing has been spent yet, not that the
  // work is all profit.
  const acctMargin = marginFrom(acctGrossCents, acctCostsCents);
  const acctMarginPct = acctMargin.pct;
  const acctMarginTone: ChartTone =
    acctMarginPct === null || acctMargin.provisional
      ? "neutral"
      : acctMargin.overBudget || acctMarginPct < 0
        ? "rose"
        : acctMarginPct < 15
          ? "amber"
          : "emerald";
  const acctMarginDisplay =
    acctMarginPct === null ? "—" : acctMargin.overBudget ? "Over budget" : `${acctMarginPct}%`;
  const acctRevenueMonthly = monthlyBilledSeries(accountInvoices);
  const acctCostSegments: DonutSegment[] = [
    ...PURCHASE_CATEGORIES.filter((c) => accountCosts[c] > 0).map((c) => ({
      label: PURCHASE_CATEGORY_META[c].label,
      value: accountCosts[c],
      tone: PNL_COST_TONE[c] ?? "neutral",
      valueLabel: formatCentsCompact(accountCosts[c]),
    })),
    ...(acctCrewLaborCents > 0
      ? [{ label: "Crew labor", value: acctCrewLaborCents, tone: CREW_LABOR_TONE, valueLabel: formatCentsCompact(acctCrewLaborCents) }]
      : []),
  ];

  // winRate() returns a 0..1 decimal — ×100 for display.
  const winRateRaw = overview ? winRate(overview) : null;
  const winRatePct = winRateRaw === null ? null : Math.round(winRateRaw * 100);
  const paidPct = rollup.invoiced_cents > 0 ? Math.min(100, Math.round((rollup.paid_cents / rollup.invoiced_cents) * 100)) : 0;
  const decidedCount = (overview?.won_opps_count ?? 0) + (overview?.lost_opps_count ?? 0);
  const bidLow = overview?.total_active_bid_low_cents ?? 0;
  const bidHigh = overview?.total_active_bid_high_cents ?? 0;
  // The SQL view sums the raw bid low/high columns, and the create forms stopped
  // collecting them — pricing lives on the proposal now. So this tile read "—"
  // beside an "Open bids: 3" count taken from the same status set, with live
  // money showing on every deal block below it. Same proposal fallback the rest
  // of the platform uses.
  const openBidOpps = (await listCommercialOpportunities({ accountId })).filter((o) =>
    PRE_SALE_OPEN_STATUSES.includes(o.status)
  );
  const openProposalTotals = await listCurrentProposalTotalByOpp(openBidOpps.map((o) => o.id));
  const fallbackTotal = openBidOpps.reduce(
    (sum, o) => sum + dealValueCents(o, openProposalTotals.get(o.id) ?? null),
    0
  );
  const bidRangeLabel =
    bidLow > 0 || bidHigh > 0
      ? `${formatCentsFull(bidLow)} – ${formatCentsFull(bidHigh)}`
      : fallbackTotal > 0
        ? formatCentsFull(fallbackTotal)
        : "—";
  const hasInvoicing = rollup.invoiced_cents > 0;
  const isCredit = rollup.open_balance_cents === 0 && rollup.credit_cents > 0;
  const hasContract = production.contractValueCents > 0;
  // Per-project over-billing (never Σbilled − Σcontract, which nets an
  // under-billed deal against an over-billed one — 2026-08 money audit #3).
  const overBilledCents = production.overBilledCents;
  const billedOfContractPct = production.contractValueCents > 0 ? Math.min(100, Math.round((production.billedContractCents / production.contractValueCents) * 100)) : 0;
  const openBidCount = overview?.open_opps_count ?? 0;

  // Overdue vs current split of the open balance, so the Collections donut can
  // label only the genuinely-overdue portion "Overdue" instead of the whole
  // open balance (2026-08 UI/UX audit). Per-invoice clamped, issued-only.
  const overdueBalanceCents = accountInvoices
    .filter((i) => deriveInvoiceStatus(i) === "overdue")
    .reduce((s, i) => s + Math.max(0, i.balance_cents), 0);
  const currentOpenCents = Math.max(0, rollup.open_balance_cents - overdueBalanceCents);

  // Monthly billing trend ($K) — pre-tax, ET-bucketed, issued-only (shared
  // helper). Same basis as the Profitability trend so a Collections "billed"
  // chart never disagrees with it over pass-through tax (money audit #6).
  const billedMonthly = acctRevenueMonthly;
  const billedTrendHasData = billedMonthly.some((p) => p.value > 0);

  // Per-project billing bars (biggest contract first) — active jobs only, to
  // match the "Under contract" section this renders in.
  const projectBars = activeRows
    .filter((p) => (p.contractToDateCents ?? 0) > 0)
    .sort((a, b) => (b.contractToDateCents ?? 0) - (a.contractToDateCents ?? 0))
    .slice(0, 6)
    .map((p) => {
      const contract = p.contractToDateCents ?? 0;
      const billed = p.billedContractCents ?? 0;
      const pctBilled = contract > 0 ? Math.min(100, Math.round((billed / contract) * 100)) : 0;
      return {
        label: derivedOppName(p.opp, ""),
        value: contract,
        tone: (pctBilled >= 100 ? "emerald" : "blue") as ChartTone,
        valueLabel: formatCentsCompact(contract),
        sub: `${formatCentsCompact(billed)} billed · ${pctBilled}%`,
        href: `/commercial/opportunities/${p.opp.id}`,
      };
    });

  return (
    <div className="space-y-4">
      {/* ── Profitability ── whole-account P&L: Gross (billed) / Costs / Net /
          Margin across ALL this GC's deals, + revenue line + margin gauge +
          cost donut. Same definitions as the deal P&L + Revenue page. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Profitability
          </h3>
          <span className="text-[11px] text-ppp-charcoal-500">all deals for this GC · Gross = billed, Net = billed − costs</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Gross revenue" value={formatCentsCompact(acctGrossCents)} tone="brand" sub="billed to date" spark={acctRevenueMonthly.map((r) => r.value)} sparkLabels={acctRevenueMonthly.map((r) => r.label)} />
          <StatCard label="Job costs" value={formatCentsCompact(acctCostsCents)} tone="amber" sub={acctCostsCents === 0 ? "none logged" : acctCrewLaborCents > 0 ? "materials · crew · subs" : "materials · subs"} />
          <StatCard label="Net profit" value={`${acctNetCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(acctNetCents))}`} tone={acctMargin.provisional ? "neutral" : acctNetCents < 0 ? "rose" : "emerald"} sub="gross − costs" />
          <StatCard
            label={acctMargin.label}
            value={acctMarginDisplay}
            tone={acctMarginTone}
            sub={acctMargin.caveat ?? "billed − costs"}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4 items-center">
          <div className="lg:col-span-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">Revenue billed / month · last 6 mo</div>
            <TrendChart data={acctRevenueMonthly} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[140px]" />
          </div>
          <div className="flex items-center gap-4 justify-center">
            <GaugeRing
              pct={acctMargin.overBudget ? 0 : (acctMarginPct ?? 0)}
              tone={acctMarginTone}
              value={acctMarginDisplay}
              label="margin"
              size={104}
            />
            {acctCostSegments.length > 0 ? (
              <DonutChart size={104} legend={false} segments={acctCostSegments} centerValue={formatCentsCompact(acctCostsCents)} centerLabel="costs" />
            ) : (
              <div className="text-[11px] text-ppp-charcoal-400 max-w-[100px]">Costs appear here as they&rsquo;re logged.</div>
            )}
          </div>
        </div>
        {acctLaborUnratedHours > 0 && (
          <p className="mt-3 text-[11.5px] text-amber-700 leading-snug">
            <span className="font-semibold">{acctLaborUnratedHours.toLocaleString()} approved crew hours</span> have no cost rate set, so labor cost and margin are understated. Set rates on the <Link href="/commercial/field-ops/employees" className="font-semibold underline">Crew</Link> page.
          </p>
        )}
      </section>

      {/* ── Collections ── KPI row + Paid/Balance donut + monthly billing trend.
          Always visible: the charts sit at 0 (empty ring, flat line) until there
          are invoices, so the page never looks blank. */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Collections
          </h3>
          <Link href={`/commercial/invoices?account_id=${accountId}`} className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Invoices →</Link>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <MiniFig label="Invoiced" value={formatCentsCompact(rollup.invoiced_cents)} tone="brand" sub={rollup.invoice_count > 0 ? `${rollup.invoice_count} invoice${rollup.invoice_count === 1 ? "" : "s"}` : "none yet"} />
          <MiniFig label="Paid" value={formatCentsCompact(rollup.paid_cents)} tone="emerald" sub={hasInvoicing ? `${paidPct}% collected` : "—"} />
          <MiniFig
            label={isCredit ? "Credit" : "Outstanding"}
            value={formatCentsCompact(isCredit ? rollup.credit_cents : rollup.open_balance_cents)}
            tone={isCredit ? "emerald" : rollup.open_balance_cents > 0 ? "blue" : "neutral"}
            sub={!hasInvoicing ? "not billed" : isCredit ? "overpaid" : rollup.open_balance_cents === 0 ? "settled" : "unpaid"}
          />
          <MiniFig label="Overdue" value={String(rollup.overdue_count)} tone={rollup.overdue_count > 0 ? "rose" : "neutral"} sub={rollup.overdue_count > 0 ? "past due" : "on track"} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-center mt-4">
          <div className="lg:col-span-2 flex items-center justify-center">
            <DonutChart
              size={150}
              segments={[
                // Paid = payment APPLIED within invoices (paid − credit) so an
                // overpaid invoice's credit can't over-draw the ring; the credit
                // shows in the KPI box above. Open balance splits into on-time
                // (blue) vs genuinely overdue (rose) — only the overdue portion is
                // labeled "Overdue", never the whole balance (2026-08 audits).
                { label: "Paid", value: Math.max(0, rollup.paid_cents - rollup.credit_cents), tone: "emerald", valueLabel: formatCentsCompact(Math.max(0, rollup.paid_cents - rollup.credit_cents)) },
                ...(currentOpenCents > 0
                  ? [{ label: "Open (current)", value: currentOpenCents, tone: "blue" as ChartTone, valueLabel: formatCentsCompact(currentOpenCents) }]
                  : []),
                ...(overdueBalanceCents > 0
                  ? [{ label: "Overdue", value: overdueBalanceCents, tone: "rose" as ChartTone, valueLabel: formatCentsCompact(overdueBalanceCents) }]
                  : []),
              ]}
              centerValue={formatCentsCompact(rollup.invoiced_cents)}
              centerLabel="invoiced"
            />
          </div>
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">Billed / month · last 6 mo</div>
              {!billedTrendHasData && <span className="text-[10px] text-ppp-charcoal-400">nothing billed yet</span>}
            </div>
            <TrendChart data={billedMonthly} yFormat="currency-k" colorToken="ppp-blue-500" area heightClassName="h-[140px]" />
          </div>
        </div>
        {hasInvoicing && (
          <div className="mt-4">
            <ProgressMeter
              label="Collected"
              value={rollup.paid_cents}
              max={rollup.invoiced_cents}
              tone={paidPct === 100 ? "emerald" : rollup.overdue_count > 0 ? "amber" : "blue"}
              amounts={{ done: formatCentsFull(rollup.paid_cents), total: formatCentsFull(rollup.invoiced_cents) }}
            />
          </div>
        )}
      </section>

      {/* ── Under contract ── contract-mix donut + per-project billing bars */}
      {production.activeProjects > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Under contract
              <span className="text-[11px] font-medium text-ppp-charcoal-500">— {production.activeProjects} active {production.activeProjects === 1 ? "project" : "projects"}</span>
            </h3>
            <Link href="/commercial/projects" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Projects →</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <MiniFig label="Under contract" value={formatCentsCompact(production.contractValueCents)} tone="blue" sub={hasContract ? "incl. COs" : "not set"} />
            <MiniFig label="Billed" value={formatCentsCompact(production.billedContractCents)} tone="emerald" sub={hasContract ? `${billedOfContractPct}%` : "—"} />
            {overBilledCents > 0 ? (
              <MiniFig label="Over-billed" value={formatCentsCompact(overBilledCents)} tone="amber" sub="past contract" />
            ) : (
              <MiniFig label="Left to bill" value={formatCentsCompact(production.leftToBillCents)} tone="neutral" sub="contract − billed" />
            )}
            <MiniFig label="Outstanding" value={formatCentsCompact(production.outstandingCents)} tone={production.outstandingCents > 0 ? "amber" : "neutral"} sub={production.pendingCoCount > 0 ? `${production.pendingCoCount} CO pending` : "open balance"} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-center mt-4">
            <div className="flex items-center justify-center">
              <DonutChart
                size={150}
                segments={[
                  { label: production.overBilledCents > 0 ? "Within contract" : "Billed", value: production.billedContractCents - production.overBilledCents, tone: "emerald", valueLabel: formatCentsCompact(production.billedContractCents - production.overBilledCents) },
                  { label: "Left to bill", value: production.leftToBillCents, tone: "blue", valueLabel: formatCentsCompact(production.leftToBillCents) },
                  ...(production.overBilledCents > 0
                    ? [{ label: "Over-billed", value: production.overBilledCents, tone: "amber" as ChartTone, valueLabel: formatCentsCompact(production.overBilledCents) }]
                    : []),
                ]}
                centerValue={formatCentsCompact(production.contractValueCents)}
                centerLabel="contract"
              />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-2">Contract by project</div>
              {projectBars.length > 0 ? (
                <HBars items={projectBars} />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-400">Set a bid range or accepted proposal on the opportunity to fill the contract number — then each project shows here.</p>
              )}
            </div>
          </div>
          {hasContract && (
            <div className="mt-4">
              <ProgressMeter
                label="Billed of contract"
                value={production.billedContractCents}
                max={production.contractValueCents}
                tone={overBilledCents > 0 ? "amber" : billedOfContractPct === 100 ? "emerald" : "blue"}
                rightLabel={overBilledCents > 0 ? `${Math.round((production.billedContractCents / production.contractValueCents) * 100)}%` : `${billedOfContractPct}%`}
                amounts={{ done: formatCentsFull(production.billedContractCents), total: formatCentsFull(production.contractValueCents) }}
                note={overBilledCents > 0 ? `Over the contract by ${formatCentsFull(overBilledCents)} — check for an unapproved change order or a billing error.` : null}
              />
            </div>
          )}
        </section>
      )}

      {/* ── Pipeline ── win-rate gauge + compact figures */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Pipeline
          </h3>
          <Link href="/commercial/opportunities" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Board →</Link>
        </div>
        <div className="flex items-center gap-5 flex-wrap sm:flex-nowrap">
          {decidedCount > 0 ? (
            <GaugeRing pct={winRatePct ?? 0} tone="emerald" value={`${winRatePct ?? 0}%`} label="win rate" size={116} />
          ) : (
            <div className="shrink-0 flex flex-col items-center justify-center h-[116px] w-[116px] rounded-full border-[9px] border-ppp-charcoal-100">
              <div className="font-condensed text-2xl font-black text-ppp-charcoal-300 leading-none">—</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mt-1">win rate</div>
            </div>
          )}
          <div className="min-w-0 flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
            <MiniFig label="Open bids" value={String(openBidCount)} tone="blue" sub={openBidCount === 0 ? "no live bids" : "in progress"} />
            <MiniFig
              label={bidLow > 0 || bidHigh > 0 ? "Bid range" : "Open value"}
              value={bidRangeLabel}
              tone="neutral"
              sub="open bids"
            />
            <MiniFig label="Won / lost" value={`${overview?.won_opps_count ?? 0} / ${overview?.lost_opps_count ?? 0}`} tone="emerald" sub={decidedCount === 0 ? "no history" : `of ${decidedCount} decided`} />
          </div>
        </div>
        {decidedCount > 0 && overview && renderWinRateSub(overview) && (
          <p className="mt-2.5 text-[11px] text-ppp-charcoal-400">{renderWinRateSub(overview)}</p>
        )}
      </section>
    </div>
  );
}

/** Compact figure used inside the chart cards — label + value + optional sub,
 *  with a left tone accent (a lighter cousin of RollupTile/StatCard). */
function MiniFig({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: ChartTone }) {
  const valueCls =
    tone === "emerald" ? "text-emerald-700"
    : tone === "rose" ? "text-rose-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "blue" ? "text-ppp-blue-700"
    : tone === "brand" ? "text-cc-brand-700"
    : tone === "navy" ? "text-ppp-navy-700"
    : "text-ppp-charcoal";
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-3 py-2">
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-ppp-charcoal-400 mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * DealEditSheet — Karan 2026-07-08 rewrite. GoHighLevel-style right-side
 * slide-out for editing a deal. Replaces the old DealDrillIn auto-focus
 * behavior the user rejected ("when i click on an already existing deal
 * it focuses the deal i dont like that").
 *
 * Contents (top-to-bottom):
 *   1. Header — current title + status pill + Close
 *   2. Read-only KPI band — Bid / Probability / Weighted / Decision-in
 *      (visual context for what the user's about to change)
 *   3. Full edit form — title, source, bid low/high, probability, all
 *      three date fields, description, project address override
 *   4. Footer — Save + Cancel (Cancel drops ?edit=)
 *   5. Delete affordance (rose accent, native details confirm)
 *
 * URL-driven: ?edit=<uuid> opens; save/cancel drops the param.
 * Backdrop is a full-viewport Link that closes.
 * Cross-account defense in the caller (deal only rendered when it
 * belongs to this accountId).
 */
async function DealEditSheet({
  deal,
  accountId,
  accountName,
  primaryLead,
  estimators,
  errorMessage,
  lifecycle,
  dealBack,
}: {
  deal: CommercialOpportunity;
  accountId: string;
  /** For the derived deal name in the header — consistent with the list. */
  accountName: string;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  /** True when the sheet was opened from the DEAL page (?deal_back=1), so
   *  saving returns to the deal rather than the account's Deals tab. */
  dealBack?: boolean;
  estimators: EligibleEstimator[];
  /** Karan 2026-07-10 audit fix (P1): when the edit action fails +
   *  redirects back with ?edit=<opp>&error=..., the tab-level
   *  errorMessage banner was rendered BEHIND this sheet's z-40
   *  backdrop — user saw the darkened overlay and nothing else, as if
   *  the save silently disappeared. Now the same message renders
   *  INSIDE the sheet body at the top of the scroll container. */
  errorMessage?: string | null;
  /** Katie 2026-07-20 flagship: the 4 dates + 2 durations, rendered as
   *  a read-only timeline at the top of the sheet. This is the reachable
   *  home for the lifecycle after /opportunities/[id] was retired as a
   *  landing surface (2026-07-21 audit). Null when the fetch was skipped. */
  lifecycle?: import("@/lib/commercial/opportunities/lifecycle").OpportunityLifecycleDates | null;
}) {
  const bidLabel = formatBidRange(deal.bid_value_low_cents, deal.bid_value_high_cents);
  // Fall back to the proposal total when the deal has no bid range (bid low/high
  // left the create forms in 2026-08) so Weighted here matches the dashboard.
  const dealProposalTotal = (
    await listCurrentProposalTotalByOpp([deal.id])
  ).get(deal.id);
  const weighted = weightedPipelineCents(deal, dealProposalTotal);
  const statusInfo = statusPillTone(deal.status, deal.sub_status);
  // Same derived name the list/rows show, so the drawer header is consistent
  // (was showing the raw title, which mismatched the row label).
  const dealDisplayName = derivedOppName(deal, accountName) || "(untitled)";
  // Phase G v2: on a post-sale Project, pull a live change-order summary so the
  // drawer surfaces it prominently (count + net approved + pending) — Karan:
  // "make it visible... used most in post-contract."
  // One predicate shared with the CO page (isPostSaleProject) so the drawer
  // card and the page can never disagree — even on a stray legacy v1 status.
  const isPostSaleDeal = isPostSaleProject(deal);
  const changeOrders = isPostSaleDeal ? await listChangeOrders(deal.id) : [];
  const coCount = changeOrders.length;
  const coNetApprovedCents = changeOrders
    .filter((c) => c.status === "approved")
    .reduce((a, c) => a + c.amount_cents, 0);
  const coPendingCount = changeOrders.filter((c) => c.status === "pending").length;
  const coHref = `/commercial/opportunities/${deal.id}?tab=project&sub=change-orders`;
  // ISO date-picker defaults — extract YYYY-MM-DD from the stored UTC
  // timestamps so <input type="date"> renders them correctly.
  const dueDateDefault = deal.proposal_due_at ? deal.proposal_due_at.slice(0, 10) : "";
  const rfpDateDefault = deal.rfp_received_at ? deal.rfp_received_at.slice(0, 10) : "";
  // Katie gap #1 (2026-07-28): the "Attention contact" for this job. Drives the
  // proposal's Attention / Phone / Email block (via primary_contact_id → the
  // proposal hydrate). Options are this GC's saved contacts.
  const contactRows = await listAccountContacts(accountId);
  const currentContactMissing =
    !!deal.primary_contact_id && !contactRows.some((r) => r.contact.id === deal.primary_contact_id);
  const contactOptions = [
    ...contactRows.map(({ contact }) => ({
      value: contact.id,
      label: contact.full_name,
      hint: [contact.title, contact.phone].filter(Boolean).join(" · ") || undefined,
    })),
    ...(currentContactMissing
      ? [{ value: deal.primary_contact_id as string, label: "Removed from this GC (still assigned)", hint: "Pick another below" }]
      : []),
  ];
  const closeHref = `/commercial/accounts/${accountId}?tab=deals`;
  const inputCls = "w-full px-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]";
  // Karan 2026-07-10 (arrows-coming-down flag): all selects get an
  // identical chevron. `appearance-none` strips the OS default (which
  // rendered differently in Safari vs Firefox vs Chrome). SELECT_BG_STYLE
  // paints our own inline SVG chevron. `bg-no-repeat` is CRITICAL —
  // without it, the browser tiles the chevron across the whole select
  // width (~20 chevrons in a row — Karan's 4:09pm screenshot).
  const selectCls = `${inputCls} appearance-none bg-surface bg-no-repeat pr-9`;
  const labelCls = "block text-[13px] font-semibold text-ppp-charcoal-800 mb-1.5";
  return (
    <div id="deal-edit-sheet" className="fixed inset-0 z-40">
      {/* Backdrop — full-viewport link closes the sheet by dropping ?edit. */}
      <Link
        href={closeHref}
        aria-label="Close opportunity editor"
        className="absolute inset-0 bg-ppp-charcoal/40 backdrop-blur-[1px]"
      />
      {/* Sheet — right-aligned slide-out. Karan 2026-07-10: bumped
          desktop width from 520px → 720px so the form breathes; long
          field labels + hints don't wrap mid-word anymore. Full-width
          on mobile stays. */}
      <FocusTrapAside
        closeHref={closeHref}
        ariaLabelledBy="deal-edit-title"
        className="absolute right-0 top-0 bottom-0 w-full sm:w-[600px] lg:w-[720px] max-w-full bg-surface border-l border-ppp-charcoal-200 shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
        {/* Karan 2026-07-08 simplification pass: killed the read-only KPI
            band (redundant with the form field values below) and the
            "status changes happen elsewhere" paragraph (users learn
            once, then that copy adds noise on every edit). Header is
            now just: eyebrow + title + status + close. */}
        <header className="px-5 py-4 border-b border-ppp-charcoal-100 bg-gradient-to-r from-cc-brand-50/50 to-surface">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700 mb-1.5">
                Edit opportunity
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id="deal-edit-title" className="text-lg font-bold text-ppp-charcoal break-words leading-tight tracking-tight">
                  {dealDisplayName}
                </h2>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${statusInfo.cls}`}>
                  {oppStatusDisplayLabel(deal.status, deal.sub_status)}
                </span>
              </div>
              {primaryLead && (
                <div className="mt-1 text-[11.5px] text-ppp-charcoal-500">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 21.4l1.4-6.8L2.2 9.9l6.9-.8z" /></svg> {primaryLead.user_full_name ?? primaryLead.user_email} lead
                </div>
              )}
            </div>
            <Link
              href={closeHref}
              aria-label="Close"
              className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-lg text-ppp-charcoal-500 hover:bg-ppp-charcoal-100 hover:text-ppp-charcoal-800 touch-manipulation"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
            </Link>
          </div>
        </header>

        {/* Edit form — scrollable body. Sections separated by labeled
            dividers instead of just spacing so the eye tracks where each
            group of fields ends. */}
        {/* Karan 2026-07-10: the scroll container is now a plain <div>
            wrapping BOTH the edit <form> AND the Danger Zone <form>
            as siblings. Previous structure nested them, which is
            invalid HTML — the inner Delete form's submit was getting
            swallowed by the outer edit form (Delete button silently
            did nothing). Fixed. */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4 bg-ppp-charcoal-50/50">
        {/* Katie 2026-07-20 flagship (2026-07-21 audit fix): the Bid
            Lifecycle timeline — 4 dates + 2 durations — rendered at the
            very top of the drill-in where users actually land. Was
            previously stranded on the retired /opportunities/[id] page.
            Read-only; the underlying dates are edited in the Timeline
            section of the form below. */}
        {lifecycle && (
          <BidLifecycleTimeline
            lifecycle={lifecycle}
            // Re-audit (#1): post_sale_closed (and delivery statuses) are
            // won deals that advanced — you can't deliver a lost bid — so
            // the Close node must read "Won", not a neutral "Close".
            closeOutcome={
              isWon(deal) || isPostSale(deal) ? "won" : isLost(deal) ? "lost" : null
            }
          />
        )}
        {/* Karan 2026-07-13: on decided deals surface a link to the
            account-scoped debrief page. Without this the user has no
            way to reach the debrief form after the initial Won-drop
            toast disappears. Amber tint on pending, emerald on filed. */}
        {/* Only while the deal is at Closed. The debrief page accepts nothing
            else, so on a job already in delivery this CTA was a link that
            bounced the user straight back to the deals tab — and after H4
            narrowed the count to match, it was also advertising work the badge
            no longer asks for. */}
        {deal.status === "pre_sale_closed" && (
          <div
            className={`rounded-lg px-4 py-3 flex items-center justify-between gap-3 text-sm ${
              deal.win_loss_debriefed_at
                ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                : "bg-amber-50 border border-amber-200 text-amber-800"
            }`}
          >
            <span className="min-w-0">
              {deal.win_loss_debriefed_at
                ? "Win/Loss debrief on file. View or add a follow-up."
                : "Log the Win/Loss debrief — feeds the quarterly report."}
            </span>
            <Link
              href={`/commercial/accounts/${accountId}/debrief/${deal.id}`}
              className={`shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-semibold min-h-[44px] sm:min-h-[32px] ${
                deal.win_loss_debriefed_at
                  ? "bg-surface border border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  : "bg-surface border border-amber-300 text-amber-800 hover:bg-amber-100"
              }`}
            >
              {deal.win_loss_debriefed_at ? "View debrief" : "Open debrief"}
              <span aria-hidden>→</span>
            </Link>
          </div>
        )}
        {/* Phase G v2: prominent Change Orders entry on a post-sale Project.
            Full page lives under the account; this card surfaces the live
            summary (count · net approved · pending) so it's never hidden. */}
        {isPostSaleDeal && (
          <Link
            href={coHref}
            className="block rounded-xl border border-cc-brand-200 bg-gradient-to-br from-cc-brand-50 to-surface p-4 hover:border-cc-brand-300 hover:shadow-sm transition-all group"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-600 text-white shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-ppp-charcoal leading-tight">Change Orders</div>
                  <div className="text-[11.5px] text-ppp-charcoal-500 leading-snug">
                    {coCount === 0
                      ? "Log scope added or deducted mid-job"
                      : `${coCount} change order${coCount === 1 ? "" : "s"}${coPendingCount > 0 ? ` · ${coPendingCount} pending` : ""}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {coNetApprovedCents !== 0 && (
                  <span className={`text-sm font-bold tabular-nums ${coNetApprovedCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {coNetApprovedCents < 0 ? "−" : "+"}{formatCentsFull(Math.abs(coNetApprovedCents))}
                  </span>
                )}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-cc-brand-600 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
              </div>
            </div>
            {coPendingCount > 0 && (
              <div className="mt-2 text-[11px] font-medium text-amber-700">
                {coPendingCount} awaiting your decision →
              </div>
            )}
          </Link>
        )}
        {/* Phase H: AIA progress billing entry (post-sale projects). */}
        {isPostSaleDeal && (
          <Link
            href={`/commercial/opportunities/${deal.id}?tab=project&sub=aia`}
            className="block rounded-xl border border-cc-brand-200 bg-gradient-to-br from-cc-brand-50 to-surface p-4 hover:border-cc-brand-300 hover:shadow-sm transition-all group"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-600 text-white shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6 M9 9h1" /></svg>
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-ppp-charcoal leading-tight">AIA Billing</div>
                  <div className="text-[11.5px] text-ppp-charcoal-500 leading-snug">G702 / G703 progress billing + Excel export</div>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-cc-brand-600 shrink-0 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
            </div>
          </Link>
        )}
        {isPostSaleDeal && (
          <Link
            href={`/commercial/opportunities/${deal.id}?tab=project&sub=closeout`}
            className="block rounded-xl border border-cc-brand-200 bg-gradient-to-br from-cc-brand-50 to-surface p-4 hover:border-cc-brand-300 hover:shadow-sm transition-all group"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-600 text-white shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-ppp-charcoal leading-tight">Closeout &amp; Warranty</div>
                  <div className="text-[11.5px] text-ppp-charcoal-500 leading-snug">Close-out package + transmittal + warranty letter</div>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-cc-brand-600 shrink-0 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
            </div>
          </Link>
        )}
        {/* 2026-07-29 re-audit fix: Submittals was the one post-contract
            workflow with NO entry point in the deal drawer (CO / AIA /
            Closeout / Debrief all had cards), so the feature felt "broken"
            — you couldn't reach the create surface from where you land. */}
        {isPostSaleDeal && (
          <Link
            href={`/commercial/opportunities/${deal.id}?tab=project&sub=submittals`}
            className="block rounded-xl border border-cc-brand-200 bg-gradient-to-br from-cc-brand-50 to-surface p-4 hover:border-cc-brand-300 hover:shadow-sm transition-all group"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span aria-hidden className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-cc-brand-600 text-white shrink-0">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h5 M8 17h4" /></svg>
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-ppp-charcoal leading-tight">Submittals</div>
                  <div className="text-[11.5px] text-ppp-charcoal-500 leading-snug">Shop drawings + product data → transmittal to the GC</div>
                </div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-cc-brand-600 shrink-0 group-hover:translate-x-0.5 transition-transform"><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
            </div>
          </Link>
        )}
        {errorMessage && (
          <div
            role="alert"
            aria-live="polite"
            className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800 flex items-start gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
            <span>{errorMessage}</span>
          </div>
        )}
        <form
          action={editDealFromAccountAction}
          id={`edit-deal-form-${deal.id}`}
          className="space-y-4"
        >
          <input type="hidden" name="account_id" value={accountId} />
          <input type="hidden" name="opp_id" value={deal.id} />
          {/* Set when the sheet was opened FROM the deal page, so saving
              returns there instead of dumping the user on the account's
              Deals tab. */}
          <input type="hidden" name="deal_back" value={dealBack ? "1" : ""} />

          {/* ─── Section: About this opportunity ─── */}
          <SheetSection title="About this opportunity">
            <div>
              <label htmlFor="edit-title" className={labelCls}>Opportunity title *</label>
              <input
                id="edit-title"
                name="title"
                type="text"
                required
                maxLength={200}
                defaultValue={deal.title ?? ""}
                className={inputCls}
              />
              <span className="block text-[10.5px] text-ppp-charcoal-500 mt-1">
                Internal working title. The public display name is auto-derived
                as &ldquo;Account - Client - Location&rdquo; — set a Custom display
                name below to override it.
              </span>
            </div>
            {/* Katie 2026-07-20 (migration 069): title_override input.
                Displayed name uses this verbatim when set; falls back to
                {account} - {client} - {street} otherwise. Empty clears
                the override so the auto-derived name takes over again. */}
            <div>
              <label htmlFor="edit-title-override" className={labelCls}>
                Custom display name{" "}
                <span className="font-normal text-ppp-charcoal-400">
                  (overrides auto — leave blank for auto)
                </span>
              </label>
              <input
                id="edit-title-override"
                name="title_override"
                type="text"
                maxLength={200}
                defaultValue={deal.title_override ?? ""}
                placeholder="e.g. JD Sports 37-38 Junction Blvd"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="edit-source" className={labelCls}>How did this come in?</label>
              <select
                id="edit-source"
                name="source"
                defaultValue={deal.source ?? ""}
                className={selectCls}
                style={SELECT_BG_STYLE}
              >
                <option value="">Choose a source</option>
                {OPPORTUNITY_SOURCES.map((s) => (
                  <option key={s} value={s}>{opportunitySourceLabel(s)}</option>
                ))}
              </select>
            </div>
          </SheetSection>

          {/* The Pricing section is gone with the probability field it held —
              bid low/high moved to the proposal in the 2026-08 meeting, and
              probability came out 2026-08-12. An empty titled section is worse
              than no section: it reads as a feature that failed to load. */}

          {/* ─── Section: Timeline ─── */}
          <SheetSection
            title="Timeline"
            hint="When the bid request arrived, and when our proposal is due."
          >
            {/* Katie 2026-07-20: RFP received sits above the work-timing
                trio because it's the LIFECYCLE start (bid intake) vs the
                other three which are project timing. Two separate groups
                so users don't mistake RFP received for the start date. */}
            {/* AUDIT 2026-08-12: Proposed start / Proposed end were removed from
                both create forms and from inline editing, and survived HERE —
                this sheet was the one surface that could still set the fields
                Brendan called "too early to determine at the opportunity
                level". Dates for the WORK live on the project. Stored values
                are kept; only the inputs are gone.

                The two bid-lifecycle dates stay: they are on Brendan's field
                list, and this is where a wrong one gets corrected. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-rfp" className={labelCls}>RFP received</label>
                <DateField id="edit-rfp" name="rfp_received_at" defaultValue={rfpDateDefault} placeholder="When the bid request arrived" ariaLabel="RFP received date" />
              </div>
              <div>
                <label htmlFor="edit-due" className={labelCls}>Proposal due</label>
                <DateField id="edit-due" name="proposal_due_at" defaultValue={dueDateDefault} placeholder="Pick a due date" ariaLabel="Proposal due date" />
              </div>
            </div>
          </SheetSection>

          {/* ─── Section: Details — merged Structure + Project into one
                block 2026-07-10. Two panels felt like duplicate context;
                everything from client-name to address override is now a
                single scroll. Phase B (Plan v1.1) — CEO structural
                fields (client_name, property_street, estimator) stay at
                the top; site address override + description follow. All
                fields optional at Solicitation; changeOpportunityStatus
                blocks the move to Estimating until the three CEO fields
                are set. ─── */}
          <SheetSection
            title="Details"
            hint="Client name, site location, and estimator are required before this opportunity can move to Estimating."
          >
            {/* Karan 2026-07-20 (was 3-col): Client + Estimator side-by-side
                after Site location was killed as a duplicate write to
                property_street. Address is now the dedicated "Address
                override" block below. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className={labelCls}>Client name</span>
                <input
                  name="client_name"
                  type="text"
                  maxLength={200}
                  defaultValue={deal.client_name ?? ""}
                  placeholder="e.g. Tomco Painting"
                  className={inputCls}
                />
              </label>
              {/* Karan 2026-07-20 (Katie ask): removed the duplicate
                  "Site location" input that also wrote to
                  name="property_street" — the "Address override" block
                  below is the canonical address input on the edit
                  sheet. Two inputs with the same name silently
                  clobbered user edits on submit. */}
              <label className="block">
                <span className={labelCls}>Attention contact</span>
                {/* Katie gap #1: the person at this GC that proposals are
                    addressed to. Sets primary_contact_id, which the proposal
                    hydrate pulls into Attention / Phone / Email on every new
                    revision. Blank = fall back to the GC's default contact. */}
                <SearchableSelect
                  name="primary_contact_id"
                  defaultValue={deal.primary_contact_id ?? ""}
                  options={contactOptions}
                  placeholder={
                    contactRows.length === 0
                      ? "No contacts on this GC yet"
                      : "Search this GC's contacts…"
                  }
                  disabled={contactRows.length === 0 && !deal.primary_contact_id}
                  ariaLabel="Attention contact for proposals"
                  emptyMessage="No contacts match. Add one on the GC's People tab."
                />
                <span className="block text-[10.5px] text-ppp-charcoal-500 mt-1">
                  {contactRows.length === 0 ? (
                    <>
                      No contacts yet —{" "}
                      <Link href={`/commercial/accounts/${accountId}?tab=contacts`} className="text-cc-brand-700 font-semibold hover:underline">
                        add one on People
                      </Link>
                      .
                    </>
                  ) : (
                    "Flows to the proposal’s Attention / Phone / Email. Clear it (✕) to use no contact."
                  )}
                </span>
              </label>
              <label className="block">
                <span className={labelCls}>Estimator</span>
                {/* Karan 2026-07-10 (searchable-dropdowns rule):
                    SearchableSelect — type-to-filter roster. Orphaned
                    estimator (removed from team but still assigned)
                    still surfaces as an explicit option so the FK
                    doesn't silently render blank. */}
                <SearchableSelect
                  name="estimator_user_id"
                  defaultValue={deal.estimator_user_id ?? ""}
                  options={[
                    ...estimators.map((e) => ({
                      value: e.user_id,
                      label: e.name,
                    })),
                    ...(deal.estimator_user_id &&
                    !estimators.find((e) => e.user_id === deal.estimator_user_id)
                      ? [
                          {
                            value: deal.estimator_user_id,
                            label: "Removed from team (still assigned)",
                            hint: "Reassign or type a name below",
                          },
                        ]
                      : []),
                  ]}
                  placeholder={
                    estimators.length === 0
                      ? "No teammates on the roster yet"
                      : "Search team roster…"
                  }
                  disabled={estimators.length === 0 && !deal.estimator_user_id}
                  ariaLabel="Estimator from account team"
                  emptyMessage="No teammates match. Try a different search or type a name below."
                />
                {/* Karan 2026-07-10 (second flag on manual estimator):
                    free-text estimator name for subs / off-roster
                    estimators. Persisted via migration 049's
                    estimator_name column. UI: mutation clears the
                    other side, so filling either wins. */}
                <input
                  name="estimator_name"
                  type="text"
                  maxLength={120}
                  defaultValue={deal.estimator_name ?? ""}
                  placeholder="…or type a name"
                  className={`${inputCls} mt-1`}
                />
                <span className="block text-[10.5px] text-ppp-charcoal-500 mt-1">
                  {estimators.length === 0
                    ? "No teammates yet — type a name above."
                    : deal.estimator_user_id && !estimators.find((e) => e.user_id === deal.estimator_user_id)
                    ? "Previous estimator was removed from the team — reassign or type a name."
                    : "Required to move this to Estimating."}
                </span>
              </label>
            </div>
            {/* Karan 2026-07-21: OPP-2026-#### is the canonical opportunity
                id (from project_number). deal_number is demoted to a
                secondary "Job No." — the Tomco proposal-letterhead ref. */}
            {(deal.project_number || deal.deal_number) && (
              <div className="flex flex-col gap-1 text-[11.5px] text-ppp-charcoal-500">
                {formatOpportunityNumber(deal.project_number) && (
                  <div className="inline-flex items-center gap-1 tabular-nums">
                    Opportunity ID:{" "}
                    <span className="font-mono font-semibold text-ppp-navy-700">
                      {formatOpportunityNumber(deal.project_number)}
                    </span>
                    <CopyToClipboardButton
                      value={formatOpportunityNumber(deal.project_number)}
                      label="Opportunity ID copied"
                      ariaLabel="Copy opportunity ID"
                    />
                  </div>
                )}
                {deal.deal_number && (
                  <div className="inline-flex items-center gap-1 tabular-nums">
                    Job No.:{" "}
                    <span className="font-mono text-ppp-charcoal-700">{deal.deal_number}</span>
                    <span className="normal-case tracking-normal text-ppp-charcoal-400">
                      — on the Tomco proposal
                    </span>
                  </div>
                )}
              </div>
            )}
            <div>
              <div className={labelCls}>
                Address override
                <span className="ml-1 text-[9.5px] font-normal normal-case tracking-normal text-ppp-charcoal-400">
                  — leave blank to use the account&apos;s site address
                </span>
              </div>
              <input
                name="property_street"
                aria-label="Property street"
                type="text"
                maxLength={200}
                defaultValue={deal.property_street ?? ""}
                placeholder="Street"
                className={inputCls}
              />
              <div className="grid grid-cols-3 gap-2 mt-2">
                <input name="property_city" aria-label="Property city" type="text" maxLength={80} defaultValue={deal.property_city ?? ""} placeholder="City" className={inputCls} />
                <input name="property_state" aria-label="Property state" type="text" maxLength={2} defaultValue={deal.property_state ?? ""} placeholder="ST" className={inputCls} />
                <input name="property_zip" aria-label="Property ZIP" type="text" maxLength={10} defaultValue={deal.property_zip ?? ""} placeholder="ZIP" className={inputCls} />
              </div>
            </div>
            <div>
              <label htmlFor="edit-desc" className={labelCls}>Description / scope summary</label>
              <textarea
                id="edit-desc"
                name="description"
                rows={4}
                maxLength={2000}
                defaultValue={deal.description ?? ""}
                placeholder="Scope, existing paint system, access notes…"
                className={`${inputCls} min-h-[92px] resize-y`}
              />
            </div>
          </SheetSection>
        </form>

        {/* ─── Danger zone — SIBLING of the edit form (not nested).
              The <details> holds its OWN form. HTML doesn't allow
              nested forms; the previous structure caused the Delete
              button to silently submit the edit form instead. This
              wrapper is a plain <section> so the two forms live side
              by side inside the scroll container. ─── */}
        <section className="border border-rose-200 bg-rose-50/40 rounded-xl p-4 sm:p-5 space-y-3">
          <div>
            <h3 className="text-[13px] font-bold text-rose-800 leading-tight">
              Danger zone
            </h3>
            <p className="text-[11.5px] text-rose-700 mt-0.5 leading-snug">
              Soft-deletes this deal. Restorable by an admin from the audit log.
            </p>
          </div>
          <details className="relative">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-300 bg-surface text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 min-h-[44px] touch-manipulation">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              Delete this deal
            </summary>
            <form
              action={deleteDealFromAccountAction}
              className="mt-3 bg-surface border border-rose-200 rounded-lg p-3 space-y-2.5"
            >
              <input type="hidden" name="account_id" value={accountId} />
              <input type="hidden" name="opp_id" value={deal.id} />
              <input type="hidden" name="confirm" value="yes" />
              {/* "Remove from the pipeline" described about a fifth of what this
                  click does. Deleting a deal also soft-deletes its unpaid
                  invoices, tombstones every recorded cost, tears down the Field
                  Ops work order and CANCELS upcoming crew shifts — none of which
                  is visible until someone notices money missing or a crew that
                  was never dispatched. Say all of it. */}
              <p className="text-[12px] text-rose-800 leading-relaxed">
                Delete <strong>{deal.title || "this opportunity"}</strong>? This also
                removes its unpaid invoices, every cost recorded against it, and its
                work order — and takes the crew off any shifts already scheduled for
                it. A deal with a PAID invoice can&rsquo;t be deleted at all.
              </p>
              <PendingSubmitButton
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-rose-600 text-white text-[12px] font-semibold hover:bg-rose-700 min-h-[44px] sm:min-h-[36px] touch-manipulation disabled:hover:bg-rose-700"
                pendingLabel="Deleting…"
              >
                Yes, delete this deal
              </PendingSubmitButton>
            </form>
          </details>
        </section>
        </div>

        {/* Footer — Karan 2026-07-10: simplified to Save + Cancel only.
            Delete moved into the Danger Zone section above so
            destructive isn't inches from the primary CTA. */}
        <footer className="px-5 py-3 border-t border-ppp-charcoal-100 bg-surface flex items-center gap-2">
          {/* Karan 2026-07-10 (audit round 4 fix): Save was a plain
              <button> outside the form via form={id}, so useFormStatus
              couldn't reach it. PendingFormButton subscribes to the
              target form's submit event by id and flips to "Saving…"
              during the round-trip. */}
          <PendingFormButton
            formId={`edit-deal-form-${deal.id}`}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30 disabled:hover:bg-cc-brand-600"
            pendingLabel="Saving…"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Save changes
          </PendingFormButton>
          <Link
            href={closeHref}
            className="inline-flex items-center gap-1 px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-[13px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
        </footer>
      </FocusTrapAside>
    </div>
  );
}

/**
 * Karan 2026-07-10: SheetSection rebuilt as a clean white card with a
 * bold section title + optional hint. Dropped the gray tint (Karan:
 * "make it look professional and clean") — plain white with a single
 * subtle border reads better than tinted panels stacked on tinted
 * backgrounds. Sections are visually distinct via padding + border,
 * not tinted bg.
 */
function SheetSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border border-ppp-charcoal-200 rounded-xl p-5 space-y-4 shadow-sm">
      <div>
        <h3 className="text-[15px] font-bold text-ppp-charcoal leading-tight">
          {title}
        </h3>
        {hint && (
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 leading-snug">
            {hint}
          </p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
