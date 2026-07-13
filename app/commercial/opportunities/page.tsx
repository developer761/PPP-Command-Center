/**
 * `/commercial/opportunities` — Phase 2 Opportunity Pipeline list page.
 *
 * UI rebuild 2026-07-05 (Karan: "confusing and unorganized, 100x better").
 * Same principles applied as the accounts page rebuild:
 *   1. One unified toolbar — search + view toggle + filter popover +
 *      sort popover + export + New CTA. Replaces the scattered
 *      3-tile-strip + 5-chip-row + separate Sort dropdown + Export
 *      button + Status snapshot layout.
 *   2. Slim KPI strip below the title — Open opps · Bid range ·
 *      Weighted pipeline · Wins this month. Left accent stripe + tint.
 *   3. Status snapshot pills preserved but now rendered as a secondary
 *      strip inside a unified surface, list-view only (kanban has
 *      columns for status).
 *   4. OpportunityRow simplified to a 3-line hierarchy: primary line
 *      (title + status + bid + due chip), meta line (account · rating ·
 *      prequal · confidence), signals line (days-in-status · tasks ·
 *      last-note · lead · files · finishes · submittals). Tab-jump chips
 *      + quick-flip form kept but reorganized into a right-side action
 *      column so the row header stays clean.
 *
 * Zero backend changes: every URL param read, server action call, data
 * fetch, and DAG rule is byte-identical to the prior version. Only the
 * visual layout + component composition changed.
 */
import React from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PendingFormButton } from "@/components/commercial/pending-form-button";
import { DealJourneyStrip } from "@/components/commercial/deal-journey-strip";
import { createClient } from "@/lib/supabase/server";
import {
  listCommercialOpportunities,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  opportunitySourceLabel,
  formatBidRange,
  weightedPipelineCents,
  derivedOppName,
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import { listCommercialAccounts, type CommercialAccount, type CommercialAccountRating, type CommercialPrequalStatus } from "@/lib/commercial/accounts/db";
import { listAccountTeam, assignmentRoleLabel } from "@/lib/commercial/accounts/assignments";
import { getInvoiceRollupForAccount, type AccountInvoiceRollup } from "@/lib/commercial/invoices/rollup";
import { listCommercialInvoices, type CommercialInvoice } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, invoiceStatusLabel } from "@/lib/commercial/invoices/constants";
import { formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { pickFirst } from "@/lib/commercial/form-utils";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  OPEN_OPP_STATUSES,
  DEFAULT_PROBABILITY_BY_STATUS,
  STALE_OPP_DAYS,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  isTerminalOpportunityStatus,
  isWon,
  isLost,
  isFollowUp,
} from "@/lib/commercial/opportunities/constants";
import {
  allowedNextStatuses,
  changeOpportunityStatus,
  listCurrentStatusEnteredAtByOpp,
} from "@/lib/commercial/opportunities/status";
import { createCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { revalidatePath } from "next/cache";
import { listPrimaryLeadByOpp, opportunityAssignmentRoleLabel } from "@/lib/commercial/opportunities/assignments";
import { listOpenTaskStatsByOpp } from "@/lib/commercial/opportunities/tasks";
import { listLastNoteByOpp } from "@/lib/commercial/opportunities/notes";
import { listAttachmentCountByOpp } from "@/lib/commercial/opportunities/attachments";
import { listSubmittalCountByOpp } from "@/lib/commercial/opportunities/submittals";
import { listFinishCountByOpp } from "@/lib/commercial/opportunities/finishes";
import { KanbanDnDProvider, KanbanDnDCard, KanbanDnDColumn } from "@/components/commercial-kanban-dnd";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import NewDealAccountPicker from "@/components/commercial/new-deal-account-picker";
import DatePicker from "@/components/commercial/date-picker";

const MS_PER_DAY = 86_400_000;

/**
 * Deterministic per-account color tone for the pipeline list-view group
 * cards. Karan 2026-07-10 (rev 6): "would every account color be
 * different and it should." Fixed palettes topped out at 8 slots →
 * collisions once you had 9+ accounts. Switched to HSL hue rotation
 * so every unique account_id lands on a unique hue (360 possible
 * hues → practically unlimited for a commercial pipeline).
 *
 * Hash the account_id (or a stable fallback) via djb2 → hue in 0-359.
 * Skip the blue band (200-260°) because Karan banned blue/navy
 * platform-wide. Fixed saturation + lightness so every card looks
 * equally muted + readable regardless of hue.
 *
 * Returns inline styles (not Tailwind classes) because Tailwind can't
 * generate arbitrary HSL at build time.
 */
type CSSProps = import("react").CSSProperties;
export type AccountTone = {
  border: CSSProps;
  headerBg: CSSProps;
  avatar: CSSProps;
  /** Karan 2026-07-10 rev 7: the account NAME itself is colored per
   *  account, not just the avatar. Slightly darker than avatar text
   *  for strong contrast against the tinted header background. */
  nameText: CSSProps;
};

function accountColorTone(accountId: string | null): AccountTone {
  const key = accountId || "__no_account__";
  // djb2 hash — deterministic + well-distributed for short strings.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  // Map to 0-299° then skip the blue band (200-260°) by shifting
  // anything that lands there up by 60° → maps to red/orange band.
  let hue = h % 300;
  if (hue >= 200) hue = (hue + 60) % 360;
  return {
    border: { borderLeftColor: `hsl(${hue}, 62%, 55%)` },
    headerBg: { backgroundColor: `hsl(${hue}, 62%, 96%)` },
    avatar: {
      backgroundColor: `hsl(${hue}, 55%, 88%)`,
      color: `hsl(${hue}, 55%, 28%)`,
    },
    nameText: { color: `hsl(${hue}, 60%, 32%)` },
  };
}

/**
 * Karan 2026-07-08 audit fix: every quick-flip form now posts a
 * `return_href` hidden input containing the current pipeline URL
 * (minus ?customer= so the sheet doesn't reopen after the flip). The
 * server action appends its own status_ok / status_error signal to
 * that return_href instead of always redirecting to the naked
 * /commercial/opportunities page — otherwise flipping status while
 * filtered to "Hot" would dump the user back to the unfiltered list.
 */
function buildFlipReturnHref(rawReturn: string, param: "status_ok" | "status_error", value: string): string {
  // rawReturn always starts with "/commercial/opportunities" and may
  // or may not have a query string. Preserve everything, append the
  // flash param. Any hash fragment is stripped since the flash banner
  // lives at the top of the page anyway.
  const cleaned = rawReturn.split("#")[0];
  const joiner = cleaned.includes("?") ? "&" : "?";
  return `${cleaned}${joiner}${param}=${encodeURIComponent(value)}`;
}

async function quickFlipStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  const rawToStatus = String(formData.get("to_status") ?? "");
  const rawToSubStatus = String(formData.get("to_sub_status") ?? "").trim();
  // v2 (2026-07-13): the quick-flip form can still submit legacy v1 status
  // names ("won"/"lost") because the Kanban rebuild is queued (E-3). Translate
  // the v1 shorthand into the v2 (status, sub_status) tuple here so both
  // shapes work while UI catches up.
  let to_status = rawToStatus;
  let to_sub_status: string | undefined = rawToSubStatus || undefined;
  const isLostFlip = rawToStatus === "lost" || (rawToStatus === "pre_sale_closed" && rawToSubStatus === "lost");
  const isWonFlip = rawToStatus === "won" || (rawToStatus === "pre_sale_closed" && rawToSubStatus === "won");
  if (rawToStatus === "won") {
    to_status = "pre_sale_closed";
    to_sub_status = "won";
  } else if (rawToStatus === "lost") {
    to_status = "pre_sale_closed";
    to_sub_status = "lost";
  }
  // Sanitize return_href: must start with /commercial/opportunities
  // (open-redirect defense — a malicious form input could otherwise
  // send the user to an off-domain URL after the action).
  const returnRaw = String(formData.get("return_href") ?? "/commercial/opportunities");
  const returnHref = returnRaw.startsWith("/commercial/opportunities") ? returnRaw : "/commercial/opportunities";
  if (!UUID_RE.test(opp_id)) redirect(returnHref);
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect(buildFlipReturnHref(returnHref, "status_error", "Invalid status."));
  }
  // Only Lost routes through the debrief page for reason capture. Won stays
  // as a direct transition + placeholder auto-note below.
  if (isLostFlip) {
    redirect(`/commercial/opportunities/${opp_id}?action=change-status&to=pre_sale_closed&to_sub=lost`);
  }
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    to_sub_status,
    acting_user_id: user.id,
  });
  if (!result.ok) {
    redirect(buildFlipReturnHref(returnHref, "status_error", result.error));
  }
  if (isWonFlip) {
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({ opportunityId: opp_id, outcome: "won", actorUserId: user.id });
    redirect(`/commercial/opportunities/${opp_id}?tab=debrief&just_closed=1`);
  }
  redirect(buildFlipReturnHref(returnHref, "status_ok", "1"));
}

// Karan 2026-07-08: GHL-style "New deal" slide-out on the pipeline page.
// The old "+ New deal" button bounced through /commercial/accounts which
// felt like a dead-end because the user hadn't picked one yet. Now the
// button opens a right-side sheet with an account autocomplete + the
// core deal fields; on submit we insert the deal and drop the user into
// the account's Deals tab where the new row is already highlighted.
async function createDealFromPipelineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const status = String(formData.get("status") ?? "qualifying").trim();
  const source = String(formData.get("source") ?? "").trim();
  const bidLowRaw = String(formData.get("bid_value_low_dollars") ?? "").trim();
  const bidHighRaw = String(formData.get("bid_value_high_dollars") ?? "").trim();
  const proposalDueRaw = String(formData.get("proposal_due_at") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  const backHref = "/commercial/opportunities?new_deal=1#new-deal-sheet";
  if (!UUID_RE.test(account_id)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Pick a customer from the list.")}#new-deal-sheet`);
  }
  if (!title || title.length > 200) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Deal name is required (max 200 chars).")}#new-deal-sheet`);
  }
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(status)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Invalid status.")}#new-deal-sheet`);
  }
  if (source && !(OPPORTUNITY_SOURCES as readonly string[]).includes(source)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Invalid source.")}#new-deal-sheet`);
  }

  const low = bidLowRaw ? parseDollarsToCents(bidLowRaw) : null;
  const high = bidHighRaw ? parseDollarsToCents(bidHighRaw) : null;
  if (bidLowRaw && low === null) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Bid low is not a valid dollar amount.")}#new-deal-sheet`);
  }
  if (bidHighRaw && high === null) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Bid high is not a valid dollar amount.")}#new-deal-sheet`);
  }

  // Anchor a date-only proposal-due at noon ET (16:00 UTC) so we don't
  // race the timezone into the previous day for east-coast users.
  let proposalDueAt: string | null = null;
  if (proposalDueRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proposalDueRaw)) {
      redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Proposal due date is malformed.")}#new-deal-sheet`);
    }
    proposalDueAt = `${proposalDueRaw}T16:00:00Z`;
  }

  const result = await createCommercialOpportunity({
    account_id,
    title,
    description: description || undefined,
    status: status as OpportunityStatus,
    source: source ? (source as OpportunitySource) : undefined,
    bid_value_low_cents: low,
    bid_value_high_cents: high,
    proposal_due_at: proposalDueAt,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent(result.error)}#new-deal-sheet`);
  }
  revalidatePath("/commercial/opportunities");
  revalidatePath(`/commercial/accounts/${account_id}`);
  // Karan 2026-07-09: stay on the pipeline instead of jumping to the
  // account's Deals tab. Passes ?created=<title> so the pipeline flash
  // banner can confirm the create.
  redirect(`/commercial/opportunities?created=1&created_title=${encodeURIComponent(title)}`);
  // unreachable — satisfy the linter that this file has a "server action returns void" signature
  void backHref;
}

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CommercialOpportunitiesPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const search = pickFirst(sp.q);
  const statusFilter = pickFirst(sp.status) as OpportunityStatus | undefined;
  const validStatus = statusFilter && (OPPORTUNITY_STATUSES as readonly string[]).includes(statusFilter)
    ? (statusFilter as OpportunityStatus)
    : undefined;
  const created = pickFirst(sp.created) === "1";
  const createdTitle = pickFirst(sp.created_title);
  const statusOk = pickFirst(sp.status_ok) === "1";
  const statusError = pickFirst(sp.status_error);
  const deletedTitle = pickFirst(sp.deleted);
  // Karan 2026-07-08: New-deal slide-out signals (GHL-style right-side sheet).
  const newDealOpen = pickFirst(sp.new_deal) === "1";
  const sheetError = pickFirst(sp.sheet_error) ?? null;

  const staleFilter = pickFirst(sp.stale) === "1";
  const hotFilter = pickFirst(sp.hot) === "1";
  const sourcesRaw = pickFirst(sp.sources);
  // Karan 2026-07-08 rewrite: the drawer is *customer-scoped*, not
  // deal-scoped. Clicking anywhere on the pipeline (customer row's
  // "View" button, kanban card, list row, deal chip) opens the same
  // sheet for that deal's parent customer — because the user's mental
  // model is "look at Suffolk Concrete", not "look at deal #1234".
  //   ?customer=<account_uuid>        opens the sheet for that account
  //   ?customer=<uuid>&focus=<opp_id> optional highlighted deal +
  //                                    inline status-flip target
  const peekAccountId = (() => {
    const raw = pickFirst(sp.customer);
    if (!raw || !UUID_RE.test(raw)) return null;
    return raw;
  })();
  const focusOppId = (() => {
    const raw = pickFirst(sp.focus);
    if (!raw || !UUID_RE.test(raw)) return null;
    return raw;
  })();

  // Karan 2026-07-08 Batch 1c: added "customer" as a new view mode +
  // made it the DEFAULT. Rationale: Alex reads Pipeline as "which of my
  // customers has active work?" not "which of my deals are in stage X?"
  // Customer-first collapses N deals per company into one card, tells
  // the whole customer story (deals + money) in one row, and clicking
  // the customer name lands on their account page. Kanban + list stay
  // as alternate views (?view=kanban / ?view=list) so the deal-first
  // workflows (drag-through-stage, CSV export) don't disappear.
  // Karan 2026-07-09 PM (Phase A.1): default view flipped Kanban → List
  // per CEO's follow-up email. Alex agreed with Karan's flag that Kanban
  // isn't appropriate for the volume of statuses (8 Pre-Contract + up to
  // 7 Post-Contract when Projects ship in Phase H). List with toggle
  // filters reads better at that count. Kanban stays available via
  // ?view=kanban for the Pre-Contract subset.
  const viewRaw = pickFirst(sp.view);
  const viewMode: "list" | "kanban" | "customer" =
    viewRaw === "kanban" ? "kanban" : viewRaw === "customer" ? "customer" : "list";

  const SORT_OPTIONS = [
    { key: "recent", label: "Most recently updated" },
    { key: "oldest", label: "Oldest / stuck deals" },
    { key: "bid_high", label: "Highest bid first" },
    { key: "due_soon", label: "Proposal due soonest" },
    { key: "probability_high", label: "Most likely to win" },
  ] as const;
  type SortKey = (typeof SORT_OPTIONS)[number]["key"];
  const sortRaw = pickFirst(sp.sort);
  const sortKey: SortKey =
    sortRaw && SORT_OPTIONS.some((o) => o.key === sortRaw)
      ? (sortRaw as SortKey)
      : "recent";
  const sourceSet: Set<OpportunitySource> = new Set();
  if (sourcesRaw) {
    for (const s of sourcesRaw.split(",")) {
      const t = s.trim();
      if ((OPPORTUNITY_SOURCES as readonly string[]).includes(t)) {
        sourceSet.add(t as OpportunitySource);
      }
    }
  }

  const [oppsRaw, accounts] = await Promise.all([
    listCommercialOpportunities({ search, status: validStatus }),
    listCommercialAccounts(),
  ]);
  const accountById = new Map<string, CommercialAccount>(accounts.map((a) => [a.id, a]));

  const oppIds = oppsRaw.map((o) => o.id);
  const [
    statusEnteredAtMap,
    taskStatsMap,
    lastNoteMap,
    primaryLeadMap,
    fileCountMap,
    submittalCountMap,
    finishCountMap,
  ] = await Promise.all([
    listCurrentStatusEnteredAtByOpp(oppIds),
    listOpenTaskStatsByOpp(oppIds),
    listLastNoteByOpp(oppIds),
    listPrimaryLeadByOpp(oppIds),
    listAttachmentCountByOpp(oppIds),
    listSubmittalCountByOpp(oppIds),
    listFinishCountByOpp(oppIds),
  ]);

  let opps = oppsRaw;
  if (staleFilter) {
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      const days = Math.floor((Date.now() - new Date(o.updated_at).getTime()) / MS_PER_DAY);
      return Number.isFinite(days) && days >= STALE_OPP_DAYS;
    });
  }
  if (hotFilter) {
    opps = opps.filter((o) => {
      if (!(HOT_DEAL_ACTIVE_STATUSES as readonly string[]).includes(o.status)) return false;
      if (!o.bid_value_high_cents || o.bid_value_high_cents < HOT_DEAL_BID_CENTS) return false;
      if (!o.proposal_due_at) return false;
      const daysUntilDue = Math.ceil(
        (new Date(o.proposal_due_at).getTime() - Date.now()) / MS_PER_DAY
      );
      return Number.isFinite(daysUntilDue) && daysUntilDue >= 0 && daysUntilDue <= HOT_DEAL_DECISION_DAYS;
    });
  }
  if (sourceSet.size > 0) {
    opps = opps.filter((o) => o.source && sourceSet.has(o.source));
  }

  const stableTie = (a: CommercialOpportunity, b: CommercialOpportunity) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  opps = [...opps].sort((a, b) => {
    if (sortKey === "oldest") {
      return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    }
    if (sortKey === "bid_high") {
      const diff = (b.bid_value_high_cents ?? -1) - (a.bid_value_high_cents ?? -1);
      return diff !== 0 ? diff : stableTie(a, b);
    }
    if (sortKey === "due_soon") {
      const av = a.proposal_due_at ? new Date(a.proposal_due_at).getTime() : Infinity;
      const bv = b.proposal_due_at ? new Date(b.proposal_due_at).getTime() : Infinity;
      const diff = av - bv;
      return diff !== 0 ? diff : stableTie(a, b);
    }
    if (sortKey === "probability_high") {
      const diff = (b.probability_pct ?? 0) - (a.probability_pct ?? 0);
      return diff !== 0 ? diff : stableTie(a, b);
    }
    return stableTie(a, b);
  });

  const openOpps = opps.filter((o) => (OPEN_OPP_STATUSES as readonly string[]).includes(o.status));
  const totalPipelineCents = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);
  const totalBidLowCents = openOpps.reduce((acc, o) => acc + (o.bid_value_low_cents ?? 0), 0);
  const totalBidHighCents = openOpps.reduce((acc, o) => acc + (o.bid_value_high_cents ?? 0), 0);
  // Wins this month — mirrors the /commercial dashboard KPI so the two
  // surfaces agree. Uses UTC-month-start; close enough for exec-review
  // "how'd we do this month" scan.
  const now = new Date();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const wonThisMonth = oppsRaw.filter((o) => isWon(o) && (o.decided_at ?? "") >= monthStartIso).length;

  // URL builders — behavior unchanged from prior file.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (validStatus) baseParams.set("status", validStatus);
  if (sourceSet.size > 0) baseParams.set("sources", Array.from(sourceSet).join(","));
  if (sortKey !== "recent") baseParams.set("sort", sortKey);
  if (viewMode === "list") baseParams.set("view", "list");
  else if (viewMode === "kanban") baseParams.set("view", "kanban");

  const viewToggleHref = (target: "list" | "kanban" | "customer") => {
    const p = new URLSearchParams(baseParams);
    p.delete("view");
    if (target === "list") p.set("view", "list");
    else if (target === "kanban") p.set("view", "kanban");
    // "customer" is the default; no ?view= param.
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const toggleStaleHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const toggleHotHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!hotFilter) p.set("hot", "1");
    if (staleFilter) p.set("stale", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const toggleSourceHref = (src: OpportunitySource) => {
    const p = new URLSearchParams(baseParams);
    const next = new Set(sourceSet);
    if (next.has(src)) next.delete(src);
    else next.add(src);
    if (next.size > 0) p.set("sources", Array.from(next).join(","));
    else p.delete("sources");
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const setSortHref = (newSort: string): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (validStatus) p.set("status", validStatus);
    if (sourceSet.size > 0) p.set("sources", Array.from(sourceSet).join(","));
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (viewMode === "list") p.set("view", "list");
    if (newSort !== "recent") p.set("sort", newSort);
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const clearFilterHref = (drop: "q" | "status" | "hot" | "stale" | "sources"): string => {
    const p = new URLSearchParams();
    if (search && drop !== "q") p.set("q", search);
    if (validStatus && drop !== "status") p.set("status", validStatus);
    if (hotFilter && drop !== "hot") p.set("hot", "1");
    if (staleFilter && drop !== "stale") p.set("stale", "1");
    if (sourceSet.size > 0 && drop !== "sources") p.set("sources", Array.from(sourceSet).join(","));
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (viewMode === "list") p.set("view", "list");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  const exportParams = new URLSearchParams(baseParams);
  if (staleFilter) exportParams.set("stale", "1");
  if (hotFilter) exportParams.set("hot", "1");
  const exportHref = `/api/commercial/opportunities/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;

  const anyFilterActive =
    !!search || !!validStatus || staleFilter || hotFilter || sourceSet.size > 0;
  const sortChanged = sortKey !== "recent";
  const activeFilterCount =
    (search ? 1 : 0) + (validStatus ? 1 : 0) +
    (hotFilter ? 1 : 0) + (staleFilter ? 1 : 0) + sourceSet.size;
  const currentSortLabel = SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recently updated";

  const statusSnapshot: Array<{ status: OpportunityStatus; count: number }> = (
    OPEN_OPP_STATUSES as readonly OpportunityStatus[]
  )
    .map((s) => ({ status: s, count: openOpps.filter((o) => o.status === s).length }))
    .filter((r) => r.count > 0);

  const statusDrillHref = (s: OpportunityStatus) => {
    const p = new URLSearchParams(baseParams);
    if (validStatus === s) {
      p.delete("status");
    } else {
      p.set("status", s);
    }
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  // Karan 2026-07-08 rewrite: customer-sheet URL builders.
  //   customerSheetHref(accountId, focusOppId?) — open the sheet
  //   customerSheetCloseHref — drop ?customer= and ?focus=
  const customerSheetHref = (accountId: string, focus?: string): string => {
    const p = new URLSearchParams(baseParams);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    p.set("customer", accountId);
    if (focus) p.set("focus", focus);
    return `/commercial/opportunities?${p.toString()}#customer-sheet`;
  };
  const customerSheetCloseHref: string = (() => {
    const p = new URLSearchParams(baseParams);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    p.delete("customer");
    p.delete("focus");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  // Karan 2026-07-08: same shape as the customer sheet close, but also
  // strips the new_deal + sheet_error signals — the New Deal sheet lives
  // on the same URL surface.
  const newDealSheetCloseHref: string = (() => {
    const p = new URLSearchParams(baseParams);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    p.delete("customer");
    p.delete("focus");
    p.delete("new_deal");
    p.delete("sheet_error");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  // Karan 2026-07-08 audit fix: forms that use quickFlipStatusAction
  // post this as a hidden input so the server action can redirect back
  // to the current filtered view instead of the naked pipeline URL.
  // Customer/focus are stripped so the sheet doesn't reopen post-flip.
  const flipReturnHref: string = customerSheetCloseHref;

  return (
    <div className="space-y-5">
      {/* ─── Hero + slim KPI strip ─── */}
      <header className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
              Pipeline
            </h1>
            <p className="mt-1 text-sm text-ppp-charcoal-500">
              Every commercial deal across every customer. Filter, sort, drag.
            </p>
          </div>
          <Link
            href="?new_deal=1#new-deal-sheet"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px] shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            New deal
          </Link>
        </div>

        {/* KPI strip. Red primary = Open opps count. Blue supporting =
            Weighted pipeline + Wins this month. Neutral = bid range. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            tone="cc-brand"
            label="Open opportunities"
            value={openOpps.length.toString()}
            sub={`${opps.length - openOpps.length} closed`}
          />
          <KpiCard
            tone="cc-brand"
            label="Weighted pipeline"
            value={formatCents(totalPipelineCents)}
            sub="Σ midpoint × probability"
          />
          <KpiCard
            tone="neutral"
            label="Bid range (open)"
            value={
              totalBidLowCents === 0 && totalBidHighCents === 0
                ? "—"
                : `${formatCents(totalBidLowCents)}–${formatCents(totalBidHighCents)}`
            }
            sub="low + high across open deals"
          />
          <KpiCard
            tone="blue"
            label="Wins this month"
            value={wonThisMonth.toString()}
            sub={wonThisMonth === 0 ? "no closes yet" : "and counting"}
          />
        </div>
      </header>

      {/* ─── Result banners ─── */}
      {(created || deletedTitle || statusOk || statusError) && (
        <div className="space-y-2">
          {created && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
              <span aria-hidden>✓</span>
              <span className="flex-1">
                {createdTitle ? (
                  <><strong>{createdTitle}</strong> logged. Ready for the next bid.</>
                ) : (
                  "Opportunity created."
                )}
              </span>
            </div>
          )}
          {deletedTitle && (
            <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-xl px-4 py-3 text-sm text-ppp-charcoal-700 flex items-start justify-between gap-3">
              <span>
                Deleted <strong className="text-ppp-charcoal">{deletedTitle}</strong>.
              </span>
              <Link
                href="/commercial/opportunities"
                className="text-[12px] text-ppp-charcoal-600 hover:text-ppp-charcoal-800 underline shrink-0 min-h-[24px] inline-flex items-center"
              >
                Dismiss
              </Link>
            </div>
          )}
          {statusOk && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800 flex items-start justify-between gap-3">
              <span>Status updated.</span>
              <Link
                href="/commercial/opportunities"
                className="text-[12px] text-emerald-700 hover:text-emerald-900 underline shrink-0 min-h-[24px] inline-flex items-center"
              >
                Dismiss
              </Link>
            </div>
          )}
          {statusError && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-sm text-rose-800 flex items-start justify-between gap-3">
              <span>{statusError}</span>
              <Link
                href="/commercial/opportunities"
                className="text-[12px] text-rose-700 hover:text-rose-900 underline shrink-0 min-h-[24px] inline-flex items-center"
              >
                Dismiss
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ─── Toolbar: single row. Search + View toggle + Filter popover
          + Sort popover + Export + Clear. ─── */}
      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
        <form className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search ?? ""}
              placeholder="Search opportunities by title…"
              className="w-full pl-10 pr-3 py-2 text-base sm:text-sm bg-white border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
            />
          </div>
          {validStatus && <input type="hidden" name="status" value={validStatus} />}
          {viewMode === "list" && <input type="hidden" name="view" value="list" />}
          {viewMode === "kanban" && <input type="hidden" name="view" value="kanban" />}
          {hotFilter && <input type="hidden" name="hot" value="1" />}
          {staleFilter && <input type="hidden" name="stale" value="1" />}
          {sourceSet.size > 0 && (
            <input type="hidden" name="sources" value={Array.from(sourceSet).join(",")} />
          )}
          {sortKey !== "recent" && <input type="hidden" name="sort" value={sortKey} />}

          {/* View toggle — segmented control. Customer-first is the
              default (Karan 2026-07-08 Batch 1c). Kanban + List remain
              as opt-in alternate views for deal-first workflows. */}
          <div className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden shrink-0">
            <Link
              href={viewToggleHref("customer")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation ${
                viewMode === "customer"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="By customer — one card per account with all their deals + money summary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 21h18 M6 21V7l6-4 6 4v14 M10 9h4 M10 13h4 M10 17h4" />
              </svg>
              By customer
            </Link>
            <Link
              href={viewToggleHref("kanban")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "kanban"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Kanban — drag deals through the pipeline"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="18" rx="1" />
                <rect x="14" y="3" width="7" height="12" rx="1" />
              </svg>
              Kanban
            </Link>
            <Link
              href={viewToggleHref("list")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "list"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="List view — best for scanning + filtering + CSV export"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              List
            </Link>
          </div>

          {/* Filter popover — hot / stale / source multi-select all live
              here. Native <details> for zero-JS state. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                activeFilterCount > 0
                  ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-700 hover:bg-cc-brand-100"
                  : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
              <span>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 sm:right-auto mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-3 min-w-[320px] max-w-[calc(100vw-1rem)] max-h-[75vh] overflow-y-auto space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                  Priority
                </div>
                <div className="space-y-1">
                  <FilterOption
                    href={toggleHotHref}
                    active={hotFilter}
                    label={`🔥 Hot ($50k+ · <${HOT_DEAL_DECISION_DAYS}d)`}
                    description={`Bid ≥ $50k, proposal due within ${HOT_DEAL_DECISION_DAYS} days, still in play.`}
                  />
                  <FilterOption
                    href={toggleStaleHref}
                    active={staleFilter}
                    label={`Stale > ${STALE_OPP_DAYS}d`}
                    description={`Open opps with no update in over ${STALE_OPP_DAYS} days.`}
                  />
                </div>
              </div>
              <div className="border-t border-ppp-charcoal-100 pt-3">
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                  By source
                </div>
                <div className="space-y-1">
                  {OPPORTUNITY_SOURCES.map((s) => (
                    <FilterOption
                      key={s}
                      href={toggleSourceHref(s)}
                      active={sourceSet.has(s)}
                      label={opportunitySourceLabel(s)}
                      description="How this deal came in."
                    />
                  ))}
                </div>
              </div>
            </div>
          </details>

          {/* Sort popover. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                sortChanged
                  ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-700 hover:bg-cc-brand-100"
                  : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18 M7 12h10 M11 18h2" />
              </svg>
              <span className="hidden sm:inline">Sort:&nbsp;</span>
              <span className="max-w-[140px] truncate">{currentSortLabel}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 mt-2 z-30 bg-white border border-ppp-charcoal-200 rounded-xl shadow-xl p-2 min-w-[260px] max-w-[calc(100vw-1rem)]">
              <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 pt-2 pb-1">
                Sort by
              </div>
              <div className="space-y-0.5">
                {SORT_OPTIONS.map((o) => (
                  <SortOption
                    key={o.key}
                    href={setSortHref(o.key)}
                    active={sortKey === o.key}
                    label={o.label}
                  />
                ))}
              </div>
            </div>
          </details>

          {/* Export CSV — takes the same params as the visible list. */}
          <a
            href={exportHref}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            title="Download the current filter view as CSV"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
            </svg>
            Export
          </a>

          {anyFilterActive && (
            <Link
              // Preserve view mode when clearing filters — dropping filters
              // shouldn't yank the user from list view back to kanban default.
              href={viewMode === "list" ? "/commercial/opportunities?view=list" : "/commercial/opportunities"}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-600 text-[12px] font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6L6 18 M6 6l12 12" />
              </svg>
              Clear
            </Link>
          )}
        </form>

        {/* Active filter chip strip — shows what's applied so users can
            drop one at a time without opening the popover. */}
        {anyFilterActive && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mr-1">
              Applied:
            </span>
            {search && <ActiveFilterChip href={clearFilterHref("q")} label={`Search: "${search}"`} />}
            {validStatus && <ActiveFilterChip href={clearFilterHref("status")} label={`Status: ${opportunityStatusLabel(validStatus)}`} />}
            {hotFilter && <ActiveFilterChip href={clearFilterHref("hot")} label="🔥 Hot" />}
            {staleFilter && <ActiveFilterChip href={clearFilterHref("stale")} label={`Stale > ${STALE_OPP_DAYS}d`} />}
            {sourceSet.size > 0 && (
              <ActiveFilterChip
                href={clearFilterHref("sources")}
                label={`Source: ${Array.from(sourceSet).map((s) => opportunitySourceLabel(s)).join(", ")}`}
              />
            )}
          </div>
        )}
      </div>

      {/* ─── Status snapshot (list mode only — kanban columns ARE the
          snapshot) ─── */}
      {viewMode === "list" && statusSnapshot.length > 0 && (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl px-4 py-3">
          <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2 flex items-center justify-between">
            <span>Open by status</span>
            <span className="font-normal text-ppp-charcoal-400 normal-case tracking-normal text-[10px]">
              {validStatus ? "Tap active pill to clear" : "Tap to filter"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {statusSnapshot.map((r) => {
              const isActive = validStatus === r.status;
              return (
                <Link
                  key={r.status}
                  href={statusDrillHref(r.status)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border min-h-[36px] touch-manipulation transition-colors ${
                    isActive
                      ? "bg-cc-brand-600 border-cc-brand-700 text-white"
                      : "bg-white border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                  }`}
                  title={isActive ? `Showing only ${opportunityStatusLabel(r.status)} — tap to clear` : `Filter to ${opportunityStatusLabel(r.status)}`}
                >
                  <span>{opportunityStatusLabel(r.status)}</span>
                  <strong className={isActive ? "text-white" : "text-ppp-charcoal"}>
                    {r.count}
                  </strong>
                  {isActive && <span aria-hidden className="text-white">×</span>}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── List / Kanban / Empty ─── */}
      {opps.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No deals match these filters" : "No deals yet"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "Try clearing a filter or use search to find a specific bid."
              : "Log the first commercial deal to get started."}
          </p>
          {!anyFilterActive ? (
            <Link
              href="?new_deal=1#new-deal-sheet"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New deal
            </Link>
          ) : (
            <Link
              href="/commercial/opportunities"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Clear all filters
            </Link>
          )}
        </div>
      ) : viewMode === "customer" ? (
        <CustomerBoard
          opps={opps}
          accountById={accountById}
          sheetHref={customerSheetHref}
        />
      ) : viewMode === "kanban" ? (
        <KanbanBoard
          opps={opps}
          accountById={accountById}
          statusEnteredAtMap={statusEnteredAtMap}
          taskStatsMap={taskStatsMap}
          primaryLeadMap={primaryLeadMap}
          fileCountMap={fileCountMap}
          submittalCountMap={submittalCountMap}
          finishCountMap={finishCountMap}
          sheetHref={customerSheetHref}
          flipReturnHref={flipReturnHref}
        />
      ) : (
        (() => {
          // Karan 2026-07-10 (ui-micro-details rule): group same-account
          // opps under a subtle account header so scanning tells you
          // "Bob = 2 opps, KARAN = 1 opp" without reading every row.
          // Single-opp accounts render without a header — no wasted
          // vertical space. Group order preserves the original sort by
          // taking each account's first-seen index in `opps`.
          const groups: Array<{ accountId: string; account: CommercialAccount | null; opps: CommercialOpportunity[] }> = [];
          const groupIndex = new Map<string, number>();
          for (const o of opps) {
            const idx = groupIndex.get(o.account_id);
            if (idx === undefined) {
              groupIndex.set(o.account_id, groups.length);
              groups.push({
                accountId: o.account_id,
                account: accountById.get(o.account_id) ?? null,
                opps: [o],
              });
            } else {
              groups[idx].opps.push(o);
            }
          }
          return (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-ppp-charcoal">
                    {opps.length} deal{opps.length === 1 ? "" : "s"} · {groups.length} customer{groups.length === 1 ? "" : "s"}
                  </h2>
                  <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                    Sorted by {currentSortLabel.toLowerCase()}. Same-customer deals are grouped.
                  </p>
                </div>
              </div>
              {/* Karan 2026-07-10 (rev 5): per-account color accent. The
                  cards were visually identical; Karan asked for account
                  differentiation. Each account_id hashes deterministically
                  into one of 8 muted palette entries → colored 4px left
                  bar + colored circular initials badge. Same account
                  always gets the same color (so users learn "Bob is
                  amber"), and neighbors are visually distinct at a
                  glance. Palette avoids blue/navy (Karan-banned). */}
              <ul className="space-y-3">
                {groups.map((g) => {
                  const tone = accountColorTone(g.accountId);
                  // Karan 2026-07-10 audit fix (rev 5 avatar edge case):
                  // whitespace-only company_name ("   ") is truthy in JS
                  // so `|| "?"` didn't fall through — split+filter left
                  // an empty array and the avatar rendered blank. Trim
                  // FIRST and re-fallback to "?" if the result is empty,
                  // plus join+fallback so an unusual name (emoji-only,
                  // pure punctuation) still lands on a glyph.
                  const initials = g.account
                    ? ((g.account.company_name || "").trim() || "?")
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((w) => w[0]!.toUpperCase())
                        .join("") || "?"
                    : "?";
                  return (
                  <li
                    key={g.accountId}
                    className="bg-white border border-ppp-charcoal-200 rounded-xl shadow-sm overflow-hidden border-l-4"
                    style={tone.border}
                  >
                    {g.account && (
                      <div
                        className="px-4 py-3 flex items-center justify-between gap-3 border-b border-ppp-charcoal-100"
                        style={tone.headerBg}
                      >
                        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                          <span
                            aria-hidden
                            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold"
                            style={tone.avatar}
                          >
                            {initials}
                          </span>
                          <Link
                            href={`/commercial/accounts/${g.account.id}`}
                            className="text-[14px] font-bold hover:underline underline-offset-2 truncate inline-flex items-center min-h-[44px] touch-manipulation"
                            style={tone.nameText}
                            title={`Open ${g.account.company_name}'s account`}
                          >
                            {g.account.company_name}
                          </Link>
                          {g.account.is_key_relationship && (
                            <span
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200 shrink-0"
                              title="Key relationship — flagged by admin"
                            >
                              <span aria-hidden>★</span> Key
                            </span>
                          )}
                          {g.account.industry && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-white text-ppp-charcoal-700 border-ppp-charcoal-200 shrink-0">
                              {g.account.industry}
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-ppp-charcoal-600 bg-white border border-ppp-charcoal-200 rounded-full px-2 py-0.5 tabular-nums">
                          {g.opps.length} deal{g.opps.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    )}
                    <ul className="divide-y divide-ppp-charcoal-100">
                      {g.opps.map((o) => (
                        <OpportunityRow
                          key={o.id}
                          opportunity={o}
                          account={g.account}
                          statusEnteredAt={statusEnteredAtMap.get(o.id) ?? null}
                          taskStats={taskStatsMap.get(o.id) ?? null}
                          lastNote={lastNoteMap.get(o.id) ?? null}
                          primaryLead={primaryLeadMap.get(o.id) ?? null}
                          fileCount={fileCountMap.get(o.id) ?? 0}
                          submittalStats={submittalCountMap.get(o.id) ?? null}
                          finishCount={finishCountMap.get(o.id) ?? 0}
                          sheetHref={customerSheetHref}
                          flipReturnHref={flipReturnHref}
                          hideAccount={g.account !== null}
                        />
                      ))}
                    </ul>
                  </li>
                  );
                })}
              </ul>
            </div>
          );
        })()
      )}

      {/* ─── Karan 2026-07-08 rewrite: customer-scoped quick sheet.
          When ?customer=<account_uuid> is set, we fetch the account's
          team + invoice rollup + invoice list + all deals, and render
          a right-side sheet (GoHighLevel-style) with company info,
          team members, financials with progress bars, invoice list,
          and active/closed deals. Top-right "View account →" link.
          Backdrop link closes by dropping ?customer + ?focus. */}
      {peekAccountId && accountById.has(peekAccountId) && (
        <CustomerQuickSheetLoader
          accountId={peekAccountId}
          account={accountById.get(peekAccountId)!}
          focusOppId={focusOppId}
          allOppsForAccount={opps.filter((o) => o.account_id === peekAccountId)}
          closeHref={customerSheetCloseHref}
          flipReturnHref={flipReturnHref}
        />
      )}

      {/* Karan 2026-07-08: GHL-style right-side "New deal" slide-out.
          Backdrop <Link> closes without a click handler (works with JS
          off too). Account picker is a text input backed by a <datalist>
          of live accounts so the user can type the customer name or
          scroll — the underlying value is the account_id we submit. */}
      {newDealOpen && (
        <NewDealSlideOut
          accounts={accounts.filter((a) => !a.deleted_at)}
          closeHref={newDealSheetCloseHref}
          sheetError={sheetError}
          action={createDealFromPipelineAction}
        />
      )}
    </div>
  );
}

// Karan 2026-07-08: right-side slide-out for creating a deal on the pipeline
// page. Uses a hidden account_id input paired with a visible text field +
// <datalist> so the user picks by name but we submit the UUID directly.
// Kept as a server-rendered aside (no client component needed) because
// the interactivity is just <input list=> autocomplete + form submit.
function NewDealSlideOut({
  accounts,
  closeHref,
  sheetError,
  action,
}: {
  accounts: CommercialAccount[];
  closeHref: string;
  sheetError: string | null;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <>
      <Link
        href={closeHref}
        aria-label="Close new deal panel"
        className="fixed inset-0 z-40 bg-ppp-charcoal-900/40 backdrop-blur-sm"
      />
      <aside
        id="new-deal-sheet"
        className="fixed right-0 top-0 bottom-0 z-50 w-full sm:max-w-md bg-white shadow-2xl flex flex-col"
        aria-label="Create a new deal"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-ppp-charcoal-100">
          <div>
            <h2 className="text-base font-bold text-ppp-charcoal">New deal</h2>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              Pick the customer, name the deal, click Create.
            </p>
          </div>
          <Link
            href={closeHref}
            aria-label="Close"
            className="p-2 -m-2 text-ppp-charcoal-400 hover:text-ppp-charcoal touch-manipulation min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6L6 18 M6 6l12 12" />
            </svg>
          </Link>
        </div>
        {sheetError && (
          <div className="mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            {sheetError}
          </div>
        )}
        <form id="new-deal-form" action={action} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Client-side account picker: visible input is the customer
              name, hidden input carries the resolved UUID that the
              server action reads as account_id. Client component
              needed because <datalist> filters on `value` not `label`,
              so we can't get name-based autocomplete server-only. */}
          <NewDealAccountPicker
            accounts={accounts.map((a) => ({ id: a.id, company_name: a.company_name }))}
          />

          <div>
            <label htmlFor="new-deal-title" className={LABEL_CLS}>
              Deal name <span className="text-red-600">*</span>
            </label>
            <input
              id="new-deal-title"
              name="title"
              required
              maxLength={200}
              placeholder='e.g. "40 Wall St — Lobby repaint"'
              className={INPUT_CLS}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="new-deal-status" className={LABEL_CLS}>Status</label>
              <select
                id="new-deal-status"
                name="status"
                defaultValue="qualifying"
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
              >
                {OPPORTUNITY_STATUSES.map((s) => (
                  <option key={s} value={s}>{opportunityStatusLabel(s)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="new-deal-source" className={LABEL_CLS}>Source</label>
              <select
                id="new-deal-source"
                name="source"
                defaultValue=""
                className={SELECT_CLS}
                style={SELECT_BG_STYLE}
              >
                <option value="">— unspecified —</option>
                {OPPORTUNITY_SOURCES.map((s) => (
                  <option key={s} value={s}>{opportunitySourceLabel(s)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="new-deal-bid-low" className={LABEL_CLS}>Bid low ($)</label>
              <input
                id="new-deal-bid-low"
                name="bid_value_low_dollars"
                inputMode="decimal"
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="new-deal-bid-high" className={LABEL_CLS}>Bid high ($)</label>
              <input
                id="new-deal-bid-high"
                name="bid_value_high_dollars"
                inputMode="decimal"
                placeholder="0.00"
                className={INPUT_CLS}
              />
            </div>
          </div>

          <div>
            <label htmlFor="new-deal-due" className={LABEL_CLS}>Proposal due</label>
            <DatePicker
              id="new-deal-due"
              name="proposal_due_at"
              placeholder="Pick a due date"
              ariaLabel="Proposal due date"
            />
          </div>

          <div>
            <label htmlFor="new-deal-desc" className={LABEL_CLS}>Notes (optional)</label>
            <textarea
              id="new-deal-desc"
              name="description"
              rows={3}
              placeholder="Scope, contact, anything the team should know…"
              className={TEXTAREA_CLS}
            />
          </div>
        </form>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ppp-charcoal-100 bg-ppp-charcoal-50/50">
          <Link
            href={closeHref}
            className="inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-100 min-h-[44px]"
          >
            Cancel
          </Link>
          <NewDealSubmitProxy />
        </div>
      </aside>
    </>
  );
}

// Karan 2026-07-08: the Create button lives in the footer outside the
// scrollable <form> content, so we use a tiny inline <button
// form="…"> proxy to submit the form by id. Wrapping the entire aside
// in one <form> would also work but nesting the scrollable body +
// sticky footer is easier with an explicit form id.
function NewDealSubmitProxy() {
  // Karan 2026-07-10 (audit round 4 fix): swapped plain <button> for
  // PendingFormButton so users see "Creating…" during the server
  // action round-trip. The button lives OUTSIDE the form via form=id,
  // so useFormStatus can't reach it — PendingFormButton subscribes
  // to the form's submit event by id instead.
  return (
    <PendingFormButton
      formId="new-deal-form"
      className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30 disabled:hover:bg-cc-brand-600"
      pendingLabel="Creating…"
    >
      Create deal
    </PendingFormButton>
  );
}

/**
 * Customer sheet data loader — server-fetches team + invoice rollup +
 * per-account invoices only when the sheet is open. Isolating the
 * fetches inside this component keeps them off the hot pipeline-list
 * render path (one customer at a time when peeking, zero fetches when
 * no ?customer= param).
 */
async function CustomerQuickSheetLoader({
  accountId,
  account,
  focusOppId,
  allOppsForAccount,
  closeHref,
  flipReturnHref,
}: {
  accountId: string;
  account: CommercialAccount;
  focusOppId: string | null;
  allOppsForAccount: CommercialOpportunity[];
  closeHref: string;
  flipReturnHref: string;
}) {
  const [team, rollup, invoices] = await Promise.all([
    listAccountTeam(accountId),
    getInvoiceRollupForAccount(accountId),
    listCommercialInvoices({ accountId }),
  ]);
  return (
    <CustomerQuickSheet
      account={account}
      team={team}
      rollup={rollup}
      invoices={invoices}
      allDeals={allOppsForAccount}
      focusOppId={focusOppId}
      closeHref={closeHref}
      flipReturnHref={flipReturnHref}
    />
  );
}

/**
 * Customer-first view — Karan 2026-07-08 Batch 1c. One card per account
 * with active work, ordered by weighted pipeline value descending (biggest
 * first). Alex's mental model: "show me every customer we're working with
 * right now." Each card exposes the customer name (clickable → account
 * page's Deals tab), key relationship pill, N open + N decided counts,
 * weighted pipeline, latest activity, plus a subtle deal chip strip
 * showing every deal title as a pill. Clicking a deal chip drills into
 * the deal detail. Empty state falls back to a helpful hint.
 */
function CustomerBoard({
  opps,
  accountById,
  sheetHref,
}: {
  opps: CommercialOpportunity[];
  accountById: Map<string, CommercialAccount>;
  sheetHref: (accountId: string, focus?: string) => string;
}) {
  // Group opps by account_id, then compute per-account rollups.
  const byAccount = new Map<string, CommercialOpportunity[]>();
  for (const o of opps) {
    const existing = byAccount.get(o.account_id) ?? [];
    existing.push(o);
    byAccount.set(o.account_id, existing);
  }

  type Row = {
    account: CommercialAccount;
    open: CommercialOpportunity[];
    closed: CommercialOpportunity[];
    weightedCents: number;
    latestUpdate: string;
  };

  const rows: Row[] = Array.from(byAccount.entries())
    .map(([accountId, oppsForAccount]) => {
      const account = accountById.get(accountId);
      if (!account) return null; // filtered by account soft-delete, skip
      const open = oppsForAccount.filter(
        (o) => !TERMINAL_STATUSES.has(o.status)
      );
      const closed = oppsForAccount.filter((o) =>
        TERMINAL_STATUSES.has(o.status)
      );
      const weightedCents = open.reduce(
        (sum, o) => sum + weightedPipelineCents(o),
        0
      );
      const latestUpdate = oppsForAccount
        .map((o) => o.updated_at ?? "")
        .filter(Boolean)
        .sort()
        .reverse()[0] ?? "";
      return { account, open, closed, weightedCents, latestUpdate };
    })
    .filter((r): r is Row => r !== null)
    .sort((a, b) => {
      // Sort: biggest weighted pipeline first, then most recently active.
      if (a.weightedCents !== b.weightedCents) return b.weightedCents - a.weightedCents;
      return b.latestUpdate.localeCompare(a.latestUpdate);
    });

  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">
            {rows.length} customer{rows.length === 1 ? "" : "s"} on this list
          </h2>
          <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            Grouped by account, biggest weighted pipeline first. Click a customer to open their account, or a deal to drill in.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-ppp-charcoal-100">
        {rows.map((row) => (
          <CustomerBoardRow key={row.account.id} row={row} sheetHref={sheetHref} />
        ))}
      </ul>
    </div>
  );
}

function CustomerBoardRow({
  row,
  sheetHref,
}: {
  row: {
    account: CommercialAccount;
    open: CommercialOpportunity[];
    closed: CommercialOpportunity[];
    weightedCents: number;
    latestUpdate: string;
  };
  sheetHref: (accountId: string, focus?: string) => string;
}) {
  const { account, open, closed, weightedCents, latestUpdate } = row;
  // Latest activity relative label — "today", "5h ago", "3d ago", etc.
  // Uses updated_at which every mutation touches, so it's a real signal.
  const daysAgo = latestUpdate
    ? Math.max(0, Math.floor((Date.now() - new Date(latestUpdate).getTime()) / 86400000))
    : null;
  const activityLabel =
    daysAgo === null
      ? "—"
      : daysAgo === 0
      ? "today"
      : daysAgo === 1
      ? "yesterday"
      : `${daysAgo}d ago`;

  return (
    <li className="relative p-4 hover:bg-ppp-charcoal-50/40 transition-colors">
      {/* Karan 2026-07-09: whole row is clickable — an absolutely-
          positioned Link overlays the entire card so any dead space
          opens the account. Nested links (deal chips + View button)
          sit at z-10 so they win the click when clicked directly. */}
      <Link
        href={`/commercial/accounts/${account.id}`}
        aria-label={`Open ${account.company_name}`}
        className="absolute inset-0 z-0"
      />
      <div className="relative z-10 flex items-start justify-between gap-3 flex-wrap">
        {/* Left column — customer identity + signal metadata. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/commercial/accounts/${account.id}`}
              className="text-sm font-bold text-ppp-charcoal hover:text-cc-brand-700 hover:underline underline-offset-2 break-words"
              title={`Open ${account.company_name}'s account`}
            >
              {account.company_name}
            </Link>
            {account.is_key_relationship && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200"
                title="Key relationship — flagged by admin"
              >
                <span aria-hidden>★</span> Key
              </span>
            )}
            {account.industry && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200">
                {account.industry}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[12px] text-ppp-charcoal-600 flex items-center gap-x-2 gap-y-1 flex-wrap">
            <span className="font-semibold text-ppp-charcoal">
              {open.length} open bid{open.length === 1 ? "" : "s"}
            </span>
            {weightedCents > 0 && (
              <>
                <span aria-hidden className="text-ppp-charcoal-300">·</span>
                <span className="text-ppp-charcoal-500">
                  <strong className="text-ppp-charcoal">{formatCents(weightedCents)}</strong> weighted
                </span>
              </>
            )}
            {closed.length > 0 && (
              <>
                <span aria-hidden className="text-ppp-charcoal-300">·</span>
                <span className="text-ppp-charcoal-500">
                  {closed.length} closed
                </span>
              </>
            )}
            <span aria-hidden className="text-ppp-charcoal-300">·</span>
            <span className="text-ppp-charcoal-500">Active {activityLabel}</span>
          </div>
        </div>
        {/* Right column — "View" button that opens the customer quick
            sheet on the right (per user 2026-07-08: "there should be a
            view button, and that view button is a quick view customer
            sheet"). The account name itself still links to the account
            page for users who want the deep dive; this shows the
            GoHighLevel-style sheet with team + invoices + progress. */}
        <Link
          href={sheetHref(account.id)}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-white text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-700 min-h-[36px] touch-manipulation transition-colors"
          title={`Quick view of ${account.company_name}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          View
        </Link>
      </div>
      {/* Deal chip strip — subtle pills for each deal so users can drill
          straight into a specific deal without opening the account first.
          Open bids show as blue pills; closed dim to charcoal so the eye
          reads open-work first. `relative z-10` keeps these chips
          clickable above the whole-row stretched-link overlay. */}
      {(open.length > 0 || closed.length > 0) && (
        <div className="relative z-10 mt-2.5 flex flex-wrap gap-1.5">
          {open.map((o) => (
            <Link
              key={o.id}
              href={sheetHref(account.id, o.id)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-cc-brand-200 bg-cc-brand-50 text-cc-brand-800 text-[11.5px] font-medium hover:bg-cc-brand-100 hover:border-cc-brand-300 max-w-[280px] truncate"
              title={`View ${account.company_name} · ${o.title} — ${opportunityStatusLabel(o.status)}`}
            >
              <span className="truncate">{o.title}</span>
            </Link>
          ))}
          {closed.slice(0, 3).map((o) => (
            <Link
              key={o.id}
              href={sheetHref(account.id, o.id)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-600 text-[11.5px] font-medium hover:bg-ppp-charcoal-100 max-w-[280px] truncate"
              title={`View ${account.company_name} · ${o.title} — ${opportunityStatusLabel(o.status)}`}
            >
              <span className="truncate">{o.title}</span>
            </Link>
          ))}
          {closed.length > 3 && (
            <Link
              href={`/commercial/accounts/${account.id}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-ppp-charcoal-200 bg-white text-ppp-charcoal-500 text-[11.5px] font-medium hover:bg-ppp-charcoal-50"
              title={`See all ${closed.length} closed deals`}
            >
              +{closed.length - 3} more
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

/**
 * Kanban board — same shape as the prior implementation. Columns +
 * terminal drop targets + overflow drawer preserved unchanged. Only
 * the drag-hint header re-worded slightly for clarity.
 */
function KanbanBoard({
  opps,
  accountById,
  statusEnteredAtMap,
  taskStatsMap,
  primaryLeadMap,
  fileCountMap,
  submittalCountMap,
  finishCountMap,
  sheetHref,
  flipReturnHref,
}: {
  opps: CommercialOpportunity[];
  accountById: Map<string, CommercialAccount>;
  statusEnteredAtMap: Map<string, string>;
  taskStatsMap: Map<string, { open: number; overdue: number; due_soon: number }>;
  primaryLeadMap: Map<string, { user_email: string; user_full_name: string | null; role: string }>;
  fileCountMap: Map<string, number>;
  submittalCountMap: Map<string, { total: number; awaiting_response: number }>;
  finishCountMap: Map<string, number>;
  sheetHref: (accountId: string, focus?: string) => string;
  flipReturnHref: string;
}) {
  // v2 (2026-07-13 Katie's model): Kanban splits into two lanes.
  // Pre-Sale: Qualifying → Estimating → Proposal → Closed(Won/Lost)
  // Post-Sale: Pre-Construction → In Progress → Billing → Closed(Closeout/Closed)
  // Both lanes rendered stacked so Alex sees the whole pipeline without a
  // toggle. The Pre-Sale row leads with the sales flow; Post-Sale below is
  // the delivery flow. Cards render their sub-status as a small chip.
  const OPEN_COLUMNS_PRE_SALE: readonly OpportunityStatus[] = [
    "qualifying",
    "estimating",
    "proposal",
  ];
  const OPEN_COLUMNS_POST_SALE: readonly OpportunityStatus[] = [
    "pre_construction",
    "in_progress",
    "billing",
  ];
  const OPEN_COLUMNS = [
    ...OPEN_COLUMNS_PRE_SALE,
    ...OPEN_COLUMNS_POST_SALE,
  ] as readonly OpportunityStatus[];
  // Terminal drop targets — Won + Lost sit in the Pre-Sale closed cluster;
  // Closeout + Closed in the Post-Sale closed cluster. Client submits the
  // v1 shorthand "won"/"lost" via KanbanDnDColumn's `status` prop which
  // the compat shim in quickFlipStatusAction translates into the v2 tuple.
  const TERMINAL_COLUMNS: readonly OpportunityStatus[] = ["won", "lost"];
  const TERMINAL_DISPLAY_CAP = 10;

  const byStatus = new Map<OpportunityStatus, CommercialOpportunity[]>();
  for (const s of OPEN_COLUMNS) byStatus.set(s, []);
  // Terminal drops still keyed by v1 shorthand — the compat layer routes
  // dropped opps into pre_sale_closed with the correct sub_status.
  for (const s of TERMINAL_COLUMNS) byStatus.set(s, []);
  const overflowClosed: CommercialOpportunity[] = [];
  for (const o of opps) {
    // Route the visual sort: any Pre-Sale/Closed opp goes to the Won or
    // Lost visual bucket based on sub_status; any Post-Sale/Closed opp
    // to the Post-Sale closed bucket (currently just "closed" key).
    if (o.status === "pre_sale_closed") {
      if (o.sub_status === "won") byStatus.get("won" as OpportunityStatus)!.push(o);
      else byStatus.get("lost" as OpportunityStatus)!.push(o);
    } else if (OPEN_COLUMNS.includes(o.status as OpportunityStatus)) {
      byStatus.get(o.status as OpportunityStatus)!.push(o);
    } else if (o.status === "post_sale_closed") {
      // Post-Sale closed opps land in the overflow list for now — Alex
      // rarely wants to see historical closed deals in the Kanban; they
      // show up in the "Older decided deals" details drawer below.
      overflowClosed.push(o);
    }
  }
  for (const s of TERMINAL_COLUMNS) {
    const list = byStatus.get(s) ?? [];
    list.sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
    if (list.length > TERMINAL_DISPLAY_CAP) {
      const visible = list.slice(0, TERMINAL_DISPLAY_CAP);
      const overflow = list.slice(TERMINAL_DISPLAY_CAP);
      byStatus.set(s, visible);
      overflowClosed.push(...overflow);
    }
  }
  // Karan 2026-07-05: "so many statuses and its a lot to scroll thru."
  // Split the board into two flex-groups so users see the OPEN pipeline
  // (main flow) first, then a narrower "Closed" cluster grouped visually
  // at the far right. Drag-drop targets stay intact — each terminal
  // column still exists as a separate drop zone so the debrief flow
  // still routes correctly on drop.
  return (
    <KanbanDnDProvider>
      <div className="space-y-3">
        <div className="inline-flex items-center gap-2 text-[11px] text-ppp-charcoal-600 bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-full px-3 py-1.5">
          <span aria-hidden>💡</span>
          <span>
            Drag a card between stages to move it forward. Drop into <strong>Won / Lost</strong> to close the bid.
          </span>
        </div>
        {/* v2 (2026-07-13 Katie's model): Pre-Sale + Post-Sale lane
            labels above the column groups so Alex sees the two-lane
            structure. Sub-status chip on each card is handled inside
            KanbanCard. */}
        <div className="flex flex-wrap items-center gap-3 text-[10.5px] font-bold uppercase tracking-widest">
          <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-cc-brand-50 text-cc-brand-800 border border-cc-brand-200">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cc-brand-600" />
            Pre-Sale (sales flow)
          </span>
          <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            Post-Sale (delivery flow)
          </span>
          <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-700 border border-ppp-charcoal-200">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ppp-charcoal-500" />
            Closed
          </span>
        </div>
        <div className="overflow-x-auto -mx-2 px-2 pb-2">
          <div className="flex gap-3 min-w-max items-stretch">
            {/* Open pipeline — Pre-Sale + Post-Sale columns for the active flow.
                A subtle vertical divider between the two lanes helps the eye
                separate the two flows. */}
            {OPEN_COLUMNS.map((status, idx) => {
              const showLaneDivider = idx === OPEN_COLUMNS_PRE_SALE.length;
              const colOpps = byStatus.get(status) ?? [];
              const colTotal = colOpps.reduce(
                (acc, o) => acc + (o.bid_value_high_cents ?? o.bid_value_low_cents ?? 0),
                0
              );
              // v2 (2026-07-13): tone the Post-Sale columns emerald-tinted to
              // read as the delivery flow; Pre-Sale open columns stay neutral.
              const isPostSale = (OPEN_COLUMNS_POST_SALE as readonly string[]).includes(status);
              const tone = isPostSale
                ? { col: "bg-emerald-50/40 border-emerald-200", head: "bg-emerald-50 border-emerald-200" }
                : { col: "bg-ppp-charcoal-50/60 border-ppp-charcoal-100", head: "bg-white border-ppp-charcoal-100" };
              return (
                <React.Fragment key={status}>
                  {showLaneDivider && (
                    <div className="shrink-0 flex items-center px-1">
                      <div className="h-full w-px bg-emerald-200" />
                      <span className="ml-1 rotate-180 [writing-mode:vertical-rl] text-[9px] font-bold uppercase tracking-widest text-emerald-700">
                        Post-Sale
                      </span>
                    </div>
                  )}
                <KanbanDnDColumn status={status}>
                  <div className={`w-64 sm:w-72 shrink-0 border rounded-xl overflow-hidden flex flex-col h-full ${tone.col}`}>
                    <div className={`px-3 py-2 border-b ${tone.head}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-bold text-ppp-charcoal">
                          {opportunityStatusLabel(status)}
                        </span>
                        <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-white/70 text-ppp-charcoal-700 text-[11px] font-semibold border border-ppp-charcoal-100">
                          {colOpps.length}
                        </span>
                      </div>
                      {colTotal > 0 && (
                        <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                          {formatCents(colTotal)} top-of-range
                        </div>
                      )}
                    </div>
                    <ul className="p-2 space-y-2 overflow-y-auto max-h-[70vh] min-h-[120px]">
                      {colOpps.length === 0 ? (
                        <li className="text-[11px] text-ppp-charcoal-400 italic text-center py-6">
                          Drop a bid here
                        </li>
                      ) : (
                        colOpps.map((opp) => (
                          <KanbanDnDCard key={opp.id} oppId={opp.id}>
                            <KanbanCard
                              opp={opp}
                              account={accountById.get(opp.account_id) ?? null}
                              statusEnteredAt={statusEnteredAtMap.get(opp.id) ?? null}
                              taskStats={taskStatsMap.get(opp.id) ?? null}
                              primaryLead={primaryLeadMap.get(opp.id) ?? null}
                              fileCount={fileCountMap.get(opp.id) ?? 0}
                              submittalStats={submittalCountMap.get(opp.id) ?? null}
                              finishCount={finishCountMap.get(opp.id) ?? 0}
                              sheetHref={sheetHref}
                              flipReturnHref={flipReturnHref}
                            />
                          </KanbanDnDCard>
                        ))
                      )}
                    </ul>
                  </div>
                </KanbanDnDColumn>
                </React.Fragment>
              );
            })}

            {/* Closed cluster — 3 narrow stacked drop-target columns.
                Visually grouped inside a single "Closed" outer card so
                the eye reads them as one section. Each is still a
                separate KanbanDnDColumn so drag-to-Won vs drag-to-Lost
                still triggers the correct debrief routing. Narrower
                (w-44) so all 3 fit in the horizontal space one normal
                column used to take. */}
            <div className="shrink-0 border rounded-xl overflow-hidden flex flex-col h-full bg-white border-ppp-charcoal-100">
              <div className="px-3 py-2 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-bold text-ppp-charcoal uppercase tracking-wide">
                    Closed
                  </span>
                  <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-white text-ppp-charcoal-700 text-[11px] font-semibold border border-ppp-charcoal-100">
                    {TERMINAL_COLUMNS.reduce((acc, s) => acc + (byStatus.get(s)?.length ?? 0), 0)}
                  </span>
                </div>
                <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                  Drop here to close the deal
                </div>
              </div>
              {/* Cluster interior — stacks vertically on narrow phones (<640px)
                  so the 3 sub-columns don't force horizontal scroll inside
                  the already-narrow board layout. Side-by-side from sm+. */}
              <div className="flex flex-col sm:flex-row gap-2 p-2">
                {TERMINAL_COLUMNS.map((status) => {
                  const colOpps = byStatus.get(status) ?? [];
                  const tone =
                    status === "won"
                      ? { col: "bg-emerald-50/40 border-emerald-200", head: "bg-emerald-100 border-emerald-200 text-emerald-800" }
                      : status === "lost"
                      ? { col: "bg-rose-50/40 border-rose-200", head: "bg-rose-100 border-rose-200 text-rose-800" }
                      : { col: "bg-slate-50 border-slate-200", head: "bg-slate-100 border-slate-200 text-slate-700" };
                  return (
                    <KanbanDnDColumn key={status} status={status}>
                      <div className={`w-full sm:w-44 lg:w-48 shrink-0 border rounded-lg overflow-hidden flex flex-col h-full ${tone.col}`}>
                        <div className={`px-2 py-1.5 border-b ${tone.head}`}>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-bold uppercase tracking-wide">
                              {opportunityStatusLabel(status)}
                            </span>
                            <span className="inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full bg-white/80 text-ppp-charcoal-700 text-[10px] font-semibold">
                              {colOpps.length}
                            </span>
                          </div>
                        </div>
                        <ul className="p-1.5 space-y-1.5 overflow-y-auto max-h-[70vh] min-h-[64px]">
                          {colOpps.length === 0 ? (
                            <li className="text-[10px] text-ppp-charcoal-400 italic text-center py-3 leading-tight">
                              {status === "won" ? "Drop a winning deal" : status === "lost" ? "Drop a lost deal" : "Drop a no-bid deal"}
                            </li>
                          ) : (
                            colOpps.map((opp) => (
                              <KanbanDnDCard key={opp.id} oppId={opp.id}>
                                <KanbanCard
                                  opp={opp}
                                  account={accountById.get(opp.account_id) ?? null}
                                  statusEnteredAt={statusEnteredAtMap.get(opp.id) ?? null}
                                  taskStats={taskStatsMap.get(opp.id) ?? null}
                                  primaryLead={primaryLeadMap.get(opp.id) ?? null}
                                  fileCount={fileCountMap.get(opp.id) ?? 0}
                                  submittalStats={submittalCountMap.get(opp.id) ?? null}
                                  finishCount={finishCountMap.get(opp.id) ?? 0}
                                  sheetHref={sheetHref}
                                  flipReturnHref={flipReturnHref}
                                  compact
                                />
                              </KanbanDnDCard>
                            ))
                          )}
                        </ul>
                      </div>
                    </KanbanDnDColumn>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        {overflowClosed.length > 0 && (
          <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <summary className="px-4 py-2.5 cursor-pointer text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 list-none flex items-center justify-between min-h-[44px] touch-manipulation">
              <span>Older decided deals · {overflowClosed.length}</span>
              <span aria-hidden className="text-ppp-charcoal-400">▾</span>
            </summary>
            <ul className="divide-y divide-ppp-charcoal-100 px-3 py-2">
              {overflowClosed.map((opp) => (
                <li key={opp.id} className="py-2">
                  <Link
                    href={sheetHref(opp.account_id, opp.id)}
                    className="text-[13px] text-cc-brand-700 hover:text-cc-brand-800 underline"
                  >
                    {derivedOppName(opp, accountById.get(opp.account_id)?.company_name ?? null)}
                  </Link>
                  <span className="text-[11px] text-ppp-charcoal-500 ml-2">
                    {opportunityStatusLabel(opp.status)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </KanbanDnDProvider>
  );
}

function KanbanCard({
  opp,
  account,
  statusEnteredAt,
  taskStats,
  primaryLead,
  fileCount,
  submittalStats,
  finishCount,
  sheetHref,
  flipReturnHref,
  compact,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: string } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
  sheetHref: (accountId: string, focus?: string) => string;
  flipReturnHref: string;
  /** Compact mode — used inside the narrow "Closed" cluster where cards
   *  have half the horizontal space of the open pipeline. Hides quick-flip
   *  form + trims the meta band to just title + bid. */
  compact?: boolean;
}) {
  const nextStatuses = allowedNextStatuses(opp.status);
  const days = statusEnteredAt
    ? Math.floor((Date.now() - new Date(statusEnteredAt).getTime()) / MS_PER_DAY)
    : null;
  const daysTone =
    days === null
      ? "text-ppp-charcoal-400"
      : days > 14
      ? "text-rose-600"
      : days > 7
      ? "text-amber-600"
      : "text-cc-brand-600";
  const leadFirst = primaryLead
    ? primaryLead.user_full_name?.split(" ")[0] ?? primaryLead.user_email.split("@")[0]
    : null;
  if (compact) {
    // Compact mode — used inside the narrow "Closed" cluster. Just
    // title + account + bid; no quick-flip form (closed deals shouldn't
    // be re-routed by drag, they go through the Reopen action instead).
    return (
      <li className="bg-white border border-ppp-charcoal-100 rounded-md p-1.5 hover:border-ppp-charcoal-200 transition-colors">
        <Link href={sheetHref(opp.account_id, opp.id)} className="block">
          <div className="text-[11px] font-semibold text-ppp-charcoal leading-snug break-words line-clamp-2">
            {derivedOppName(opp, account?.company_name ?? null)}
          </div>
          {account && (
            <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 truncate">
              {account.company_name}
            </div>
          )}
          <div className="text-[10px] font-medium text-ppp-charcoal-700 mt-0.5">
            {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
          </div>
        </Link>
      </li>
    );
  }
  return (
    <li className="bg-white border border-ppp-charcoal-100 rounded-lg p-2.5 hover:border-ppp-charcoal-200 transition-colors">
      <Link
        href={sheetHref(opp.account_id, opp.id)}
        className="block"
      >
        <div className="text-[13px] font-semibold text-ppp-charcoal leading-snug mb-1 break-words">
          {derivedOppName(opp, account?.company_name ?? null)}
        </div>
        {account && (
          <div className="text-[11px] text-ppp-charcoal-500 mb-1.5 truncate">
            {account.company_name}
          </div>
        )}
        <div className="text-[12px] font-medium text-ppp-charcoal-800">
          {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span>{opp.probability_pct}%</span>
          {days !== null && (
            <span className={daysTone}>· {days}d here</span>
          )}
          {leadFirst && (
            <span>· <span aria-hidden>★</span> {leadFirst}</span>
          )}
          {taskStats && taskStats.overdue > 0 && (
            <span className="text-rose-600">· {taskStats.overdue} overdue</span>
          )}
          {fileCount > 0 && (
            <span>· <span aria-hidden>📎</span> {fileCount}</span>
          )}
          {finishCount > 0 && (
            <span>· <span aria-hidden>🎨</span> {finishCount}</span>
          )}
          {submittalStats && submittalStats.total > 0 && (
            <span className={submittalStats.awaiting_response > 0 ? "text-sky-700 font-medium" : undefined}>
              · <span aria-hidden>📋</span> {submittalStats.total}
              {submittalStats.awaiting_response > 0 && ` (${submittalStats.awaiting_response} awaiting)`}
            </span>
          )}
        </div>
      </Link>
      {nextStatuses.length > 0 && (
        <form action={quickFlipStatusAction} className="mt-2 pt-2 border-t border-ppp-charcoal-100 flex items-center gap-1.5">
          <input type="hidden" name="opp_id" value={opp.id} />
          <input type="hidden" name="return_href" value={flipReturnHref} />
          <select
            name="to_status"
            defaultValue=""
            required
            className={`${SELECT_CLS} flex-1 text-base sm:text-xs py-1.5 min-h-[44px] sm:min-h-[36px]`}
            style={SELECT_BG_STYLE}
            aria-label={`Move ${opp.title}`}
          >
            <option value="" disabled>Move to…</option>
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
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            Go
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * Slim KPI card — same shape as the accounts page. Consistency across
 * both list pages so users learn the pattern once.
 */
function KpiCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: "cc-brand" | "blue" | "neutral";
  label: string;
  value: string;
  sub: string;
}) {
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/50"
      : tone === "blue"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-blue-50/50"
      : "border-ppp-charcoal-100 bg-white";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "blue" ? "bg-cc-brand-500" : "bg-ppp-charcoal-200";
  return (
    <div className={`relative border rounded-xl px-4 py-3 overflow-hidden shadow-sm ${ring}`}>
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="text-[12px] font-semibold text-ppp-charcoal-700">
        {label}
      </div>
      <div className="text-xl sm:text-2xl font-bold text-ppp-charcoal mt-1">
        {value}
      </div>
      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{sub}</div>
    </div>
  );
}

/**
 * One-click "remove this specific filter" chip. Same shape as the
 * accounts page ActiveFilterChip for visual consistency.
 */
function ActiveFilterChip({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-700 text-[11px] font-semibold hover:bg-cc-brand-100 transition-colors min-h-[28px] touch-manipulation"
      title={`Remove filter: ${label}`}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18 6L6 18 M6 6l12 12" />
      </svg>
    </Link>
  );
}

function SortOption({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg min-h-[40px] touch-manipulation transition-colors ${
        active ? "bg-cc-brand-50 hover:bg-cc-brand-100" : "hover:bg-ppp-charcoal-50"
      }`}
    >
      <span
        className={`inline-flex items-center justify-center h-4 w-4 rounded-full border shrink-0 ${
          active ? "border-cc-brand-600" : "border-ppp-charcoal-300"
        }`}
        aria-hidden
      >
        {active && <span className="block h-2 w-2 rounded-full bg-cc-brand-600" />}
      </span>
      <span className={`text-[13px] font-semibold ${active ? "text-cc-brand-800" : "text-ppp-charcoal-700"}`}>
        {label}
      </span>
    </Link>
  );
}

function FilterOption({
  href,
  active,
  label,
  description,
}: {
  href: string;
  active: boolean;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg min-h-[44px] touch-manipulation transition-colors ${
        active ? "bg-cc-brand-50 hover:bg-cc-brand-100" : "hover:bg-ppp-charcoal-50"
      }`}
    >
      <span
        className={`mt-0.5 inline-flex items-center justify-center h-4 w-4 rounded border shrink-0 ${
          active ? "bg-cc-brand-600 border-cc-brand-700 text-white" : "bg-white border-ppp-charcoal-300 text-transparent"
        }`}
        aria-hidden
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-semibold ${active ? "text-cc-brand-800" : "text-ppp-charcoal"}`}>
          {label}
        </div>
        <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 leading-snug">
          {description}
        </p>
      </div>
    </Link>
  );
}

/**
 * Opportunity row — redesigned 3-line hierarchy:
 *   Line 1: title + status pill + DueChip
 *   Line 2: account · rating · prequal · bid · confidence
 *   Line 3: days-in-status · tasks · last-note · lead · files · finishes · submittals
 *   Line 4 (conditional): tab-jump chips (finishes / submittals with awaiting)
 *   Line 5 (conditional): quick-flip form
 *
 * Same data as before, cleaner visual grouping. Right chevron aligns to
 * the first line. All signals preserved (Karan: "the information we have
 * is all needed, dont take anything out").
 */
function OpportunityRow({
  opportunity,
  account,
  statusEnteredAt,
  taskStats,
  lastNote,
  primaryLead,
  fileCount,
  submittalStats,
  finishCount,
  sheetHref,
  flipReturnHref,
  hideAccount = false,
}: {
  opportunity: CommercialOpportunity;
  account: CommercialAccount | null;
  statusEnteredAt: string | null;
  taskStats: { open: number; overdue: number; due_soon: number } | null;
  lastNote: { created_at: string; author_label: string | null } | null;
  primaryLead: { user_email: string; user_full_name: string | null; role: import("@/lib/commercial/opportunities/assignments").OpportunityAssignmentRole } | null;
  fileCount: number;
  submittalStats: { total: number; awaiting_response: number } | null;
  finishCount: number;
  sheetHref: (accountId: string, focus?: string) => string;
  flipReturnHref: string;
  /** Karan 2026-07-10: when true, suppress the row's inline account
   *  name + industry chip because the outer group header already
   *  renders them. Kills the "Bob · Bob · — bid" repetition. */
  hideAccount?: boolean;
}) {
  const bid = formatBidRange(opportunity.bid_value_low_cents, opportunity.bid_value_high_cents);
  const dueChip = decisionChip(opportunity.proposal_due_at);
  const daysInStatus = statusEnteredAt
    ? Math.floor((Date.now() - new Date(statusEnteredAt).getTime()) / MS_PER_DAY)
    : null;
  const defaultProb = DEFAULT_PROBABILITY_BY_STATUS[opportunity.status] ?? null;
  const probOverridden = defaultProb !== null && opportunity.probability_pct !== defaultProb;
  const nextStatuses = allowedNextStatuses(opportunity.status);
  // Karan 2026-07-11 (signature-moments): days-idle heat treatment on
  // open deals only. Terminal statuses (won/lost/no_bid) aren't "idle"
  // — they closed intentionally. Amber at 7 days stuck, rose at 14.
  // Silent signal, no extra chip.
  //
  // Post-audit fix (2026-07-11): the earlier version paired the idle
  // background with `hover:bg-ppp-charcoal-50/60` — on hover the row
  // washed neutral gray, LOSING the heat signal exactly when the
  // user was engaging with it. Now the hover state DEEPENS the same
  // color so heat stays visible; only fresh rows get the neutral hover.
  const isOpenDeal = !isTerminalOpportunityStatus(opportunity.status);
  const idleTint =
    isOpenDeal && daysInStatus !== null
      ? daysInStatus >= 14
        ? "bg-rose-50/40 hover:bg-rose-100/60"
        : daysInStatus >= 7
        ? "bg-amber-50/40 hover:bg-amber-100/60"
        : "hover:bg-ppp-charcoal-50/60"
      : "hover:bg-ppp-charcoal-50/60";
  return (
    <li className={`relative group/row transition-colors ${idleTint}`}>
      <Link
        href={sheetHref(opportunity.account_id, opportunity.id)}
        className="block px-4 py-4 touch-manipulation"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Line 1 — title + status + due chip. Bigger typography so
                scanning finds titles fast. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-ppp-charcoal text-[15px] leading-tight">
                {derivedOppName(opportunity, account?.company_name ?? null)}
              </span>
              <StatusPill status={opportunity.status} />
              {dueChip && <DueChip {...dueChip} />}
            </div>

            {/* Deal-journey progress strip (Karan 2026-07-11 signature-
                moments Tier 2). Shows the full pipeline stages inline
                so users see where the deal IS in the journey without
                reading a status label. Terminal deals render a compact
                closed cap. */}
            <div className="mt-1.5">
              <DealJourneyStrip status={opportunity.status} sub_status={opportunity.sub_status} />
            </div>

            {/* Line 2 — account context + bid + confidence. Muted so
                the eye lands on the title first. When the row lives
                inside an account-grouped list, hide the account
                name+chips (already surfaced in the group header) so
                the line doesn't read as "Bob · Bob · — bid". */}
            <div className="text-[12px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
              {!hideAccount && account && (
                <span className="text-ppp-charcoal-700 font-medium">{account.company_name}</span>
              )}
              {!hideAccount && account?.rating && <RatingPill rating={account.rating} />}
              {!hideAccount && account?.prequalification_status && account.prequalification_status !== "not_started" && (
                <PrequalPill status={account.prequalification_status} />
              )}
              {!hideAccount && account && <span aria-hidden>·</span>}
              <span>
                <strong className="text-ppp-charcoal">{bid}</strong> bid
              </span>
              <span aria-hidden>·</span>
              <span title={probOverridden ? `Default ${defaultProb}% for ${opportunityStatusLabel(opportunity.status)} — overridden` : undefined}>
                {opportunity.probability_pct}% confident
                {probOverridden && <span className="ml-0.5 text-amber-700" aria-label="Probability overridden from status default">*</span>}
              </span>
            </div>

            {/* Line 3 — signal row: days-in-status, tasks, last-note,
                lead, files, finishes, submittals. Each only renders
                when data warrants it. Colored tint on urgent signals
                (overdue tasks, stuck deal). */}
            {(daysInStatus !== null || taskStats || lastNote || primaryLead || fileCount > 0 || finishCount > 0 || (submittalStats && submittalStats.total > 0)) && (
              <div className="text-[12px] mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-ppp-charcoal-600">
                {daysInStatus !== null && (
                  <span
                    className={
                      daysInStatus > 14
                        ? "text-rose-700 font-medium"
                        : daysInStatus > 7
                        ? "text-amber-700"
                        : "text-ppp-charcoal-600"
                    }
                    title={`Entered ${opportunityStatusLabel(opportunity.status)} ${daysInStatus}d ago`}
                  >
                    {daysInStatus}d in {opportunityStatusLabel(opportunity.status).toLowerCase()}
                  </span>
                )}
                {taskStats && taskStats.open > 0 && (
                  <span
                    className={
                      taskStats.overdue > 0
                        ? "text-rose-700 font-medium"
                        : taskStats.due_soon > 0
                        ? "text-amber-700"
                        : "text-ppp-charcoal-600"
                    }
                    title={`${taskStats.open} open · ${taskStats.overdue} overdue · ${taskStats.due_soon} due in 7d`}
                  >
                    {taskStats.overdue > 0
                      ? `${taskStats.overdue} overdue task${taskStats.overdue === 1 ? "" : "s"}`
                      : `${taskStats.open} open task${taskStats.open === 1 ? "" : "s"}`}
                  </span>
                )}
                {lastNote && (
                  <span className="text-ppp-charcoal-600" title={new Date(lastNote.created_at).toLocaleString()}>
                    Last note {relativeAgo(lastNote.created_at)}
                    {lastNote.author_label ? ` · ${lastNote.author_label}` : ""}
                  </span>
                )}
                {primaryLead && (
                  <span
                    className="inline-flex items-center gap-1 text-cc-brand-700"
                    title={`${opportunityAssignmentRoleLabel(primaryLead.role)}: ${primaryLead.user_full_name ?? primaryLead.user_email}`}
                  >
                    <span aria-hidden>★</span>
                    {(primaryLead.user_full_name ?? primaryLead.user_email).split(" ")[0]}
                  </span>
                )}
                {fileCount > 0 && (
                  <span className="text-ppp-charcoal-600" title="Plans & Specs attachments">
                    <span aria-hidden>📎</span> {fileCount} {fileCount === 1 ? "file" : "files"}
                  </span>
                )}
                {finishCount > 0 && (
                  <span className="text-ppp-charcoal-600" title={`${finishCount} finish-schedule code${finishCount === 1 ? "" : "s"} defined`}>
                    <span aria-hidden>🎨</span> {finishCount} {finishCount === 1 ? "finish" : "finishes"}
                  </span>
                )}
                {submittalStats && submittalStats.total > 0 && (
                  <span
                    className={submittalStats.awaiting_response > 0 ? "text-sky-700 font-medium" : "text-ppp-charcoal-600"}
                    title={
                      submittalStats.awaiting_response > 0
                        ? `${submittalStats.awaiting_response} awaiting GC response`
                        : `${submittalStats.total} submittal${submittalStats.total === 1 ? "" : "s"} closed`
                    }
                  >
                    <span aria-hidden>📋</span> {submittalStats.total}
                    {submittalStats.awaiting_response > 0 && (
                      <span className="ml-1 inline-flex items-center px-1 py-0 rounded bg-sky-100 text-sky-800 text-[10px] font-bold uppercase tracking-wider">
                        {submittalStats.awaiting_response} awaiting
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right chevron aligns to first line — group-hover tint. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-300 group-hover/row:text-cc-brand-600 shrink-0 mt-1 transition-colors" aria-hidden>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </Link>

      {/* Tab-jump chips — sibling of the wrapping Link so clicking them
          navigates to the specific tab. Only renders when there's a
          count > 0. */}
      {(finishCount > 0 || (submittalStats && submittalStats.total > 0)) && (
        <div className="px-4 pb-2 -mt-1 flex flex-wrap items-center gap-2">
          {finishCount > 0 && (
            <Link
              href={`/commercial/opportunities/${opportunity.id}?tab=finishes`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cc-brand-800 bg-cc-brand-50 border border-cc-brand-100 hover:bg-cc-brand-100 transition-colors min-h-[28px] touch-manipulation"
            >
              <span aria-hidden>🎨</span>
              <span>{finishCount} {finishCount === 1 ? "finish" : "finishes"} →</span>
            </Link>
          )}
          {submittalStats && submittalStats.total > 0 && (
            <Link
              href={`/commercial/opportunities/${opportunity.id}?tab=submittals`}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors min-h-[28px] touch-manipulation ${
                submittalStats.awaiting_response > 0
                  ? "text-sky-900 bg-sky-50 border-sky-100 hover:bg-sky-100"
                  : "text-ppp-charcoal-700 bg-ppp-charcoal-50 border-ppp-charcoal-100 hover:bg-ppp-charcoal-100/70"
              }`}
            >
              <span aria-hidden>📋</span>
              <span>
                {submittalStats.total} submittal{submittalStats.total === 1 ? "" : "s"}
                {submittalStats.awaiting_response > 0 && (
                  <span className="ml-1 font-semibold">· {submittalStats.awaiting_response} awaiting</span>
                )}
                {" →"}
              </span>
            </Link>
          )}
        </div>
      )}

      {/* Inline status flip — placeholder text carries the meaning
          (Karan 2026-07-08 Batch 2: killed the shouty "QUICK FLIP" label). */}
      {nextStatuses.length > 0 ? (
        <form
          action={quickFlipStatusAction}
          className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap"
        >
          <input type="hidden" name="opp_id" value={opportunity.id} />
          <input type="hidden" name="return_href" value={flipReturnHref} />
          <select
            id={`flip-${opportunity.id}`}
            name="to_status"
            defaultValue=""
            required
            aria-label={`Move ${opportunity.title} to next stage`}
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
            className="px-3 py-1.5 rounded-md bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 min-h-[36px] touch-manipulation"
          >
            Go
          </button>
        </form>
      ) : (
        <p className="px-4 pb-3 -mt-1 text-[11px] text-ppp-charcoal-500">
          <Link
            href={sheetHref(opportunity.account_id, opportunity.id)}
            className="underline hover:text-ppp-charcoal-700"
          >
            Peek to reopen
          </Link>
        </p>
      )}
    </li>
  );
}

function relativeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / MS_PER_DAY);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function decisionChip(iso: string | null): { label: string; tone: "ok" | "soon" | "overdue" } | null {
  if (!iso) return null;
  const target = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
  if (!Number.isFinite(target)) return null;
  const days = Math.ceil((target - Date.now()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "overdue" };
  if (days === 0) return { label: "Due today", tone: "soon" };
  if (days === 1) return { label: "Due tomorrow", tone: "soon" };
  if (days <= 7) return { label: `Due in ${days}d`, tone: "soon" };
  return { label: `Due in ${days}d`, tone: "ok" };
}

function DueChip({ label, tone }: { label: string; tone: "ok" | "soon" | "overdue" }) {
  const cls =
    tone === "overdue"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : tone === "soon"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

function RatingPill({ rating }: { rating: CommercialAccountRating }) {
  const cls =
    rating === "A"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : rating === "B"
      ? "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200"
      : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-bold border ${cls}`}>
      {rating}
    </span>
  );
}

function PrequalPill({ status }: { status: CommercialPrequalStatus }) {
  const map = {
    not_started: { label: "Prequal: —", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-100" },
    pending: { label: "Prequal: pending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    approved: { label: "Prequal: ✓", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    rejected: { label: "Prequal: ✗", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  }[status];
  if (!map) return null;
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${map.cls}`}>
      {map.label}
    </span>
  );
}

function StatusPill({ status }: { status: OpportunityStatus | string }) {
  // Karan 2026-07-09 Phase A.1: CEO status-model correction. Map covers
  // the 8 Pre-Contract values + retired v1.0 values so any un-migrated
  // historic row still tints correctly. Fallback to neutral if a truly
  // unknown status reaches the UI.
  const map: Record<string, string> = {
    solicitation: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    rfp: "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-300",
    estimating: "bg-amber-100 text-amber-900 border-amber-300",
    proposal_pending_approval: "bg-purple-100 text-purple-800 border-purple-300",
    proposal_sent: "bg-orange-100 text-orange-900 border-orange-300",
    follow_up: "bg-cyan-100 text-cyan-800 border-cyan-300",
    won: "bg-emerald-100 text-emerald-800 border-emerald-300",
    lost: "bg-rose-100 text-rose-800 border-rose-300",
    // Retired v1.0 values (fallback for un-migrated rows)
    inquiry: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    negotiating: "bg-orange-100 text-orange-900 border-orange-300",
    on_hold: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    no_bid: "bg-rose-100 text-rose-800 border-rose-300",
    reopened: "bg-cc-brand-100 text-cc-brand-800 border-cc-brand-300",
  };
  const cls = map[status] ?? "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${cls}`}>
      {opportunityStatusLabel(status)}
    </span>
  );
}

/**
 * CustomerQuickSheet — Karan 2026-07-08 rewrite.
 *
 * GoHighLevel-style slide-out sheet, CUSTOMER-scoped (not deal-scoped).
 * Opened by ?customer=<account_uuid> from any pipeline view — customer
 * row's "View" button, kanban card, list row, deal chip. The user's
 * mental model is "look at Suffolk Concrete" not "look at deal #1234";
 * this sheet mirrors that.
 *
 * Contents (top-to-bottom):
 *   1. Header — company name + industry chip + Key badge + [X close]
 *   2. Team — assigned staff members with roles
 *   3. Financials — invoiced / paid / balance tiles + progress bar
 *   4. Invoices — per-invoice rows with status pills (drill-in link)
 *   5. Active deals — inline status-flip for each (focus-highlighted)
 *   6. Closed deals — compact list
 *   7. Footer — big "View account →" CTA (top-right per user ask)
 *
 * URL-driven (no client JS). Backdrop closes by dropping ?customer.
 */
function CustomerQuickSheet({
  account,
  team,
  rollup,
  invoices,
  allDeals,
  focusOppId,
  closeHref,
  flipReturnHref,
}: {
  account: CommercialAccount;
  team: Awaited<ReturnType<typeof listAccountTeam>>;
  rollup: AccountInvoiceRollup;
  invoices: CommercialInvoice[];
  allDeals: CommercialOpportunity[];
  focusOppId: string | null;
  closeHref: string;
  flipReturnHref: string;
}) {
  const openDeals = allDeals.filter((o) => !TERMINAL_STATUSES.has(o.status));
  const closedDeals = allDeals.filter((o) => TERMINAL_STATUSES.has(o.status));
  const paidPct =
    rollup.invoiced_cents > 0
      ? Math.min(100, Math.round((rollup.paid_cents / rollup.invoiced_cents) * 100))
      : 0;
  return (
    <div id="customer-sheet" className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby="customer-sheet-title">
      {/* Backdrop — full-viewport link that closes the sheet. */}
      <Link
        href={closeHref}
        aria-label="Close customer sheet"
        className="absolute inset-0 bg-ppp-charcoal/40 backdrop-blur-[1px]"
      />
      {/* Sheet — right-aligned slide-out. Wider than deal peek (480px)
          because it carries more content: team, financials, invoices,
          deals. Full width on mobile. */}
      <aside className="absolute right-0 top-0 bottom-0 w-full sm:w-[480px] max-w-full bg-white border-l border-ppp-charcoal-200 shadow-2xl flex flex-col overflow-hidden">
        {/* Header — company name + close + right-aligned View Account CTA
            per user's explicit ask ("top right of the sheet it says view
            full account button and brings the user to the account"). */}
        <header className="px-5 py-4 border-b border-ppp-charcoal-100 space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-0.5">
                Customer
              </div>
              <h2 id="customer-sheet-title" className="text-xl font-bold text-ppp-charcoal leading-tight break-words">
                {account.company_name}
              </h2>
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                {account.industry && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200">
                    {account.industry}
                  </span>
                )}
                {account.rating && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200 capitalize">
                    {account.rating.replace(/_/g, " ")}
                  </span>
                )}
                {account.is_key_relationship && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200">
                    <span aria-hidden>★</span> Key
                  </span>
                )}
              </div>
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
          {/* Top-right "View account" CTA — user asked for this in the
              header ("on top right of the sheet there should be a view
              account button"). Full-width for tap-friendly on mobile;
              right-aligned inline on desktop. */}
          <Link
            href={`/commercial/accounts/${account.id}`}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/30 w-full sm:w-auto"
          >
            View full account
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14 M13 5l7 7-7 7" />
            </svg>
          </Link>
        </header>

        {/* Body — scrollable sections */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* ─── Team ─── */}
          <section>
            <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2 flex items-center justify-between">
              <span>Team ({team.length})</span>
              <Link
                href={`/commercial/accounts/${account.id}?tab=overview&sub=team`}
                className="text-[10px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 normal-case tracking-normal"
              >
                Manage →
              </Link>
            </div>
            {team.length === 0 ? (
              <p className="text-[12px] text-ppp-charcoal-500 italic">
                No one assigned yet. Manage from the account page.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {team.map((m) => {
                  const primary = m.assignments.find((a) => a.is_primary) ?? m.assignments[0];
                  return (
                    <li key={m.user_id} className="flex items-center gap-2 text-[12.5px]">
                      <span aria-hidden className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-cc-brand-100 text-cc-brand-800 text-[10px] font-bold uppercase">
                        {(m.user_full_name ?? m.user_email).slice(0, 1)}
                      </span>
                      <span className="font-medium text-ppp-charcoal truncate">
                        {m.user_full_name ?? m.user_email}
                      </span>
                      <span className="text-ppp-charcoal-500 text-[11px] truncate">
                        · {assignmentRoleLabel(primary.role)}
                        {m.assignments.length > 1 && ` +${m.assignments.length - 1}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ─── Financials — invoiced / paid / balance + progress bar ─── */}
          <section>
            <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2">
              Financials
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-ppp-charcoal-100 bg-white px-2.5 py-2">
                <div className="text-[9.5px] text-ppp-charcoal-500 font-medium uppercase tracking-wide">Invoiced</div>
                <div className="text-sm font-bold text-ppp-charcoal mt-0.5">{formatCentsFull(rollup.invoiced_cents)}</div>
              </div>
              <div className="rounded-lg border border-cc-brand-100 bg-cc-brand-50/50 px-2.5 py-2">
                <div className="text-[9.5px] text-cc-brand-800 font-medium uppercase tracking-wide">Paid</div>
                <div className="text-sm font-bold text-cc-brand-800 mt-0.5">{formatCentsFull(rollup.paid_cents)}</div>
              </div>
              <div className={`rounded-lg border px-2.5 py-2 ${rollup.overdue_count > 0 ? "border-rose-200 bg-rose-50/40" : "border-ppp-charcoal-100 bg-white"}`}>
                <div className={`text-[9.5px] font-medium uppercase tracking-wide ${rollup.overdue_count > 0 ? "text-rose-800" : "text-ppp-charcoal-500"}`}>Balance</div>
                <div className={`text-sm font-bold mt-0.5 ${rollup.overdue_count > 0 ? "text-rose-900" : "text-ppp-charcoal"}`}>{formatCentsFull(rollup.balance_cents)}</div>
              </div>
            </div>
            {rollup.invoiced_cents > 0 && (
              <div className="mt-2.5">
                <div className="h-1.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                  <div
                    className={`h-full transition-all ${paidPct === 100 ? "bg-emerald-500" : "bg-cc-brand-500"}`}
                    style={{ width: `${paidPct}%` }}
                    aria-label={`${paidPct}% of invoiced amount paid`}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10.5px] text-ppp-charcoal-500">
                  <span>{paidPct}% collected</span>
                  {rollup.overdue_count > 0 && (
                    <span className="text-rose-700 font-semibold">
                      {rollup.overdue_count} overdue
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* ─── Invoices list — click to full detail ─── */}
          {invoices.length > 0 && (
            <section>
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2 flex items-center justify-between">
                <span>Invoices ({invoices.length})</span>
                <Link
                  href={`/commercial/invoices?account_id=${account.id}`}
                  className="text-[10px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 normal-case tracking-normal"
                >
                  Manage →
                </Link>
              </div>
              <ul className="rounded-lg border border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100 overflow-hidden">
                {invoices.slice(0, 5).map((inv) => {
                  const derived = deriveInvoiceStatus(inv);
                  const toneCls =
                    derived === "paid"
                      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                      : derived === "overdue"
                      ? "bg-rose-50 text-rose-800 border-rose-200"
                      : derived === "void"
                      ? "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200"
                      : "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200";
                  return (
                    <li key={inv.id}>
                      <Link
                        href={`/commercial/invoices/${inv.id}`}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-cc-brand-50/40 transition-colors min-h-[44px] touch-manipulation"
                        title={`Open ${inv.invoice_number}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-mono font-semibold text-ppp-charcoal truncate">
                            {inv.invoice_number}
                          </div>
                          <div className="text-[10.5px] text-ppp-charcoal-500">
                            {inv.due_at ? `Due ${fmtEtDate(inv.due_at)}` : `Created ${fmtEtDate(inv.created_at)}`}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[12.5px] font-bold text-ppp-charcoal">
                            {formatCentsFull(inv.total_cents)}
                          </div>
                          <span className={`inline-flex items-center px-1.5 py-0 rounded text-[9.5px] font-semibold border mt-0.5 ${toneCls}`}>
                            {invoiceStatusLabel(derived)}
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
                {invoices.length > 5 && (
                  <li className="px-3 py-2 text-center">
                    <Link
                      href={`/commercial/invoices?account_id=${account.id}`}
                      className="text-[11.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800"
                    >
                      +{invoices.length - 5} more invoices →
                    </Link>
                  </li>
                )}
              </ul>
            </section>
          )}

          {/* ─── Active deals — inline status-flip on each ─── */}
          {openDeals.length > 0 && (
            <section>
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2">
                Active deals ({openDeals.length})
              </div>
              <ul className="space-y-2">
                {openDeals.map((d) => {
                  const isFocused = d.id === focusOppId;
                  const nextStatuses = allowedNextStatuses(d.status);
                  return (
                    <li
                      key={d.id}
                      className={`rounded-lg border px-3 py-2 ${
                        isFocused ? "border-cc-brand-300 bg-cc-brand-50/40 ring-1 ring-cc-brand-200" : "border-ppp-charcoal-100 bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                            {d.title || "(untitled)"}
                          </div>
                          <div className="text-[11px] text-ppp-charcoal-500 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                            <StatusPill status={d.status} />
                            <span>{formatBidRange(d.bid_value_low_cents, d.bid_value_high_cents)}</span>
                            <span>· {d.probability_pct}%</span>
                          </div>
                        </div>
                      </div>
                      {nextStatuses.length > 0 && (
                        <form action={quickFlipStatusAction} className="mt-2 flex items-center gap-1.5">
                          <input type="hidden" name="opp_id" value={d.id} />
                          <input type="hidden" name="return_href" value={flipReturnHref} />
                          <select
                            name="to_status"
                            defaultValue=""
                            required
                            aria-label={`Move ${d.title} to next stage`}
                            className={`${SELECT_CLS} flex-1 text-base sm:text-xs py-1.5 min-h-[36px]`}
                            style={SELECT_BG_STYLE}
                          >
                            <option value="" disabled>Move to…</option>
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
                            className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[36px] touch-manipulation"
                          >
                            Go
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* ─── Closed deals — compact list. Audit fix 2026-07-08:
              when the sheet is opened from a closed deal chip (?focus
              matches a terminal-status opp), highlight that row so
              users know which one they clicked, matching the active-
              deals section's focused-ring treatment. */}
          {closedDeals.length > 0 && (
            <section>
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2">
                Closed ({closedDeals.length})
              </div>
              <ul className="space-y-1">
                {closedDeals.slice(0, 5).map((d) => {
                  const isFocused = d.id === focusOppId;
                  return (
                    <li
                      key={d.id}
                      className={`flex items-center gap-2 text-[12px] text-ppp-charcoal-700 ${
                        isFocused
                          ? "rounded-md border border-cc-brand-300 bg-cc-brand-50/40 ring-1 ring-cc-brand-200 px-2 py-1"
                          : "px-2 py-0.5"
                      }`}
                    >
                      <StatusPill status={d.status} />
                      <span className="truncate flex-1">{d.title || "(untitled)"}</span>
                      <span className="text-ppp-charcoal-500 shrink-0">
                        {formatBidRange(d.bid_value_low_cents, d.bid_value_high_cents)}
                      </span>
                    </li>
                  );
                })}
                {closedDeals.length > 5 && (
                  <li className="text-[11px] text-ppp-charcoal-500 italic pt-1">
                    +{closedDeals.length - 5} more in account history
                  </li>
                )}
              </ul>
            </section>
          )}

          {/* Empty state — no deals at all */}
          {allDeals.length === 0 && (
            <section className="text-[12px] text-ppp-charcoal-500 italic text-center py-4">
              No deals on this customer yet. Start one from the account page.
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
