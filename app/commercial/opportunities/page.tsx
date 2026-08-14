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
import { dealValueCents } from "@/lib/commercial/opportunities/db";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { redirect } from "next/navigation";
import { PendingFormButton } from "@/components/commercial/pending-form-button";
import { StatusSubStatusPicker } from "@/components/commercial/status-sub-status-picker";
import { FocusTrapAside } from "@/components/commercial/focus-trap-aside";
import { createClient } from "@/lib/supabase/server";
import {
  listCommercialOpportunities,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  oppStatusDisplayLabel,
  opportunitySourceLabel,
  formatBidRange,
  formatOpportunityNumber,
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
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import { pickFirst } from "@/lib/commercial/form-utils";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  OPEN_OPP_STATUSES,
  PRE_SALE_OPEN_STATUSES,
  STALE_OPP_DAYS,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
  HOT_DEAL_ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  IN_DELIVERY_STATUSES,
  isTerminalOpportunityStatus,
  isWon,
  wasWonInPeriod,
  isOverdueProposal,
  isColdRfp,
  isFollowUpDue,
  isPostSaleProject,
  isLost,
  isFollowUp,
  opportunitySubStatusLabel,
  POST_SALE_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  KANBAN_COLUMNS,
  PRE_CONTRACT_COLUMNS,
  POST_CONTRACT_COLUMNS,
  OPEN_COLUMN_KEYS,
  TERMINAL_COLUMN_KEYS,
  columnKeyForOpp,
  columnDbStatusHint,
  kanbanColumnLabel,
  kanbanMoveToLabel,
  resolveColumnTarget,
  isFollowUpCard,
  isDraftedCard,
} from "@/lib/commercial/opportunities/kanban-columns";
import { activeViewKey, filterChips } from "@/lib/commercial/opportunities/saved-views";
import { isUnderContract } from "@/lib/commercial/opportunities/attention";
import { SavedViewPicker } from "@/components/commercial/saved-view-picker";
import { OpportunitySheet, type OppSheetRow } from "@/components/commercial/opportunity-sheet";
import { listCurrentProposalByOpp } from "@/lib/commercial/proposals/db";
import { proposalStatusLabel } from "@/lib/commercial/proposals/constants";
import { nextStep } from "@/lib/commercial/opportunities/attention";
import { NextStepButton } from "@/components/commercial/next-step-button";
import { SubmitButton } from "@/components/commercial/submit-button";
import { proposalTrailsDeal } from "@/lib/commercial/opportunities/auto-advance-targets";
import { daysFromTodayEt, etDateOf, relativeAgoEt, daysAgoEt } from "@/lib/date-et";
import {
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
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import NewDealAccountPicker from "@/components/commercial/new-deal-account-picker";
import { HBars } from "@/components/commercial/charts";
import { DateField } from "@/components/commercial/date-field";
import { AutoOpportunityTitle } from "@/components/commercial/auto-opportunity-title";
import { listTeams } from "@/lib/commercial/teams/db";
import { IconBulb } from "@/components/commercial/inline-icons";

const MS_PER_DAY = 86_400_000;

/** Move-to dropdown mirrors the visual kanban columns exactly — not the
 *  raw status enum — so the option Alex picks names the column he expects
 *  the card to land in. Both the column list and the column→tuple map now
 *  live in lib/commercial/opportunities/kanban-columns.ts (Karan 2026-08
 *  flatten: Qualifying · Request for Proposal · Estimating · Proposal ·
 *  Closed Won · Closed Lost), because they used to be duplicated here, in
 *  the accounts page, and in the drag-and-drop shim — which is how the two
 *  Proposal columns drifted apart.
 *
 *  The old dropdown listed the raw OPPORTUNITY_STATUSES which meant Alex
 *  would see "→ Pre-Sale Closed" and had no way to pick "Won" vs "Lost"
 *  from the menu — the server defaulted to Won, which read to Alex as
 *  "nothing happened" because Won isn't a visual column he was expecting
 *  the card to land in. */
const MOVE_TO_COLUMNS: { key: string; label: string }[] = KANBAN_COLUMNS.map(
  (c) => ({ key: c.key, label: kanbanMoveToLabel(c.key) })
);

/** Which visual column a deal is CURRENTLY sitting in. The Move-to menu
 *  filters on this rather than on quickFlipNextStatuses' REAL statuses:
 *  two columns (Qualifying and Request for Proposal) now share the real
 *  status `qualifying`, so a status-level filter would hide RFP from every
 *  Qualifying deal — i.e. make it unreachable from the menu. Filtering by
 *  column also drops the no-op "move to where you already are" option,
 *  which is what the status-level filter was doing for us before. */
const currentColumnKey = (opp: {
  status: string;
  sub_status?: string | null;
}): string => columnKeyForOpp(opp.status, opp.sub_status ?? null);

/** Move-to options for one card: every column except the one it's already
 *  in. The DAG is flat (Karan 2026-07-16 — every status can reach every
 *  other), so "not where you are" IS the full set of legal moves; the old
 *  `nextStatuses.includes(colRealStatus(key))` filter was computing the
 *  same thing one level too coarse, and after the RFP split it would have
 *  hidden two legal moves: Qualifying → RFP and RFP → Qualifying (both
 *  share the real status `qualifying`). */
const moveToOptionsFor = (opp: {
  status: string;
  sub_status?: string | null;
}): { key: string; label: string }[] => {
  const here = currentColumnKey(opp);
  return MOVE_TO_COLUMNS.filter((col) => col.key !== here);
};

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
  // Karan 2026-08: BLUE↔GREEN account hues only — no purple/magenta/yellow (the
  // old set had 246/276=purple, 308=magenta, 40/24=orange-yellow). Kept in sync
  // with app/commercial/proposals/page.tsx + lib/commercial/account-tone.ts.
  const NICE_HUES = [220, 205, 192, 178, 165, 150, 138];
  const hue = NICE_HUES[h % NICE_HUES.length];
  // Lightness is driven by CSS vars so the per-customer tint flips in dark mode
  // (the inline HSL can't follow a token otherwise — it was a bright pastel
  // island on the dark page). Defaults = light mode; [data-theme="dark"]
  // overrides them in globals.css.
  return {
    border: { borderLeftColor: `hsl(${hue}, var(--cust-border-sat, 55%), var(--cust-border-l, 55%))` },
    headerBg: { backgroundColor: `hsl(${hue}, var(--cust-sat, 62%), var(--cust-bg-l, 96%))` },
    avatar: {
      backgroundColor: `hsl(${hue}, var(--cust-sat, 55%), var(--cust-avatar-l, 88%))`,
      color: `hsl(${hue}, var(--cust-sat, 50%), var(--cust-avatar-tx-l, 28%))`,
    },
    nameText: { color: `hsl(${hue}, var(--cust-sat, 55%), var(--cust-name-l, 32%))` },
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
  await assertCommercialAccess(user.id);
  const opp_id = String(formData.get("opp_id") ?? "");
  const rawToStatus = String(formData.get("to_status") ?? "");
  const rawToSubStatus = String(formData.get("to_sub_status") ?? "").trim();
  // The Move-to dropdown posts VISUAL COLUMN KEYS ("rfp", "proposal",
  // "won", …), not raw statuses — resolveColumnTarget turns each into the
  // (status, sub_status) tuple to write. Every target it returns is
  // whitelisted by SUB_STATUSES_BY_STATUS, so this path can't produce a
  // tuple the DB CHECK rejects. An explicit sub posted alongside the key
  // still wins, for callers that know exactly what they want.
  const columnTarget = resolveColumnTarget(rawToStatus);
  const to_status = columnTarget?.status ?? rawToStatus;
  const to_sub_status: string | undefined =
    rawToSubStatus || columnTarget?.sub_status || undefined;
  const isLostFlip = to_status === "pre_sale_closed" && to_sub_status === "lost";
  const isWonFlip = to_status === "pre_sale_closed" && to_sub_status === "won";
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
    // `to`/`to_sub` are what the page reads; `action` was dead weight from the
    // same invented param the next-step buttons carried. The anchor matters
    // more here than anywhere: this redirect exists to capture a LOSS REASON,
    // and landing at the top of a long page meant the form it came for was
    // off-screen.
    redirect(`/commercial/opportunities/${opp_id}?tab=info&focus=status&to=pre_sale_closed&to_sub=lost#change-status`);
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
    // Karan 2026-07-13: debrief now lives under the account. Look up the
    // deal's account_id and route the Won-drop celebration into the
    // account-scoped debrief page so the user never leaves the account.
    const { getCommercialOpportunity } = await import("@/lib/commercial/opportunities/db");
    const flipped = await getCommercialOpportunity(opp_id);
    if (flipped) {
      redirect(`/commercial/accounts/${flipped.account_id}/debrief/${opp_id}?just_closed=1`);
    }
    redirect(buildFlipReturnHref(returnHref, "status_ok", "1"));
  }
  redirect(buildFlipReturnHref(returnHref, "status_ok", "1"));
}

// Karan 2026-07-08: GHL-style "New opportunity" slide-out on the pipeline page.
// The old "+ New opportunity" button bounced through /commercial/accounts which
// felt like a dead-end because the user hadn't picked one yet. Now the
// button opens a right-side sheet with an account autocomplete + the
// core deal fields; on submit we insert the deal and drop the user into
// the account's Deals tab where the new row is already highlighted.
async function createDealFromPipelineAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const account_id = String(formData.get("account_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const status = String(formData.get("status") ?? "qualifying").trim();
  // Phase E-4: sub_status + follow_up captured on CREATE via the shared
  // picker. isValidSubStatus is enforced server-side in mutations.
  const subStatusRaw = String(formData.get("sub_status") ?? "").trim();
  const followUpAtRaw = String(formData.get("follow_up_at") ?? "").trim();
  const followUpNotesRaw = String(formData.get("follow_up_notes") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  const proposalDueRaw = String(formData.get("proposal_due_at") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // Parity with the account's new-deal action (audit #14).
  const rfpReceivedRaw = String(formData.get("rfp_received_at") ?? "").trim();
  const rfp_received_at =
    rfpReceivedRaw && /^\d{4}-\d{2}-\d{2}$/.test(rfpReceivedRaw) ? rfpReceivedRaw : null;
  const teamRaw = String(formData.get("team_id") ?? "").trim();
  const team_id = teamRaw && UUID_RE.test(teamRaw) ? teamRaw : null;
  const client_name = String(formData.get("client_name") ?? "").trim() || null;
  // Added with Brendan's field order — the form offered these two and the
  // writer silently dropped them, which is worse than not offering them.
  const title_override = String(formData.get("title_override") ?? "").trim().slice(0, 200) || null;
  const estimator_name = String(formData.get("estimator_name") ?? "").trim().slice(0, 120) || null;
  const property_street = String(formData.get("property_street") ?? "").trim() || null;
  const property_city = String(formData.get("property_city") ?? "").trim() || null;
  const property_state = String(formData.get("property_state") ?? "").trim() || null;
  const property_zip = String(formData.get("property_zip") ?? "").trim() || null;

  const backHref = "/commercial/opportunities?new_deal=1#new-deal-sheet";
  if (!UUID_RE.test(account_id)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Pick a GC (account) from the list.")}#new-deal-sheet`);
  }
  if (!title || title.length > 200) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Opportunity name is required (max 200 chars).")}#new-deal-sheet`);
  }
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(status)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Invalid status.")}#new-deal-sheet`);
  }
  if (source && !(OPPORTUNITY_SOURCES as readonly string[]).includes(source)) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Invalid source.")}#new-deal-sheet`);
  }


  // `proposal_due_at` is a DATE column, so it is stored exactly as typed. The
  // noon-ET anchor that used to be here was defending against a timezone race
  // that a DATE cannot have, and it made this the only write path on the
  // platform that put a time into a date field.
  let proposalDueAt: string | null = null;
  if (proposalDueRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proposalDueRaw)) {
      redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent("Proposal due date is malformed.")}#new-deal-sheet`);
    }
    proposalDueAt = proposalDueRaw;
  }

  // Duplicate check, matching the account form. The pipeline path had none, so
  // logging the same RFP from here silently created a second deal — and the two
  // fields it keys on are exactly the two just added above, which is why both
  // halves ship together.
  const forceCreate = String(formData.get("confirm_duplicate") ?? "") === "1";
  if (!forceCreate && client_name && property_street) {
    const { findDuplicateOpportunities } = await import("@/lib/commercial/opportunities/duplicates");
    const dups = await findDuplicateOpportunities({
      accountId: account_id,
      clientName: client_name,
      propertyStreet: property_street,
    });
    if (dups.length > 0) {
      const first = dups[0];
      const label = formatOpportunityNumber(first.project_number) || first.title;
      redirect(
        `/commercial/opportunities?new_deal=1&dup_id=${first.id}&dup_label=${encodeURIComponent(label)}#new-deal-sheet`
      );
    }
  }

  const result = await createCommercialOpportunity({
    account_id,
    title,
    description: description || undefined,
    status: status as OpportunityStatus,
    sub_status: subStatusRaw || null,
    follow_up_at:
      followUpAtRaw && /^\d{4}-\d{2}-\d{2}$/.test(followUpAtRaw)
        ? followUpAtRaw
        : null,
    follow_up_notes: followUpNotesRaw ? followUpNotesRaw.slice(0, 200) : null,
    source: source ? (source as OpportunitySource) : undefined,
    proposal_due_at: proposalDueAt,
    rfp_received_at,
    team_id,
    client_name,
    title_override,
    estimator_name,
    property_street,
    property_city,
    property_state,
    property_zip,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities?new_deal=1&sheet_error=${encodeURIComponent(result.error)}#new-deal-sheet`);
  }
  revalidatePath("/commercial/opportunities");
  revalidatePath(`/commercial/accounts/${account_id}`);
  // B1 (Katie 2026-08, Model B): open the new opportunity's deal drill-in — the
  // one do-everything home — instead of dropping back on the pipeline list where
  // "where do I go next?" was the complaint. deal_created=1 fires the confirm
  // flash + the Overview now shows the bid fields entered. 303 redirect, so Back
  // returns to the pipeline (never a form re-POST).
  redirect(`/commercial/opportunities/${result.opportunity.id}?deal_created=1`);
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
  // Who is looking — only needed for the "My opportunities" view, so it is
  // resolved once here rather than threaded through every row.
  const viewerUserId = await (async () => {
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      return user?.id ?? null;
    } catch {
      return null;
    }
  })();
  const search = pickFirst(sp.q);
  // `?status=` now names a KANBAN COLUMN, not a raw status — that's what
  // the snapshot pills show and what the board is organised by, so a pill
  // labelled "Request for Proposal" has to filter to the same set of cards
  // the RFP column holds. Raw statuses still work (old bookmarks, the
  // reports deep-links) because a real status is either a column key
  // already or resolves to one via columnKeyForOpp.
  const statusFilter = pickFirst(sp.status);
  // Step 10: filter by LANE — everything under contract, or everything still
  // being sold. The dashboard's money tiles ("Under contract", "Left to bill")
  // span won + in-progress + billing, which a single-stage filter cannot
  // express, so they used to link at the retired Projects page instead.
  // "My opportunities" and "New this week" — the two views on Karan's actual
  // Salesforce screenshot. Both are filters the list did not have.
  const mineFilter = pickFirst(sp.mine) === "1";
  // Deep link from the Estimator report — "show me Kim's bids" is the obvious
  // next click from that table, and without this the link would have been a
  // dead param landing on an unfiltered pipeline.
  const estimatorFilter = pickFirst(sp.estimator) ?? null;
  const newFilter = pickFirst(sp.new) === "7d" ? 7 : undefined;
  const laneRaw = pickFirst(sp.lane);
  const laneFilter =
    laneRaw === "under_contract" || laneRaw === "pre_contract" ? laneRaw : undefined;
  const validColumn = statusFilter
    ? (KANBAN_COLUMNS.some((c) => c.key === statusFilter)
        ? statusFilter
        : (OPPORTUNITY_STATUSES as readonly string[]).includes(statusFilter)
          ? columnKeyForOpp(statusFilter, null)
          : undefined)
    : undefined;
  // Phase G Q3 (2026-07-20): `?archived=1` toggle to include archived
  // opps in the active list/kanban. Default hides them so the pipeline
  // stays focused on live deals. Chip in the toolbar flips the URL.
  const includeArchived = pickFirst(sp.archived) === "1";
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
  // Dashboard "Needs attention" deep-links (2026-07-21). Each mirrors the
  // exact subset that dashboard card counts, so a tap lands on precisely
  // those opportunities. Added to baseParams below so they auto-preserve
  // across every sort/filter interaction.
  const overdueFilter = pickFirst(sp.overdue) === "1";
  const coldRfpFilter = pickFirst(sp.coldrfp) === "1";
  const followupFilter = pickFirst(sp.followup) === "1";
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
  // Step 8: KANBAN IS RETIRED. Dragging a card between columns is manual status
  // entry, and status advances on its own now from what has actually been built
  // and sent (auto-advance, 2026-08-11) — so the board offered a second way to
  // set a value the engine already owns, and the engine wins on the next render.
  // A stale ?view=kanban link lands on the list rather than 404ing.
  // Karan 2026-08-14: "sheet" = a dense Salesforce-style table (just the titles
  // + columns). By-customer and list stay; sheet is the third, scan-everything view.
  const viewMode: "list" | "customer" | "sheet" =
    viewRaw === "customer" ? "customer" : viewRaw === "sheet" ? "sheet" : "list";

  const SORT_OPTIONS = [
    { key: "recent", label: "Most recently updated" },
    { key: "oldest", label: "Oldest / stuck opportunities" },
    { key: "bid_high", label: "Highest bid first" },
    { key: "due_soon", label: "Proposal due soonest" },
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

  // Karan 2026-07-15: self-heal any deal↔proposal drift on load. If a
  // proposal state was changed before the auto-cascade shipped (or via
  // a code path that skipped the cascade), the parent deal could sit
  // in a stale column. Reconcile scans + fixes those in one pass so
  // both surfaces always show the same state.
  const { reconcileDealStatesFromProposals } = await import(
    "@/lib/commercial/proposals/db"
  );
  await reconcileDealStatesFromProposals().catch((err) => {
    console.warn("[opportunities-page] reconcile failed:", err);
  });

  // Two-step filter: narrow in the query where the column maps to a single
  // status (cheap), then match exactly on the column in memory. The second
  // step is the one that's actually correct — Qualifying and Request for
  // Proposal share the real status `qualifying`, and Proposal spans two
  // statuses, so no single .eq() expresses either column on its own.
  const [oppsUnfiltered, accounts] = await Promise.all([
    listCommercialOpportunities({
      search,
      // Cast is safe: columnDbStatusHint only ever returns a status from
      // COLUMN_TARGET, all of which are real OpportunityStatus members.
      status: ((validColumn ? columnDbStatusHint(validColumn) : null) ??
        undefined) as OpportunityStatus | undefined,
      includeArchived,
    }),
    listCommercialAccounts(),
  ]);
  const oppsRaw = validColumn
    ? oppsUnfiltered.filter(
        (o) => columnKeyForOpp(o.status, o.sub_status) === validColumn
      )
    : oppsUnfiltered;
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
  // Current proposal total per deal — the fallback the $ KPIs use when a deal
  // has no bid range. Since the meeting removed Bid low/high from the create
  // forms, every NEW deal has none, and weighted pipeline / bid range / the
  // stage funnel were all counting those deals as zero.
  const currentProposalByOpp = await listCurrentProposalByOpp(oppIds);
  const proposalTotalByOpp = new Map(
    Array.from(currentProposalByOpp, ([id, p]) => [id, p.totalCents] as const)
  );
  // For the New-opportunity sheet (audit #14 — it had drifted behind the
  // account's form). Cheap, and only this page renders that sheet.
  const allTeams = await listTeams();
  const todayEtIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const oppValue = (o: CommercialOpportunity) =>
    weightedPipelineCents(o, proposalTotalByOpp.get(o.id));

  let opps = oppsRaw;
  if (staleFilter) {
    opps = opps.filter((o) => {
      if (!(OPEN_OPP_STATUSES as readonly string[]).includes(o.status)) return false;
      const d = etDateOf(o.updated_at);
      return d !== null && -daysFromTodayEt(d) >= STALE_OPP_DAYS;
    });
  }
  if (hotFilter) {
    opps = opps.filter((o) => {
      if (!(HOT_DEAL_ACTIVE_STATUSES as readonly string[]).includes(o.status)) return false;
      if (!o.bid_value_high_cents || o.bid_value_high_cents < HOT_DEAL_BID_CENTS) return false;
      if (!o.proposal_due_at) return false;
      const daysUntilDue = daysFromTodayEt(o.proposal_due_at);
      return daysUntilDue >= 0 && daysUntilDue <= HOT_DEAL_DECISION_DAYS;
    });
  }
  // Dashboard "Needs attention" deep-link filters — mirror the exact
  // subset logic on app/commercial/page.tsx so the pipeline count matches
  // the card the user clicked.
  // Shared predicates (see constants) so the pipeline list matches the
  // dashboard card that linked here — these had drifted on BOTH the status set
  // and the date comparison, so "3 overdue" could open a list of 4.
  const attentionToday = todayEtIso; // computed above, ET calendar day
  if (mineFilter && viewerUserId) {
    opps = opps.filter((o) => o.estimator_user_id === viewerUserId);
  }
  if (estimatorFilter) {
    opps = opps.filter((o) => o.estimator_user_id === estimatorFilter);
  }
  if (newFilter) {
    // Calendar days in ET, matching every other elapsed-time figure on the
    // platform — subtracting timestamps miscounts across the DST change.
    const cutoff = new Date(Date.UTC(+todayEtIso.slice(0, 4), +todayEtIso.slice(5, 7) - 1, +todayEtIso.slice(8, 10)) - newFilter * 86_400_000)
      .toISOString()
      .slice(0, 10);
    opps = opps.filter((o) => (o.created_at ?? "").slice(0, 10) >= cutoff);
  }
  if (laneFilter === "under_contract") {
    // The SAME predicate the dashboard's money tiles count, so the tile and the
    // list it opens describe one set. Filtering by the post-contract kanban lane
    // instead dropped won-not-started and added completed jobs — the tile
    // counted rows the list omitted, and vice versa.
    opps = opps.filter((o) => isUnderContract(o.status, o.sub_status));
  } else if (laneFilter === "pre_contract") {
    const laneKeys = new Set(PRE_CONTRACT_COLUMNS.map((c) => c.key));
    opps = opps.filter((o) => laneKeys.has(columnKeyForOpp(o.status, o.sub_status)));
  }
  if (overdueFilter) opps = opps.filter((o) => isOverdueProposal(o, attentionToday));
  if (coldRfpFilter) opps = opps.filter((o) => isColdRfp(o, attentionToday));
  if (followupFilter) opps = opps.filter((o) => isFollowUpDue(o, attentionToday));
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
    return stableTie(a, b);
  });

  // `openOpps` (broad — includes post-sale delivery) drives the per-status
  // snapshot pills below. The pipeline KPIs (count / weighted $ / bid range)
  // MUST use the pre-sale-only set so they match the dashboard — including
  // post-sale here double-counted contract dollars already under the "Under
  // contract" strip (2026-07-29 re-audit: same metric showed two numbers).
  // ── Saved view + header totals (step 7) ─────────────────────────────────
  //
  // The count and the sum are taken from `opps` — the SAME array the rows
  // render from — so the header can never disagree with what is on screen.
  // Deriving them from a second query is how a list ends up claiming 23 items
  // above a table showing 19.
  //
  // And a true count, where Salesforce prints "50+". A capped count on a list
  // of money is the kind of small lie that costs somebody an afternoon.
  const viewParams: Record<string, string | undefined> = {
    q: search || undefined,
    status: statusFilter || undefined,
    lane: laneFilter || undefined,
    mine: mineFilter ? "1" : undefined,
    new: newFilter ? "7d" : undefined,
    sources: sourcesRaw || undefined,
    sort: sortRaw || undefined,
    view: viewRaw || undefined,
    hot: hotFilter ? "1" : undefined,
    stale: staleFilter ? "1" : undefined,
    overdue: overdueFilter ? "1" : undefined,
    coldrfp: coldRfpFilter ? "1" : undefined,
    followup: followupFilter ? "1" : undefined,
    archived: includeArchived ? "1" : undefined,
  };
  const activeSavedView = activeViewKey(viewParams);
  const savedViewCount = opps.length;
  const savedViewTotalCents = opps.reduce(
    (acc, o) => acc + dealValueCents(o, proposalTotalByOpp.get(o.id) ?? null),
    0
  );
  // Only claim a total when there is one. "$0" across a filtered list reads as
  // "these are worth nothing" rather than "none of these are priced yet".
  const savedViewTotal = savedViewTotalCents > 0 ? formatCentsCompact(savedViewTotalCents) : null;
  const viewChips = filterChips(viewParams, (k) => kanbanColumnLabel(k) || k);

  const openOpps = opps.filter((o) => (OPEN_OPP_STATUSES as readonly string[]).includes(o.status));
  const presaleOpenOpps = opps.filter((o) => PRE_SALE_OPEN_STATUSES.includes(o.status));
  const totalPipelineCents = presaleOpenOpps.reduce((acc, o) => acc + oppValue(o), 0);
  const totalBidLowCents = presaleOpenOpps.reduce((acc, o) => acc + (o.bid_value_low_cents ?? 0), 0);
  const totalBidHighCents = presaleOpenOpps.reduce((acc, o) => acc + (o.bid_value_high_cents ?? 0), 0);
  // L1: the bid columns are no longer collected on create — pricing lives on
  // the proposal — so this summed to zero and read "—" beside a Weighted tile
  // showing live money from the proposal fallback, on the same screen.
  const totalOpenValueCents = presaleOpenOpps.reduce(
    (acc, o) => acc + dealValueCents(o, proposalTotalByOpp.get(o.id) ?? null),
    0
  );
  // Pipeline value by stage (weighted $) — a funnel of where open deals sit.
  // Bucketed by KANBAN COLUMN, not raw status, so this funnel names the same
  // stages the board does. Bucketing by status put every priced-but-unsent
  // deal under "Estimating" while its card sat in the Proposal column, and
  // after the RFP split would have hidden Request for Proposal entirely.
  const stageBars = PRE_CONTRACT_COLUMNS.filter((c) =>
    OPEN_COLUMN_KEYS.includes(c.key)
  )
    .map((col) => {
      const inStage = presaleOpenOpps.filter(
        (o) => columnKeyForOpp(o.status, o.sub_status) === col.key
      );
      const weighted = inStage.reduce((a, o) => a + oppValue(o), 0);
      return {
        label: col.label,
        value: weighted,
        tone: "blue" as const,
        valueLabel: formatCentsCompact(weighted),
        sub: `${inStage.length} opportunit${inStage.length === 1 ? "y" : "ies"}`,
      };
    })
    .filter((s) => s.value > 0 || s.sub !== "0 opportunities");
  // Wins this month — mirrors the /commercial dashboard KPI so the two
  // surfaces agree. Uses UTC-month-start; close enough for exec-review
  // "how'd we do this month" scan.
  // decided_at is a DATE column ("2026-07-01"). 2026-07-28 re-audit: comparing
  // it against a full-timestamp month start (…T04:00:00Z) is a string compare
  // where the date-only value is a prefix, so a win on the 1st ("2026-07-01" >=
  // "2026-07-01T…" → false) was dropped every month. Compare date-only in ET.
  const monthStartParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const monthStartDate = `${monthStartParts.find((p) => p.type === "year")?.value}-${monthStartParts.find((p) => p.type === "month")?.value}-01`;
  // Same rule as the dashboard (wasWonInPeriod) — these two disagreed.
  const wonThisMonth = oppsRaw.filter((o) => wasWonInPeriod(o, monthStartDate)).length;

  // URL builders — behavior unchanged from prior file.
  const baseParams = new URLSearchParams();
  if (search) baseParams.set("q", search);
  if (validColumn) baseParams.set("status", validColumn);
  if (sourceSet.size > 0) baseParams.set("sources", Array.from(sourceSet).join(","));
  if (sortKey !== "recent") baseParams.set("sort", sortKey);
  if (viewMode === "list") baseParams.set("view", "list");
  else if (viewMode === "customer") baseParams.set("view", "customer");
  else if (viewMode === "sheet") baseParams.set("view", "sheet");
  // Attention deep-link filters live in baseParams so every builder that
  // clones it preserves them automatically (unlike stale/hot/archived,
  // which have toggle builders and are re-added manually). setSortHref +
  // clearFilterHref build fresh params, so they re-add these explicitly.
  if (overdueFilter) baseParams.set("overdue", "1");
  if (coldRfpFilter) baseParams.set("coldrfp", "1");
  if (followupFilter) baseParams.set("followup", "1");
  // mine / estimator / new / lane live in baseParams for the SAME reason — they
  // were parsed and applied to the list but never carried through the toolbar,
  // so changing sort or view on a "My deals" / "New this week" / lane / a
  // specific-estimator view silently reverted to the WHOLE pipeline, and the
  // CSV export produced the unfiltered set (audit D4).
  if (mineFilter) baseParams.set("mine", "1");
  if (estimatorFilter) baseParams.set("estimator", estimatorFilter);
  if (newFilter) baseParams.set("new", "7d");
  if (laneFilter) baseParams.set("lane", laneFilter);

  // 2026-07-21 audit #5: EVERY href builder below must preserve `stale`,
  // `hot`, AND `archived` — an earlier pass only wired the four toggle
  // builders, so sort/clear/drill/source/customer/export silently dropped
  // `archived` (export even produced the wrong dataset). All builders now
  // re-add all three sticky filters.
  const viewToggleHref = (target: "list" | "customer" | "sheet") => {
    const p = new URLSearchParams(baseParams);
    p.delete("view");
    p.set("view", target);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const toggleStaleHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const toggleHotHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!hotFilter) p.set("hot", "1");
    if (staleFilter) p.set("stale", "1");
    if (includeArchived) p.set("archived", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  // Phase G Q3: toggle URL for the archived-inclusion chip.
  const toggleArchivedHref = (() => {
    const p = new URLSearchParams(baseParams);
    if (!includeArchived) p.set("archived", "1");
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  })();
  const archivedCount = oppsRaw.filter((o) => o.archived_at).length;
  const toggleSourceHref = (src: OpportunitySource) => {
    const p = new URLSearchParams(baseParams);
    const next = new Set(sourceSet);
    if (next.has(src)) next.delete(src);
    else next.add(src);
    if (next.size > 0) p.set("sources", Array.from(next).join(","));
    else p.delete("sources");
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const setSortHref = (newSort: string): string => {
    const p = new URLSearchParams();
    if (search) p.set("q", search);
    if (validColumn) p.set("status", validColumn);
    if (sourceSet.size > 0) p.set("sources", Array.from(sourceSet).join(","));
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
    if (overdueFilter) p.set("overdue", "1");
    if (coldRfpFilter) p.set("coldrfp", "1");
    if (followupFilter) p.set("followup", "1");
    // mine / estimator / new / lane — this builder makes fresh params, so it
    // must re-add them or a sort change drops the filter (audit D4).
    if (mineFilter) p.set("mine", "1");
    if (estimatorFilter) p.set("estimator", estimatorFilter);
    if (newFilter) p.set("new", "7d");
    if (laneFilter) p.set("lane", laneFilter);
    // 2026-07-21 audit #5: preserve kanban too — was list-only, so a
    // kanban user changing sort got kicked back to list view.
    if (viewMode === "list") p.set("view", "list");
    else if (viewMode === "customer") p.set("view", "customer");
    else if (viewMode === "sheet") p.set("view", "sheet");
    if (newSort !== "recent") p.set("sort", newSort);
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const clearFilterHref = (drop: "q" | "status" | "hot" | "stale" | "sources"): string => {
    const p = new URLSearchParams();
    if (search && drop !== "q") p.set("q", search);
    if (validColumn && drop !== "status") p.set("status", validColumn);
    if (hotFilter && drop !== "hot") p.set("hot", "1");
    if (staleFilter && drop !== "stale") p.set("stale", "1");
    if (sourceSet.size > 0 && drop !== "sources") p.set("sources", Array.from(sourceSet).join(","));
    if (sortKey !== "recent") p.set("sort", sortKey);
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
    if (overdueFilter) p.set("overdue", "1");
    if (coldRfpFilter) p.set("coldrfp", "1");
    if (followupFilter) p.set("followup", "1");
    // Fresh params — re-add mine/estimator/new/lane so clearing ONE chip keeps
    // the rest (audit D4). `drop` never targets these four.
    if (mineFilter) p.set("mine", "1");
    if (estimatorFilter) p.set("estimator", estimatorFilter);
    if (newFilter) p.set("new", "7d");
    if (laneFilter) p.set("lane", laneFilter);
    if (viewMode === "list") p.set("view", "list");
    else if (viewMode === "customer") p.set("view", "customer");
    else if (viewMode === "sheet") p.set("view", "sheet");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  const exportParams = new URLSearchParams(baseParams);
  if (staleFilter) exportParams.set("stale", "1");
  if (hotFilter) exportParams.set("hot", "1");
  // 2026-07-21 audit #5 (data-correctness): the export must match the
  // filtered/visible set. Without this, a user viewing archived deals
  // exported the ACTIVE set instead — a silent wrong-data export.
  if (includeArchived) exportParams.set("archived", "1");
  const exportHref = `/api/commercial/opportunities/export${exportParams.toString() ? `?${exportParams.toString()}` : ""}`;

  const anyFilterActive =
    !!search || !!validColumn || staleFilter || hotFilter || sourceSet.size > 0 ||
    overdueFilter || coldRfpFilter || followupFilter ||
    mineFilter || !!estimatorFilter || !!newFilter || !!laneFilter;
  const sortChanged = sortKey !== "recent";
  const activeFilterCount =
    (search ? 1 : 0) + (validColumn ? 1 : 0) +
    (hotFilter ? 1 : 0) + (staleFilter ? 1 : 0) + sourceSet.size +
    (overdueFilter ? 1 : 0) + (coldRfpFilter ? 1 : 0) + (followupFilter ? 1 : 0) +
    // mine/estimator/new/lane count toward "Filters (N)" too — they were applied
    // but uncounted, so the badge under-reported the active filters (audit D4).
    (mineFilter ? 1 : 0) + (estimatorFilter ? 1 : 0) + (newFilter ? 1 : 0) + (laneFilter ? 1 : 0);
  // Clear a single attention deep-link filter. baseParams carries the
  // OTHER two attention filters (they live there), but NOT stale/hot/
  // archived — those must be re-added manually like every sibling builder,
  // or clearing an attention chip would silently drop them too.
  const clearAttentionHref = (which: "overdue" | "coldrfp" | "followup"): string => {
    const p = new URLSearchParams(baseParams);
    p.delete(which);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1");
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };
  const currentSortLabel = SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recently updated";

  // Snapshot pills — one per OPEN kanban column, in board order, counted the
  // same way the board buckets. Previously keyed off raw statuses, so the
  // pill count and the column card-count could disagree for the same deal.
  const statusSnapshot: Array<{ status: string; label: string; count: number }> =
    OPEN_COLUMN_KEYS.map((key) => ({
      status: key,
      label: kanbanColumnLabel(key),
      count: openOpps.filter(
        (o) => columnKeyForOpp(o.status, o.sub_status) === key
      ).length,
    })).filter((r) => r.count > 0);

  const statusDrillHref = (s: string) => {
    const p = new URLSearchParams(baseParams);
    if (validColumn === s) {
      p.delete("status");
    } else {
      p.set("status", s);
    }
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
    const qs = p.toString();
    return qs ? `/commercial/opportunities?${qs}` : "/commercial/opportunities";
  };

  // Karan 2026-07-08 rewrite: customer-sheet URL builders.
  //   customerSheetHref(accountId, focusOppId?) — open the sheet
  //   customerSheetCloseHref — drop ?customer= and ?focus=
  // U1 (Katie #5-7, 2026-08): clicking an OPPORTUNITY name/card anywhere in the
  // pipeline — list, kanban, or by-customer — opens that deal's full drill-in (the
  // one do-everything home under the account), NOT an in-page peek. When called
  // with just an account id (no opp focus), it still opens the customer slide-out.
  // Every opp-name link across the three views threads through here, so this one
  // branch repoints all of them consistently. `focus` is always an opp id at the
  // opp call sites; the account-only header link passes none.
  const customerSheetHref = (accountId: string, focus?: string): string => {
    if (focus) return `/commercial/opportunities/${focus}`;
    const p = new URLSearchParams(baseParams);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
    p.set("customer", accountId);
    return `/commercial/opportunities?${p.toString()}#customer-sheet`;
  };
  const customerSheetCloseHref: string = (() => {
    const p = new URLSearchParams(baseParams);
    if (staleFilter) p.set("stale", "1");
    if (hotFilter) p.set("hot", "1");
    if (includeArchived) p.set("archived", "1"); // 2026-07-21 audit #5
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
          {/* The saved view IS the page identity (step 7) — you open
              "Proposals out", not "Pipeline, filtered". The status line under
              it carries a TRUE count and the summed value, so a filtered list
              never feels like it is hiding something. */}
          <SavedViewPicker
            activeKey={activeSavedView}
            current={viewParams}
            totalCount={savedViewCount}
            totalLabel={savedViewTotal}
            sortLabel={SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "Most recently updated"}
            chips={viewChips}
          />
          <Link
            href="?new_deal=1#new-deal-sheet"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors touch-manipulation shadow-sm shadow-cc-brand-600/30 min-h-[44px] shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14 M5 12h14" />
            </svg>
            New opportunity
          </Link>
        </div>

        {/* KPI strip. Red primary = Open opps count. Blue supporting =
            Weighted pipeline + Wins this month. Neutral = bid range. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            tone="neutral"
            label="Open opportunities"
            value={presaleOpenOpps.length.toString()}
            sub={`${opps.length - presaleOpenOpps.length} closed or in delivery`}
          />
          <KpiCard
            tone="blue"
            label="Weighted pipeline"
            value={formatCentsCompact(totalPipelineCents)}
            sub="Σ value × stage odds"
          />
          <KpiCard
            tone="neutral"
            label={totalBidLowCents === 0 && totalBidHighCents === 0 ? "Open value" : "Bid range (open)"}
            value={
              totalBidLowCents === 0 && totalBidHighCents === 0
                ? totalOpenValueCents > 0
                  ? formatCentsCompact(totalOpenValueCents)
                  : "—"
                : `${formatCentsCompact(totalBidLowCents)}–${formatCentsCompact(totalBidHighCents)}`
            }
            sub="low + high across open opportunities"
          />
          <KpiCard
            tone="emerald"
            label="Wins this month"
            value={wonThisMonth.toString()}
            sub={wonThisMonth === 0 ? "no closes yet" : "and counting"}
          />
        </div>

        {/* Pipeline by stage — weighted $ per stage, a funnel of where open deals
            sit (only when there are open deals). */}
        {presaleOpenOpps.length > 0 && stageBars.length > 0 && (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 mt-3">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-[13px] font-bold text-ppp-charcoal">Pipeline by stage</h2>
              <span className="text-[10px] text-ppp-charcoal-400 uppercase tracking-wider">weighted $</span>
            </div>
            <HBars items={stageBars} />
          </div>
        )}
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
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
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
              className="w-full pl-10 pr-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]"
            />
          </div>
          {validColumn && <input type="hidden" name="status" value={validColumn} />}
          {viewMode === "list" && <input type="hidden" name="view" value="list" />}
          {hotFilter && <input type="hidden" name="hot" value="1" />}
          {staleFilter && <input type="hidden" name="stale" value="1" />}
          {sourceSet.size > 0 && (
            <input type="hidden" name="sources" value={Array.from(sourceSet).join(",")} />
          )}
          {sortKey !== "recent" && <input type="hidden" name="sort" value={sortKey} />}

          {/* View toggle — segmented control. Customer-first is the
              default (Karan 2026-07-08 Batch 1c). Kanban + List remain
              as opt-in alternate views for deal-first workflows. */}
          <div className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-surface overflow-hidden shrink-0">
            <Link
              href={viewToggleHref("customer")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation ${
                viewMode === "customer"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="By customer — one card per account with all their opportunities + money summary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 21h18 M6 21V7l6-4 6 4v14 M10 9h4 M10 13h4 M10 17h4" />
              </svg>
              By customer
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
            <Link
              href={viewToggleHref("sheet")}
              className={`px-3 py-2 text-[12px] font-semibold min-h-[44px] inline-flex items-center gap-1.5 touch-manipulation border-l border-ppp-charcoal-200 ${
                viewMode === "sheet"
                  ? "bg-cc-brand-50 text-cc-brand-700"
                  : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
              }`}
              title="Sheet — a dense spreadsheet of every opportunity: title, account, status, source, value, owner"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="1" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              Sheet
            </Link>
          </div>

          {/* Filter popover — hot / stale / source multi-select all live
              here. Native <details> for zero-JS state. */}
          <details className="relative inline-block group">
            <summary
              className={`list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border text-[13px] font-semibold min-h-[44px] touch-manipulation transition-colors ${
                activeFilterCount > 0
                  ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-700 hover:bg-cc-brand-100"
                  : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
              <span>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 sm:right-auto mt-2 z-30 bg-surface border border-ppp-charcoal-200 rounded-xl shadow-xl p-3 min-w-[320px] max-w-[calc(100vw-1rem)] max-h-[75vh] overflow-y-auto space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-ppp-charcoal-500 px-3 mb-1">
                  Priority
                </div>
                <div className="space-y-1">
                  <FilterOption
                    href={toggleHotHref}
                    active={hotFilter}
                    label={`Hot ($50k+ · <${HOT_DEAL_DECISION_DAYS}d)`}
                    description={`Bid ≥ $50k, proposal due within ${HOT_DEAL_DECISION_DAYS} days, still in play.`}
                  />
                  <FilterOption
                    href={toggleStaleHref}
                    active={staleFilter}
                    label={`Stale > ${STALE_OPP_DAYS}d`}
                    description={`Open opps with no update in over ${STALE_OPP_DAYS} days.`}
                  />
                  <FilterOption
                    href={toggleArchivedHref}
                    active={includeArchived}
                    label={
                      includeArchived && archivedCount > 0
                        ? `Include archived (${archivedCount})`
                        : "Include archived"
                    }
                    description="Archived opportunities are hidden from the active pipeline. Toggle to include them, marked with a small chip."
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
                      description="How this opportunity came in."
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
                  : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18 M7 12h10 M11 18h2" />
              </svg>
              <span className="hidden sm:inline">Sort:&nbsp;</span>
              <span className="max-w-[140px] truncate">{currentSortLabel}</span>
              <span aria-hidden className="text-ppp-charcoal-400 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="absolute right-0 mt-2 z-30 bg-surface border border-ppp-charcoal-200 rounded-xl shadow-xl p-2 min-w-[260px] max-w-[calc(100vw-1rem)]">
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
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-[12px] font-semibold hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
            title="Download the current filter view as CSV"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" />
            </svg>
            Export
          </a>

          {anyFilterActive && (
            <Link
              // Preserve view mode when clearing filters — dropping filters must
              // not yank a Kanban or By-customer user back to the List default (#18).
              href={`/commercial/opportunities?view=${viewMode}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 text-[12px] font-medium hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation shrink-0"
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
            {validColumn && <ActiveFilterChip href={clearFilterHref("status")} label={`Stage: ${kanbanColumnLabel(validColumn)}`} />}
            {hotFilter && <ActiveFilterChip href={clearFilterHref("hot")} label="Hot" />}
            {staleFilter && <ActiveFilterChip href={clearFilterHref("stale")} label={`Stale > ${STALE_OPP_DAYS}d`} />}
            {overdueFilter && <ActiveFilterChip href={clearAttentionHref("overdue")} label="Overdue proposals" />}
            {coldRfpFilter && <ActiveFilterChip href={clearAttentionHref("coldrfp")} label="Cold RFPs > 7d" />}
            {followupFilter && <ActiveFilterChip href={clearAttentionHref("followup")} label="Follow-ups due" />}
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
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3">
          <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-2 flex items-center justify-between">
            <span>Open by stage</span>
            <span className="font-normal text-ppp-charcoal-400 normal-case tracking-normal text-[10px]">
              {validColumn ? "Tap active pill to clear" : "Tap to filter"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {statusSnapshot.map((r) => {
              const isActive = validColumn === r.status;
              return (
                <Link
                  key={r.status}
                  href={statusDrillHref(r.status)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border min-h-[44px] sm:min-h-[36px] touch-manipulation transition-colors ${
                    isActive
                      ? "bg-cc-brand-600 border-cc-brand-700 text-white"
                      : "bg-surface border-ppp-charcoal-100 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                  }`}
                  title={isActive ? `Showing only ${r.label} — tap to clear` : `Filter to ${r.label}`}
                >
                  <span>{r.label}</span>
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
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-12 text-center">
          <div aria-hidden className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-ppp-charcoal-50 text-ppp-charcoal-400 mb-4">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="6" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-ppp-charcoal">
            {anyFilterActive ? "No opportunities match these filters" : "No opportunities yet"}
          </div>
          <p className="mt-1 text-sm text-ppp-charcoal-500">
            {anyFilterActive
              ? "Try clearing a filter or use search to find a specific bid."
              : "Log the first commercial opportunity to get started."}
          </p>
          {!anyFilterActive ? (
            <Link
              href="?new_deal=1#new-deal-sheet"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 min-h-[44px] shadow-sm shadow-cc-brand-600/30"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14 M5 12h14" />
              </svg>
              New opportunity
            </Link>
          ) : (
            <Link
              href="/commercial/opportunities"
              className="inline-flex items-center justify-center gap-1.5 mt-5 px-4 py-2.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Clear all filters
            </Link>
          )}
        </div>
      ) : viewMode === "sheet" ? (
        <OpportunitySheet
          rows={opps.map((o): OppSheetRow => {
            const acct = accountById.get(o.account_id) ?? null;
            const accountName = acct?.company_name ?? "—";
            const lead = primaryLeadMap.get(o.id) ?? null;
            const enteredAt = statusEnteredAtMap.get(o.id) ?? null;
            const ageDays = enteredAt ? daysAgoEt(enteredAt) : null;
            const valueCents = dealValueCents(o, proposalTotalByOpp.get(o.id) ?? null);
            const tone: OppSheetRow["statusTone"] =
              o.status === "pre_sale_closed"
                ? o.sub_status === "won"
                  ? "won"
                  : "lost"
                : (POST_SALE_STATUSES as readonly string[]).includes(o.status)
                ? "delivery"
                : "pre";
            return {
              id: o.id,
              href: `/commercial/opportunities/${o.id}`,
              title: derivedOppName(o, accountName) || o.title || "(untitled)",
              account: accountName,
              status: oppStatusDisplayLabel(o.status, o.sub_status),
              statusTone: tone,
              source: o.source ? opportunitySourceLabel(o.source) : "—",
              value: valueCents > 0 ? formatCentsCompact(valueCents) : "—",
              owner: lead?.user_full_name ?? lead?.user_email ?? "—",
              age: ageDays !== null ? `${ageDays}d` : "—",
            };
          })}
        />
      ) : viewMode === "customer" ? (
        <CustomerBoard
          opps={opps}
          accountById={accountById}
          proposalTotalByOpp={proposalTotalByOpp}
          sheetHref={customerSheetHref}
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
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-ppp-charcoal">
                    {opps.length} opportunit{opps.length === 1 ? "y" : "ies"} · {groups.length} customer{groups.length === 1 ? "" : "s"}
                  </h2>
                  <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                    Sorted by {currentSortLabel.toLowerCase()}. Same-customer opportunities are grouped.
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
                    className="bg-surface border border-ppp-charcoal-200 rounded-xl shadow-sm overflow-hidden border-l-4"
                    style={tone.border}
                  >
                    {/* Karan 2026-07-15 (round 6): each account is a
                        collapsible <details> so users can hide
                        customers they aren't working on, saving
                        vertical space. First 3 accounts open by
                        default; rest closed. */}
                    <details open className="group/acct">
                    {g.account && (
                      <summary
                        className="cursor-pointer px-4 py-3 flex items-center justify-between gap-3 border-b border-ppp-charcoal-100 list-none [&::-webkit-details-marker]:hidden hover:brightness-95"
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
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block -mt-0.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg> Key
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ppp-charcoal-600 bg-surface border border-ppp-charcoal-200 rounded-full px-2 py-0.5 tabular-nums">
                            {g.opps.length} opportunit{g.opps.length === 1 ? "y" : "ies"}
                          </span>
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
                            className="text-ppp-charcoal-400 transition-transform group-open/acct:rotate-180"
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </div>
                      </summary>
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
                          currentProposal={currentProposalByOpp.get(o.id) ?? null}
                          hideAccount={g.account !== null}
                        />
                      ))}
                    </ul>
                    </details>
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

      {/* Karan 2026-07-08: GHL-style right-side "New opportunity" slide-out.
          Backdrop <Link> closes without a click handler (works with JS
          off too). Account picker is a text input backed by a <datalist>
          of live accounts so the user can type the customer name or
          scroll — the underlying value is the account_id we submit. */}
      {newDealOpen && (
        <NewDealSlideOut
          accounts={accounts.filter((a) => !a.deleted_at)}
          allTeams={allTeams}
          todayIso={todayEtIso}
          closeHref={newDealSheetCloseHref}
          sheetError={sheetError}
          duplicateWarning={
            typeof sp.dup_id === "string" && UUID_RE.test(sp.dup_id)
              ? { id: sp.dup_id, label: typeof sp.dup_label === "string" ? sp.dup_label : "" }
              : null
          }
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
  allTeams,
  todayIso,
  closeHref,
  sheetError,
  duplicateWarning,
  action,
}: {
  accounts: CommercialAccount[];
  /** Teams for the Team select — parity with the account's new-deal form. */
  allTeams: { id: string; name: string }[];
  /** Today in ET, for the RFP-received default. Computed on the server so the
   *  default doesn't depend on the viewer's machine clock. */
  todayIso: string;
  closeHref: string;
  sheetError: string | null;
  /** Set when the create action bounced back on a duplicate match. */
  duplicateWarning: { id: string; label: string } | null;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <>
      <Link
        href={closeHref}
        aria-label="Close new opportunity panel"
        className="fixed inset-0 z-40 bg-ppp-navy-900/40 backdrop-blur-sm"
      />
      <FocusTrapAside
        closeHref={closeHref}
        id="new-deal-sheet"
        className="fixed right-0 top-0 bottom-0 z-50 w-full sm:max-w-md bg-surface shadow-2xl flex flex-col"
        ariaLabelledBy="new-deal-sheet-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-ppp-charcoal-100">
          <div>
            <h2 id="new-deal-sheet-title" className="text-base font-bold text-ppp-charcoal">New opportunity</h2>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              Pick the GC (account), name the opportunity, click Create.
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
          <div className="mx-5 mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
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
            accounts={accounts.map((a) => ({ id: a.id, company_name: a.company_name, do_not_bid: a.do_not_bid }))}
          />

          {/* Duplicate match. Without a "Create anyway" path the check would be
              a dead end — the user would resubmit identical values forever. */}
          {duplicateWarning && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900 space-y-1.5">
              <div className="font-semibold">Possible duplicate</div>
              <div>
                This customer already has{" "}
                <Link
                  href={`/commercial/opportunities/${duplicateWarning.id}`}
                  className="font-semibold underline hover:no-underline"
                >
                  {duplicateWarning.label || "a matching opportunity"}
                </Link>{" "}
                at the same client and address. Open it, or create this one anyway.
              </div>
              <input type="hidden" name="confirm_duplicate" value="1" />
            </div>
          )}

          <div>
            <label htmlFor="deal-title" className={LABEL_CLS}>
              Opportunity name <span className="text-rose-600">*</span>
            </label>
            {/* Parity with the account's new-deal form (audit #14): this sheet
                had a plain text input, so creating a deal from the pipeline
                produced a differently-named deal than creating the same deal
                from the account. builderFieldId lets it read the customer the
                picker above resolves, since that's chosen client-side here. */}
            <AutoOpportunityTitle builderFieldId="new-deal-account" className={INPUT_CLS} />
            <p className="text-[11px] text-ppp-charcoal-400 mt-0.5">
              Auto-fills as MM-DD-YYYY Builder - Client - Street. Type over it any time.
            </p>
          </div>

          {/* Phase E-4: cascading status/sub-status + optional follow-up
              fields. Server action already parses these formData keys. */}
          <StatusSubStatusPicker mode="create" />
          {/* RE-AUDIT 2026-08-12: a second `name="source"` select sat here,
              labelled "Source", left behind when this form was rebuilt into
              Brendan's field order — which put Lead source further down. Two
              controls with one name in one form means the browser submits both
              and `formData.get` takes the FIRST, so every lead source picked on
              this form was silently thrown away and the deal saved with none.
              They also shared a DOM id, so clicking the lower label scrolled you
              to the upper field. `source` feeds the win/loss report. */}

          {/* Bid low / high removed per the 2026-08 meeting — pricing lives on the proposal. */}

          {/* Client + project address. The slide-out never collected these, so a
              deal created from the pipeline was materially thinner than the
              same deal created from the account — and it shows downstream:
              hydrateProposalContext builds the proposal's project_name from
              client_name and its project_address from property_street, so a
              proposal started on a pipeline-created deal had a BLANK address on
              the PDF. They're also the two fields the duplicate check keys on. */}
          <div>
            <label htmlFor="new-deal-client" className={LABEL_CLS}>Client name</label>
            <input
              id="new-deal-client"
              name="client_name"
              maxLength={200}
              placeholder="Who the work is for (the GC's customer)"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="new-deal-street" className={LABEL_CLS}>Project address</label>
            <input
              id="new-deal-street"
              name="property_street"
              maxLength={200}
              placeholder="Street"
              className={INPUT_CLS}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
              <input name="property_city" maxLength={80} placeholder="City" className={INPUT_CLS} />
              <input name="property_state" maxLength={40} placeholder="State" className={INPUT_CLS} />
              <input name="property_zip" maxLength={20} placeholder="ZIP" className={INPUT_CLS} />
            </div>
          </div>

          {/* Same order as the account-scoped form (Brendan 2026-08-12), so the
              two ways into an opportunity ask for the same things in the same
              sequence. They had drifted: this one was missing the nickname, the
              estimator and the lead source entirely.

              PROPOSAL CONTACT is the one field of his list that is genuinely
              absent here, and it is a constraint rather than an omission — the
              contact list belongs to a GC that has not been chosen yet at the
              top of this form. The create writer already inherits the GC's
              primary contact when none is given, so a deal started here still
              lands with the right person on it. */}
          <div>
            <label htmlFor="new-deal-nickname" className={LABEL_CLS}>
              Project nickname <span className="font-normal text-ppp-charcoal-400">(optional)</span>
            </label>
            <input
              id="new-deal-nickname"
              name="title_override"
              maxLength={200}
              placeholder="What the team calls it — e.g. Jericho Turnpike lobby"
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="new-deal-due" className={LABEL_CLS}>Proposal due</label>
            <DateField
              id="new-deal-due"
              name="proposal_due_at"
              placeholder="Pick a due date"
              ariaLabel="Proposal due date"
            />
          </div>

          <div>
            <label htmlFor="new-deal-rfp" className={LABEL_CLS}>RFP received</label>
            {/* Defaults to today, matching the account form — the RFP almost
                always lands the day it's logged, and this powers
                time-to-proposal on the opportunity card. */}
            <DateField
              id="new-deal-rfp"
              name="rfp_received_at"
              defaultValue={todayIso}
              placeholder="When the RFP / bid request arrived"
              ariaLabel="RFP received date"
            />
          </div>

          <div>
            <label htmlFor="new-deal-estimator" className={LABEL_CLS}>Estimator</label>
            <input
              id="new-deal-estimator"
              name="estimator_name"
              maxLength={120}
              placeholder="Who's pricing it"
              className={INPUT_CLS}
            />
            <p className="text-[11px] text-ppp-charcoal-400 mt-0.5">
              Assigning one moves this opportunity to Estimating.
            </p>
          </div>

          <div>
            <label htmlFor="new-deal-source" className={LABEL_CLS}>Lead source</label>
            <select id="new-deal-source" name="source" defaultValue="" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              <option value="">Choose a source</option>
              {OPPORTUNITY_SOURCES.map((src) => (
                <option key={src} value={src}>{opportunitySourceLabel(src)}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="new-deal-team" className={LABEL_CLS}>Team</label>
            <select id="new-deal-team" name="team_id" defaultValue="" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              <option value="">— Customer&apos;s team —</option>
              {allTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-ppp-charcoal-400 mt-0.5">
              Leave blank to follow the customer&apos;s team. Build teams in Settings → Teams.
            </p>
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
      </FocusTrapAside>
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
      Create opportunity
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
  proposalTotalByOpp,
  sheetHref,
}: {
  opps: CommercialOpportunity[];
  accountById: Map<string, CommercialAccount>;
  /** Fallback deal value for deals with no bid range — see
   *  listCurrentProposalTotalByOpp. Without it this board's weighted-$
   *  column reads 0 for every deal created since the meeting removed the
   *  bid fields, disagreeing with the header KPI on the same screen. */
  proposalTotalByOpp: Map<string, number>;
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
    inDelivery: CommercialOpportunity[];
    closed: CommercialOpportunity[];
    weightedCents: number;
    latestUpdate: string;
  };

  const rows: Row[] = Array.from(byAccount.entries())
    .map(([accountId, oppsForAccount]) => {
      const account = accountById.get(accountId);
      if (!account) return null; // filtered by account soft-delete, skip
      // Three buckets, because the status model has THREE lanes, not two:
      // pre-sale OPEN (qualifying/estimating/proposal), IN-DELIVERY (under
      // contract: pre_construction/in_progress/billing), and TERMINAL (closed).
      // The board used to split open-vs-closed only, so a deal under contract
      // matched NEITHER and vanished — a GC whose only deal was in production
      // showed "0 open bids" with no deals listed at all (audit D1). weighted$
      // still counts PRE-SALE ONLY (open), matching the KPI above so a $400k
      // job in progress can't reappear as $400k of "pipeline".
      const open = oppsForAccount.filter((o) =>
        PRE_SALE_OPEN_STATUSES.includes(o.status)
      );
      const inDelivery = oppsForAccount.filter((o) =>
        IN_DELIVERY_STATUSES.includes(o.status)
      );
      const closed = oppsForAccount.filter((o) =>
        TERMINAL_STATUSES.has(o.status)
      );
      const weightedCents = open.reduce(
        (sum, o) => sum + weightedPipelineCents(o, proposalTotalByOpp.get(o.id)),
        0
      );
      const latestUpdate = oppsForAccount
        .map((o) => o.updated_at ?? "")
        .filter(Boolean)
        .sort()
        .reverse()[0] ?? "";
      return { account, open, inDelivery, closed, weightedCents, latestUpdate };
    })
    .filter((r): r is Row => r !== null)
    .sort((a, b) => {
      // Sort: biggest weighted pipeline first, then most recently active.
      if (a.weightedCents !== b.weightedCents) return b.weightedCents - a.weightedCents;
      return b.latestUpdate.localeCompare(a.latestUpdate);
    });

  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">
            {rows.length} customer{rows.length === 1 ? "" : "s"} on this list
          </h2>
          <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            Grouped by account, biggest weighted pipeline first. Click a customer to open their account, or an opportunity to drill in.
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
    inDelivery: CommercialOpportunity[];
    closed: CommercialOpportunity[];
    weightedCents: number;
    latestUpdate: string;
  };
  sheetHref: (accountId: string, focus?: string) => string;
}) {
  const { account, open, inDelivery, closed, weightedCents, latestUpdate } = row;
  // Latest activity relative label — "today", "5h ago", "3d ago", etc.
  // Uses updated_at which every mutation touches, so it's a real signal.
  const daysAgo = latestUpdate
    ? (daysAgoEt(latestUpdate) ?? 0)
    : null;
  const activityLabel =
    daysAgo === null
      ? "—"
      : daysAgo === 0
      ? "today"
      : daysAgo === 1
      ? "yesterday"
      : `${daysAgo}d ago`;

  // Karan 2026-07-15: color-per-account left border + avatar chip
  // (djb2-hue helper matches the /commercial/proposals mini-kanban
  // grammar so a customer reads visually consistent across surfaces).
  const acctTone = accountColorTone(account.id);
  const acctInitials = (account.company_name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  return (
    <li
      className="relative p-4 hover:bg-ppp-charcoal-50/40 transition-colors border-l-4"
      style={acctTone.border}
    >
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
        <div className="min-w-0 flex-1 flex items-start gap-3">
          <span
            className="shrink-0 w-10 h-10 rounded-full inline-flex items-center justify-center text-[12px] font-bold shadow-sm ring-1 ring-white"
            style={acctTone.avatar}
            aria-hidden
          >
            {acctInitials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/commercial/accounts/${account.id}`}
                className="text-[15px] font-bold text-ppp-charcoal hover:text-cc-brand-700 hover:underline underline-offset-2 break-words"
                title={`Open ${account.company_name}'s account`}
              >
                {account.company_name}
              </Link>
              {account.is_key_relationship && (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200"
                  title="Key relationship — flagged by admin"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block -mt-0.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg> Key
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200 tabular-nums">
                <span aria-hidden>▲</span>
                {open.length}
                <span className="font-medium text-cc-brand-700">
                  open bid{open.length === 1 ? "" : "s"}
                </span>
              </span>
              {inDelivery.length > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-cyan-50 text-cyan-800 border-cyan-200 tabular-nums">
                  {inDelivery.length}
                  <span className="font-medium text-cyan-700">under contract</span>
                </span>
              )}
              {weightedCents > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-50 text-emerald-800 border-emerald-200 tabular-nums">
                  {formatCentsCompact(weightedCents)}
                  <span className="font-medium text-emerald-700">weighted</span>
                </span>
              )}
              {closed.length > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200 tabular-nums">
                  {closed.length} closed
                </span>
              )}
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                  daysAgo !== null && daysAgo <= 1
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : daysAgo !== null && daysAgo <= 7
                      ? "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200"
                      : "bg-amber-50 text-amber-800 border-amber-200"
                }`}
                title={latestUpdate ? new Date(latestUpdate).toLocaleString() : undefined}
              >
                <span aria-hidden>•</span>
                Active {activityLabel}
              </span>
            </div>
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
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[36px] touch-manipulation transition-colors"
          title={`Quick view of ${account.company_name}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          View
        </Link>
      </div>
      {/* Karan 2026-07-15: bring back the progress-bar pill per deal
          (from before the row redesign). Each open deal now renders as
          a mini card with the segmented Pre-Sale progress bar (or the
          Post-Sale cyan chip for delivery-phase deals) + the deal
          title + bid range + confidence. Closed deals stay compact as
          small pills below so the eye still leads with open work. */}
      {(open.length > 0 || inDelivery.length > 0 || closed.length > 0) && (
        <div className="relative z-10 mt-3 space-y-1.5">
          {/* Active work leads: open bids first, then deals under contract.
              Both render as cards with a StageChip (StageChip shows the
              post-sale stage for delivery deals), so an account whose only work
              is in production still lists that work instead of showing nothing
              (audit D1). */}
          {[...open, ...inDelivery].map((o) => {
            const bidRange = o.bid_value_high_cents
              ? `${formatCentsCompact(o.bid_value_low_cents ?? 0)}–${formatCentsCompact(o.bid_value_high_cents)}`
              : o.bid_value_low_cents
              ? formatCentsCompact(o.bid_value_low_cents)
              : null;
            return (
              <Link
                key={o.id}
                href={sheetHref(account.id, o.id)}
                className="group/deal flex items-center gap-3 px-2.5 py-2 rounded-lg border border-ppp-charcoal-100 bg-surface hover:border-cc-brand-300 hover:bg-cc-brand-50/40 transition-colors min-h-[44px]"
                title={`View ${account.company_name} · ${derivedOppName(o, account.company_name)} — ${opportunityStatusLabel(o.status)}`}
              >
                {/* 2026-07-28 audit: lead with the deal name (primary), a
                    compact single-stage pill after it — was a 160–220px 4-pill
                    stepper eating the row + wrapping to 2 lines on mobile. */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-ppp-charcoal group-hover/deal:text-cc-brand-800">
                      {derivedOppName(o, account.company_name)}
                    </span>
                    <span className="shrink-0">
                      <StageChip status={o.status} sub_status={o.sub_status} compact />
                    </span>
                  </div>
                  {bidRange && (
                    <div className="text-[10.5px] text-ppp-charcoal-500 mt-0.5 tabular-nums flex items-center gap-1.5 flex-wrap">
                      <span>{bidRange} bid</span>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
          {closed.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {closed.slice(0, 3).map((o) => (
                <Link
                  key={o.id}
                  href={sheetHref(account.id, o.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-ppp-charcoal-100 bg-ppp-charcoal-50/70 text-ppp-charcoal-600 text-[11px] font-medium hover:bg-ppp-charcoal-100 max-w-[220px] truncate"
                  title={`${derivedOppName(o, account.company_name)} — ${opportunityStatusLabel(o.status)}`}
                >
                  {/* Only a LOST deal gets the red ✗. Keying the check on
                      sub_status==="won" flagged every COMPLETED job (post_sale_closed,
                      whose sub_status is a completion state, not "won") as lost —
                      a finished job read as a loss (audit D17). */}
                  <span aria-hidden className={`shrink-0 ${isLost(o) ? "text-rose-500" : "text-emerald-700"}`}>
                    {isLost(o) ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18 M6 6l12 12" /></svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                    )}
                  </span>
                  <span className="truncate">{derivedOppName(o, account.company_name)}</span>
                </Link>
              ))}
              {closed.length > 3 && (
                <Link
                  href={`/commercial/accounts/${account.id}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-ppp-charcoal-100 bg-surface text-ppp-charcoal-500 text-[11px] font-medium hover:bg-ppp-charcoal-50"
                  title={`See all ${closed.length} closed opportunities`}
                >
                  +{closed.length - 3} more closed
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </li>
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
  currentProposal,
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
  /** Newest live revision, for the "proposal is behind the deal" badge. */
  currentProposal?: { status: string; revision: number } | null;
}) {
  const moveToOptions = moveToOptionsFor(opp);
  const days = statusEnteredAt
    ? daysAgoEt(statusEnteredAt)
    : null;
  const daysTone =
    days === null
      ? "text-ppp-charcoal-400"
      : days > 14
      ? "text-rose-600"
      : days > 7
      ? "text-amber-700"
      : "text-cc-brand-600";
  const leadFirst = primaryLead
    ? primaryLead.user_full_name?.split(" ")[0] ?? primaryLead.user_email.split("@")[0]
    : null;
  // Karan 2026-07-20 UI/UX rebuild: card meta band was dense emoji-
  // suffixed text ("· 📎 3 · 🎨 2 · 📋 1"); replaced with a compact
  // icon-strip that only renders signals with count > 0. Also:
  // - OPP-#### chip surfaces on the card header (the global opportunity id)
  // - bid amount promoted to a bolder line (primary money signal)
  // - "days here" only shown when > 3 (fresh moves don't need it)
  // - probability only shown when it differs from the status default
  //   (skips the noisy "· 10%" that shows on every fresh Solicitation)
  // Karan 2026-07-21: chip now shows the canonical OPP-2026-#### id (from
  // project_number) instead of the confusing per-account deal_number.
  const oppCode = formatOpportunityNumber(opp.project_number);
  const showDays = days !== null && days > 3;
  // Automatic status moves are forward-only, so a deal that's ahead of its
  // current proposal STAYS ahead — correctly (you really did send R1), but the
  // proposals board shows a Draft while this card says Proposal. Naming the
  // proposal's actual state here stops that reading as a bug, and stops anyone
  // dragging the deal backwards to "fix" it.
  const trailingProposal =
    currentProposal && proposalTrailsDeal(opp, currentProposal.status) ? currentProposal : null;

  if (compact) {
    return (
      <li className="bg-surface-raised border border-ppp-charcoal-100 rounded-md p-1.5 hover:border-ppp-charcoal-200 transition-colors">
        <Link href={sheetHref(opp.account_id, opp.id)} className="block">
          {oppCode && (
            <div className="text-[9px] font-mono text-ppp-navy-600 mb-0.5">
              {oppCode}
            </div>
          )}
          <div className="text-[11px] font-semibold text-ppp-charcoal leading-snug break-words line-clamp-2">
            {derivedOppName(opp, account?.company_name ?? null)}
          </div>
          {account && (
            <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 truncate">
              {account.company_name}
            </div>
          )}
          <div className="text-[10.5px] font-semibold text-ppp-charcoal-800 mt-0.5 tabular-nums">
            {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
          </div>
        </Link>
      </li>
    );
  }
  return (
    <li className="bg-surface-raised border border-ppp-charcoal-100 rounded-lg p-2.5 hover:border-ppp-charcoal-200 hover:shadow-sm transition-all">
      <Link
        href={sheetHref(opp.account_id, opp.id)}
        className="block"
      >
        {/* Header row: OPP-#### chip (subtle) + optional overdue red dot. */}
        {(oppCode || (taskStats && taskStats.overdue > 0)) && (
          <div className="flex items-center justify-between gap-2 mb-1">
            {oppCode ? (
              <span className="text-[9.5px] font-mono text-ppp-navy-600" title="Opportunity ID">
                {oppCode}
              </span>
            ) : <span />}
            {taskStats && taskStats.overdue > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[9.5px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded-full"
                title={`${taskStats.overdue} overdue task${taskStats.overdue === 1 ? "" : "s"}`}
              >
                <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                {taskStats.overdue}
              </span>
            )}
          </div>
        )}
        <div className="text-[13px] font-semibold text-ppp-charcoal leading-snug mb-1 break-words">
          {derivedOppName(opp, account?.company_name ?? null)}
        </div>
        {/* Proposal-column tags. Merging "Proposal Drafted" + "Proposal Sent"
            into one Proposal column would otherwise lose the one distinction
            that actually matters day to day: has the GC seen it, and are we
            chasing? Amber = waiting on them, charcoal = still ours. */}
        {(isFollowUpCard(opp.status, opp.sub_status) ||
          isDraftedCard(opp.status, opp.sub_status) ||
          trailingProposal) && (
          <div className="mb-1 flex items-center gap-1 flex-wrap">
            {isFollowUpCard(opp.status, opp.sub_status) ? (
              <span
                className="inline-flex items-center h-[18px] px-1.5 rounded-full text-[9.5px] font-bold bg-amber-50 text-amber-800 border border-amber-200"
                title="Proposal is out — we're chasing a response"
              >
                Follow-Up
              </span>
            ) : isDraftedCard(opp.status, opp.sub_status) ? (
              <span
                className="inline-flex items-center h-[18px] px-1.5 rounded-full text-[9.5px] font-bold bg-ppp-charcoal-50 text-ppp-charcoal-600 border border-ppp-charcoal-200"
                title="Priced and awaiting internal sign-off — not sent to the GC yet"
              >
                Not sent yet
              </span>
            ) : null}
            {trailingProposal && (
              <span
                className="inline-flex items-center h-[18px] px-1.5 rounded-full text-[9.5px] font-bold bg-ppp-navy-50 text-ppp-navy-700 border border-ppp-navy-200"
                title={`The newest proposal (R${trailingProposal.revision}) is in ${proposalStatusLabel(trailingProposal.status)}. The deal stays where it is — a new revision doesn't undo work already done.`}
              >
                R{trailingProposal.revision} {proposalStatusLabel(trailingProposal.status)}
              </span>
            )}
          </div>
        )}
        {account && (
          <div className="text-[11px] text-ppp-charcoal-500 mb-1.5 truncate">
            {account.company_name}
          </div>
        )}
        {/* Bid line — bumped weight so it reads as the primary money signal */}
        <div className="text-[13px] font-bold text-ppp-charcoal-900 tabular-nums">
          {formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
        </div>
        {/* Compact icon strip — only renders when there's something to show.
            No more emoji + "· " noise; small SVG icons keep the row scannable. */}
        {(showDays || leadFirst || fileCount > 0 || finishCount > 0 || (submittalStats && submittalStats.total > 0)) && (
          <div className="text-[10.5px] text-ppp-charcoal-500 mt-1 flex items-center gap-x-2.5 gap-y-1 flex-wrap">
            {showDays && (
              <span className={`${daysTone} font-semibold`} title={`In current stage for ${days}d`}>
                {days}d here
              </span>
            )}
            {leadFirst && (
              <span className="inline-flex items-center gap-1" title={`Primary lead: ${primaryLead?.user_full_name ?? primaryLead?.user_email ?? ""}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {leadFirst}
              </span>
            )}
            {fileCount > 0 && (
              <span className="inline-flex items-center gap-0.5 tabular-nums" title={`${fileCount} file${fileCount === 1 ? "" : "s"}`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                {fileCount}
              </span>
            )}
            {finishCount > 0 && (
              <span className="inline-flex items-center gap-0.5 tabular-nums" title={`${finishCount} finish${finishCount === 1 ? "" : "es"} in the schedule`}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                  <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                  <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                  <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
                </svg>
                {finishCount}
              </span>
            )}
            {submittalStats && submittalStats.total > 0 && (
              <span
                className={`inline-flex items-center gap-0.5 tabular-nums ${submittalStats.awaiting_response > 0 ? "text-ppp-blue-700 font-semibold" : ""}`}
                title={
                  submittalStats.awaiting_response > 0
                    ? `${submittalStats.total} submittal${submittalStats.total === 1 ? "" : "s"} · ${submittalStats.awaiting_response} awaiting GC response`
                    : `${submittalStats.total} submittal${submittalStats.total === 1 ? "" : "s"}`
                }
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {submittalStats.total}
              </span>
            )}
          </div>
        )}
      </Link>
      {moveToOptions.length > 0 && (
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
            {/* Only offer legal next statuses for THIS card (Karan 2026-07-27
                audit) — the menu used to list every column incl. the card's own
                current stage, so a Qualifying card offered "→ Qualifying". */}
            {moveToOptions.map((col) => (
              <option key={col.key} value={col.key}>
                → {col.label}
              </option>
            ))}
          </select>
          <SubmitButton pendingLabel="…"
            className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            Go
          </SubmitButton>
        </form>
      )}
    </li>
  );
}

/**
 * Slim KPI card — same shape as the accounts page. Consistency across
 * both list pages so users learn the pattern once.
 */
/** Karan 2026-07-15: KPI tile upgrade. Every tile now carries an icon
 *  puck top-right (tone-tinted), a corner radial glow, and a beefier
 *  value size — the earlier flat white version read as weak against the
 *  kanban below. Same visual grammar as the /commercial dashboard tiles
 *  so all three surfaces (dashboard + pipeline + proposals) match. */
function KpiCard({
  tone,
  label,
  value,
  sub,
  icon,
}: {
  tone: "cc-brand" | "blue" | "emerald" | "amber" | "neutral";
  label: string;
  value: string;
  sub: string;
  icon?: React.ReactNode;
}) {
  const toneMap: Record<string, { border: string; glow: string; stripe: string; iconBg: string; iconTx: string }> = {
    "cc-brand": {
      border: "border-cc-brand-100",
      glow: "bg-cc-brand-100/60",
      stripe: "bg-gradient-to-b from-cc-brand-600 to-cc-brand-500",
      iconBg: "bg-cc-brand-100",
      iconTx: "text-cc-brand-700",
    },
    blue: {
      border: "border-ppp-blue-100",
      glow: "bg-ppp-blue-100/60",
      stripe: "bg-gradient-to-b from-ppp-blue-600 to-ppp-blue-500",
      iconBg: "bg-ppp-blue-100",
      iconTx: "text-ppp-blue-700",
    },
    emerald: {
      border: "border-emerald-100",
      glow: "bg-emerald-100/60",
      stripe: "bg-gradient-to-b from-emerald-600 to-emerald-500",
      iconBg: "bg-emerald-100",
      iconTx: "text-emerald-700",
    },
    amber: {
      border: "border-amber-100",
      glow: "bg-amber-100/60",
      stripe: "bg-gradient-to-b from-amber-500 to-amber-400",
      iconBg: "bg-amber-100",
      iconTx: "text-amber-700",
    },
    neutral: {
      border: "border-ppp-charcoal-100",
      glow: "bg-ppp-charcoal-100/60",
      stripe: "bg-gradient-to-b from-ppp-charcoal-400 to-ppp-charcoal-300",
      iconBg: "bg-ppp-charcoal-100",
      iconTx: "text-ppp-charcoal-600",
    },
  };
  const t = toneMap[tone] ?? toneMap.neutral;
  return (
    <div
      className={`group/kpi relative bg-surface border ${t.border} rounded-xl px-4 py-3.5 overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${t.stripe}`} />
      <span
        aria-hidden
        className={`absolute -top-8 -right-8 h-24 w-24 rounded-full blur-2xl ${t.glow}`}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
            {label}
          </div>
          <div className="text-2xl sm:text-3xl font-black text-ppp-charcoal mt-1 leading-tight tabular-nums">
            {value}
          </div>
          <div className="text-[11px] text-ppp-charcoal-500 mt-1">{sub}</div>
        </div>
        {icon && (
          <span
            className={`shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg ${t.iconBg} ${t.iconTx}`}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
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
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-cc-brand-50 border border-cc-brand-200 text-cc-brand-700 text-[11px] font-semibold hover:bg-cc-brand-100 transition-colors min-h-[44px] sm:min-h-[28px] touch-manipulation"
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
          active ? "bg-cc-brand-600 border-cc-brand-700 text-white" : "bg-surface border-ppp-charcoal-300 text-transparent"
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
  currentProposal = null,
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
  /** Newest live proposal, so the row can say "mark it approved" and open it. */
  currentProposal?: { id: string; status: string } | null;
  /** Karan 2026-07-10: when true, suppress the row's inline account
   *  name + industry chip because the outer group header already
   *  renders them. Kills the "Bob · Bob · — bid" repetition. */
  hideAccount?: boolean;
}) {
  const bid = formatBidRange(opportunity.bid_value_low_cents, opportunity.bid_value_high_cents);
  const dueChip = decisionChip(opportunity.proposal_due_at);
  const daysInStatus = statusEnteredAt
    ? daysAgoEt(statusEnteredAt)
    : null;
  const moveToOptions = moveToOptionsFor(opportunity);
  const next = nextStep({
    oppId: opportunity.id,
    status: opportunity.status,
    subStatus: opportunity.sub_status,
    accountId: opportunity.account_id,
    proposal: currentProposal ? { id: currentProposal.id, status: currentProposal.status } : null,
    // Derived from the current proposal rather than counted — the list doesn't
    // load history, and every branch of nextStep turns on presence + newest
    // state, not on how many revisions there have been.
    proposalCount: currentProposal ? 1 : 0,
    sentProposalCount:
      currentProposal && ["sent", "won", "lost"].includes(currentProposal.status) ? 1 : 0,
    approvedNotSentCount: 0,
  });
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
            {/* Line 1 — title + single status chip + due chip.
                Karan 2026-07-15 (round 2): killed the full 4-pill
                journey strip on pipeline rows — that grammar belongs
                on the deal detail page where it has room, not
                stacked on top of every list row. Cards now use ONE
                compact chip: "Status · sub_status" (e.g. "Proposal ·
                Proposal Sent" or the display label like "Won" on
                decided opportunities). Clean, one-line, scannable at 50+
                deals per screen. Full status path lives on the
                opp detail page. */}
            <div className="flex items-center gap-2 flex-wrap">
              {formatOpportunityNumber(opportunity.project_number) && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-navy-50 border border-ppp-navy-100 text-ppp-navy-700 text-[10px] font-bold tracking-wide font-mono shrink-0"
                  title={`Opportunity ID · ${formatOpportunityNumber(opportunity.project_number)}`}
                >
                  {formatOpportunityNumber(opportunity.project_number)}
                </span>
              )}
              <span className="font-bold text-ppp-charcoal text-[15px] leading-tight">
                {derivedOppName(opportunity, account?.company_name ?? null)}
              </span>
              <StageChip status={opportunity.status} sub_status={opportunity.sub_status} />
              {dueChip && <DueChip {...dueChip} />}
              {opportunity.archived_at && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded bg-ppp-charcoal-100 border border-ppp-charcoal-200 text-ppp-charcoal-700 text-[9px] font-bold uppercase tracking-widest"
                  title="Archived — visible because 'Include archived' is on."
                >
                  archived
                </span>
              )}
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
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block -mt-0.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg>
                    {(primaryLead.user_full_name ?? primaryLead.user_email).split(" ")[0]}
                  </span>
                )}
                {fileCount > 0 && (
                  <span className="text-ppp-charcoal-600 inline-flex items-center gap-1" title="Plans & Specs attachments">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    {fileCount} {fileCount === 1 ? "file" : "files"}
                  </span>
                )}
                {finishCount > 0 && (
                  <span className="text-ppp-charcoal-600 inline-flex items-center gap-1" title={`${finishCount} finish-schedule code${finishCount === 1 ? "" : "s"} defined`}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
                    </svg>
                    {finishCount} {finishCount === 1 ? "finish" : "finishes"}
                  </span>
                )}
                {submittalStats && submittalStats.total > 0 && (
                  <span
                    className={`inline-flex items-center gap-1 ${submittalStats.awaiting_response > 0 ? "text-ppp-blue-700 font-medium" : "text-ppp-charcoal-600"}`}
                    title={
                      submittalStats.awaiting_response > 0
                        ? `${submittalStats.awaiting_response} awaiting GC response`
                        : `${submittalStats.total} submittal${submittalStats.total === 1 ? "" : "s"} closed`
                    }
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    {submittalStats.total}
                    {submittalStats.awaiting_response > 0 && (
                      <span className="ml-1 inline-flex items-center px-1 py-0 rounded bg-ppp-blue-100 text-ppp-blue-700 text-[10px] font-bold uppercase tracking-wider">
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
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cc-brand-800 bg-cc-brand-50 border border-cc-brand-100 hover:bg-cc-brand-100 transition-colors min-h-[44px] sm:min-h-[28px] touch-manipulation"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
              </svg>
              <span>{finishCount} {finishCount === 1 ? "finish" : "finishes"} →</span>
            </Link>
          )}
          {submittalStats && submittalStats.total > 0 && (
            <Link
              href={`/commercial/accounts/${opportunity.account_id}/submittals/${opportunity.id}`}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors min-h-[44px] sm:min-h-[28px] touch-manipulation ${
                submittalStats.awaiting_response > 0
                  ? "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100 hover:bg-ppp-blue-100"
                  : "text-ppp-charcoal-700 bg-ppp-charcoal-50 border-ppp-charcoal-100 hover:bg-ppp-charcoal-100/70"
              }`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
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

      {/* The row's footer: the ONE recommended action first, the manual
          status flip after it. Both live outside the row's own <Link> — an
          anchor inside an anchor is invalid and the inner one stops firing. */}
      <div className="px-4 pb-3 -mt-1 flex items-center gap-2 flex-wrap">
      <NextStepButton step={next} oppId={opportunity.id} />
      {moveToOptions.length > 0 ? (
        <form
          action={quickFlipStatusAction}
          className="flex items-center gap-2 flex-wrap"
        >
          <input type="hidden" name="opp_id" value={opportunity.id} />
          <input type="hidden" name="return_href" value={flipReturnHref} />
          <select
            id={`flip-${opportunity.id}`}
            name="to_status"
            defaultValue=""
            required
            aria-label={`Move ${opportunity.title} to next stage`}
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
          <SubmitButton pendingLabel="…"
            className="px-3 py-1.5 rounded-md bg-ppp-charcoal text-surface text-sm font-semibold hover:bg-ppp-charcoal-700 active:bg-ppp-charcoal-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
          >
            Go
          </SubmitButton>
        </form>
      ) : (
        <p className="text-[11px] text-ppp-charcoal-500">
          <Link
            href={sheetHref(opportunity.account_id, opportunity.id)}
            className="underline hover:text-ppp-charcoal-700 inline-flex items-center min-h-[44px] sm:min-h-0"
          >
            Peek to reopen
          </Link>
        </p>
      )}
      </div>
    </li>
  );
}

function relativeAgo(iso: string): string {
  // One implementation, in lib/date-et — ET calendar days, not a UTC divide.
  return relativeAgoEt(iso, "just now");
}

function decisionChip(iso: string | null): { label: string; tone: "ok" | "soon" | "overdue" } | null {
  if (!iso) return null;
  const days = daysFromTodayEt(iso); // whole ET days; was UTC-midnight, overdue 1d early in ET evenings
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
      : "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${cls}`}>
      {label}
    </span>
  );
}

/**
 * Karan 2026-07-15: pill progress bar for pipeline rows. Shows the
 * 4-stage pre-sale progression as a segmented bar with the CURRENT
 * stage highlighted + sub-status labeled below. Reads like a status
 * strip on a package-tracking page rather than a stack of loose pills.
 * Won/Lost collapse to a single emerald/rose pill (no bar).
 *
 * Layout:
 *   ┌──┬──┬══┬──┐
 *   │Q │E │P │C │  ← 4 segments, "P" is current (filled + labeled)
 *   └──┴──┴══┴──┘
 *   Proposal · Proposal Sent
 */
/** Karan 2026-07-15 rework: full pill-stepper on every pipeline row.
 *  Same structure as the deal-detail status path (Pre-Sale row
 *  or Post-Sale row of stages) but sized tight for list use:
 *
 *    ● Qualifying ── Estimating ── ● Proposal ── ─ Closed
 *                                     └ Sent
 *
 *  Each stage is an actual PILL — filled brand-blue when current,
 *  filled slate when past, outlined white when future. Connectors
 *  are thin filled bars for completed segments, dashed muted for
 *  future. Sub-status renders below the current pill.
 *
 *  Won/Lost terminal collapses to a single emerald/rose pill (no
 *  stepper — the decision IS the state). Post-sale shows the
 *  Post-Sale row of stages instead of Pre-Sale.
 */
/** Keyed by KANBAN COLUMN, not by raw status, so the pill on a list row
 *  always names the column the card sits in on the board. "RFP" is
 *  abbreviated here (not "Request for Proposal") purely for width — a
 *  five-pill stepper has to survive a 375px phone. Won/Lost collapse to a
 *  single terminal pill below, so one "Closed" segment covers both. */
/*
 * AUDIT 2026-08-12: this was a THIRD hardcoded copy of the stage ladder, and
 * it had already drifted — it still said `proposal` (renamed `sent`) and never
 * heard about `pending_approval`. A deal at either stage matched no segment, so
 * the row's stepper silently showed nothing highlighted.
 *
 * Exactly the failure the path bar had, for the same reason: a second list that
 * has to be remembered when the first one changes. Derived from the shared
 * columns now, so it cannot drift again. Won/Lost still collapse into one
 * "Closed" segment — the terminal pill above already covers the decision, and
 * two dead segments on a 375px row buy nothing.
 */
const PRE_SALE_STEPPER: { key: string; label: string }[] = [
  ...PRE_CONTRACT_COLUMNS.filter((c) => c.key !== "won" && c.key !== "lost").map((c) => ({
    key: c.key,
    // "Request for Proposal" is abbreviated purely for width — a stepper has
    // to survive a 375px phone.
    label: c.key === "rfp" ? "RFP" : c.key === "pending_approval" ? "Approval" : c.label,
  })),
  { key: "pre_sale_closed", label: "Closed" },
];
const POST_SALE_STEPPER: { key: string; label: string }[] = [
  { key: "pre_construction", label: "Pre-Const" },
  { key: "in_progress", label: "In Progress" },
  { key: "billing", label: "Billing" },
  { key: "post_sale_closed", label: "Closed" },
];

function StageChip({
  status,
  sub_status,
  compact = false,
}: {
  status: string;
  sub_status: string | null | undefined;
  /** Single current-stage pill instead of the full stepper — for dense list
   *  rows where the 4-pill stepper dominated the row (2026-07-28 audit). */
  compact?: boolean;
}) {
  const isWonDeal = status === "pre_sale_closed" && sub_status === "won";
  const isLostDeal = status === "pre_sale_closed" && sub_status === "lost";
  // Terminal (Won/Lost) → single emerald/rose pill. The stepper is
  // pointless once the decision is made.
  if (isWonDeal || isLostDeal) {
    return (
      <span
        className={`inline-flex items-center h-6 px-2.5 rounded-full text-[11px] font-bold border shadow-sm ${
          isWonDeal
            ? "bg-emerald-500 text-white border-emerald-500"
            : "bg-rose-500 text-white border-rose-500"
        }`}
      >
        {isWonDeal ? "Won" : "Lost"}
      </span>
    );
  }
  // Which lane are we in? Post-sale statuses render the delivery
  // stepper (Pre-Const → In Progress → Billing → Closed) with cyan
  // tinting; pre-sale statuses render the sales stepper (Qualifying
  // → Estimating → Proposal → Closed) with brand blue.
  const isPostSale = (POST_SALE_STATUSES as readonly string[]).includes(status);
  const stages = isPostSale ? POST_SALE_STEPPER : PRE_SALE_STEPPER;
  const laneLabel = isPostSale ? "Post-Sale" : "Pre-Sale";
  // Column consistency — the stepper advances to the segment matching the
  // KANBAN COLUMN this deal sits in, so a row's pill and its card on the
  // board never disagree. (An opp at (estimating,
  // proposal_pending_approval) shows under Proposal; one at (qualifying,
  // rfp) shows under RFP.) Pre-sale closed has no column key of its own —
  // won/lost already returned above via the terminal pill — so the
  // stepper's "Closed" segment is matched on the raw status.
  const columnKey = columnKeyForOpp(status, sub_status);
  const stageKey =
    isPostSale || status === "pre_sale_closed" ? status : columnKey;
  const currentIdx = Math.max(
    0,
    stages.findIndex((s) => s.key === stageKey)
  );
  const currentLabel = stages[currentIdx]?.label ?? "Qualifying";
  const subLabel = sub_status ? opportunitySubStatusLabel(sub_status) : "";
  // Dedupe: "Estimating · Estimating" collapses to just the top pill, and
  // "RFP · Request for Proposal (RFP)" collapses to just "RFP" — the sub
  // IS the stage now, so repeating it below is noise.
  const showSubBelow =
    subLabel &&
    subLabel.toLowerCase() !== currentLabel.toLowerCase() &&
    !(columnKey === "rfp" && sub_status === "rfp");
  // Current-stage "you are here" pill: matches the kanban ramp — pre-sale
  // active = ppp-blue, post-sale (won work) = emerald. (Was cyan / cc-brand-red.)
  const currentPillCls = isPostSale
    ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
    : "bg-ppp-blue-600 text-white border-ppp-blue-600 shadow-sm";
  // Compact: just the current stage as one pill (list rows).
  if (compact) {
    return (
      <span
        className={`inline-flex items-center h-6 px-2.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${currentPillCls}`}
        aria-label={`${laneLabel} stage: ${currentLabel}${showSubBelow ? ` · ${subLabel}` : ""}`}
        title={`${currentLabel}${showSubBelow ? ` · ${subLabel}` : ""}`}
      >
        {currentLabel}
        {showSubBelow && <span className="font-normal opacity-80 ml-1">· {subLabel}</span>}
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-col items-start gap-1 min-w-0"
      role="progressbar"
      aria-valuenow={currentIdx + 1}
      aria-valuemin={1}
      aria-valuemax={stages.length}
      aria-label={`${laneLabel} stage: ${currentLabel} (${currentIdx + 1} of ${stages.length})`}
    >
      <span className="inline-flex items-center flex-wrap gap-y-1">
        {stages.map((s, i) => {
          const isPast = i < currentIdx;
          const isCurrent = i === currentIdx;
          const pillCls = isCurrent
            ? currentPillCls
            : isPast
              ? "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200"
              : "bg-surface text-ppp-charcoal-400 border-ppp-charcoal-200";
          const connectorCls = isPast
            ? "bg-ppp-charcoal-300"
            : "bg-ppp-charcoal-200 opacity-60";
          const isLast = i === stages.length - 1;
          return (
            <span key={s.key} className="inline-flex items-center">
              <span
                className={`inline-flex items-center h-5 px-2 rounded-full border text-[10.5px] font-semibold whitespace-nowrap ${pillCls}`}
                aria-current={isCurrent ? "step" : undefined}
              >
                {s.label}
              </span>
              {!isLast && (
                <span aria-hidden className={`h-px w-2.5 sm:w-3.5 mx-0.5 ${connectorCls}`} />
              )}
            </span>
          );
        })}
      </span>
      {showSubBelow && (
        <span className="text-[10.5px] text-ppp-charcoal-500 pl-1 truncate max-w-[220px]">
          <span aria-hidden className="text-ppp-charcoal-300 mr-1">└</span>
          {subLabel}
        </span>
      )}
    </span>
  );
}

function RatingPill({ rating }: { rating: CommercialAccountRating }) {
  const cls =
    rating === "A"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : rating === "B"
      ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"
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
    approved: { label: "Prequal: Approved", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    rejected: { label: "Prequal: Declined", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  }[status];
  if (!map) return null;
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border ${map.cls}`}>
      {map.label}
    </span>
  );
}

function StatusPill({
  status,
  subStatus,
}: {
  status: OpportunityStatus | string;
  subStatus?: string | null;
}) {
  // Karan 2026-07-09 Phase A.1: CEO status-model correction. Map covers
  // the 8 Pre-Contract values + retired v1.0 values so any un-migrated
  // historic row still tints correctly. Fallback to neutral if a truly
  // unknown status reaches the UI.
  // 2026-07-28 color audit: replaced the raw purple/orange/cyan + red-for-stage
  // tints with the semantic palette (pre-sale active → ppp-blue, working →
  // amber, won → emerald, lost/no-bid → rose, neutral/early → charcoal). The
  // pill LABEL keeps the stages distinct where they share a tone.
  const map: Record<string, string> = {
    solicitation: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    rfp: "bg-ppp-blue-100 text-ppp-blue-700 border-ppp-blue-200",
    estimating: "bg-amber-100 text-amber-900 border-amber-300",
    proposal_pending_approval: "bg-ppp-navy-100 text-ppp-navy-700 border-ppp-navy-200",
    proposal_sent: "bg-ppp-blue-100 text-ppp-blue-700 border-ppp-blue-200",
    follow_up: "bg-amber-100 text-amber-900 border-amber-300",
    won: "bg-emerald-100 text-emerald-800 border-emerald-300",
    lost: "bg-rose-100 text-rose-800 border-rose-300",
    // Retired v1.0 values (fallback for un-migrated rows)
    inquiry: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    negotiating: "bg-amber-100 text-amber-900 border-amber-300",
    on_hold: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
    no_bid: "bg-rose-100 text-rose-800 border-rose-300",
    reopened: "bg-ppp-blue-100 text-ppp-blue-700 border-ppp-blue-200",
  };
  const cls = map[status] ?? "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold border ${cls}`}>
      {/* Won and Lost both map to "Closed" on the status alone, so the board
          could not tell them apart — every other surface uses the display
          label. */}
      {oppStatusDisplayLabel(status, subStatus ?? null)}
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
    <div id="customer-sheet" className="fixed inset-0 z-40">
      {/* Backdrop — full-viewport link that closes the sheet. */}
      <Link
        href={closeHref}
        aria-label="Close GC account sheet"
        className="absolute inset-0 bg-ppp-charcoal/40 backdrop-blur-[1px]"
      />
      {/* Sheet — right-aligned slide-out. Wider than deal peek (480px)
          because it carries more content: team, financials, invoices,
          deals. Full width on mobile. */}
      <FocusTrapAside
        closeHref={closeHref}
        ariaLabelledBy="customer-sheet-title"
        className="absolute right-0 top-0 bottom-0 w-full sm:w-[480px] max-w-full bg-surface border-l border-ppp-charcoal-200 shadow-2xl flex flex-col overflow-hidden animate-slide-in-right">
        {/* Header — company name + close + right-aligned View Account CTA
            per user's explicit ask ("top right of the sheet it says view
            full account button and brings the user to the account"). */}
        <header className="px-5 py-4 border-b border-ppp-charcoal-100 space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-0.5">
                GC / Account
              </div>
              <h2 id="customer-sheet-title" className="text-xl font-bold text-ppp-charcoal leading-tight break-words">
                {account.company_name}
              </h2>
              <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                {account.rating && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200 capitalize">
                    {account.rating.replace(/_/g, " ")}
                  </span>
                )}
                {account.is_key_relationship && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block -mt-0.5"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"/></svg> Key
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
            {/* 2-up at base: three tiles of "$123,456.00" at ~86px each
                collided and the right one clipped on any 6-figure account. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div className="rounded-lg border border-ppp-charcoal-100 bg-surface px-2.5 py-2">
                <div className="text-[9.5px] text-ppp-charcoal-500 font-medium uppercase tracking-wide">Invoiced</div>
                <div className="text-sm font-bold text-ppp-charcoal mt-0.5 tabular-nums break-all">{formatCentsFull(rollup.invoiced_cents)}</div>
              </div>
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-2.5 py-2">
                <div className="text-[9.5px] text-emerald-800 font-medium uppercase tracking-wide">Paid</div>
                <div className="text-sm font-bold text-emerald-800 mt-0.5 tabular-nums break-all">{formatCentsFull(rollup.paid_cents)}</div>
              </div>
              <div className={`rounded-lg border px-2.5 py-2 ${rollup.overdue_count > 0 ? "border-rose-200 bg-rose-50/40" : "border-ppp-charcoal-100 bg-surface"}`}>
                <div className={`text-[9.5px] font-medium uppercase tracking-wide ${rollup.overdue_count > 0 ? "text-rose-800" : "text-ppp-charcoal-500"}`}>Balance</div>
                <div className={`text-sm font-bold mt-0.5 tabular-nums break-all ${rollup.overdue_count > 0 ? "text-rose-900" : "text-ppp-charcoal"}`}>{formatCentsFull(rollup.open_balance_cents)}</div>
              </div>
            </div>
            {rollup.invoiced_cents > 0 && (
              <div className="mt-2.5">
                <div className="h-1.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                  <div
                    className="h-full transition-all bg-emerald-500"
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
                Active opportunities ({openDeals.length})
              </div>
              <ul className="space-y-2">
                {openDeals.map((d) => {
                  const isFocused = d.id === focusOppId;
                  const moveToOptions = moveToOptionsFor(d);
                  return (
                    <li
                      key={d.id}
                      className={`rounded-lg border px-3 py-2 ${
                        isFocused ? "border-cc-brand-300 bg-cc-brand-50/40 ring-1 ring-cc-brand-200" : "border-ppp-charcoal-100 bg-surface"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold text-ppp-charcoal truncate">
                            {derivedOppName(d, account.company_name)}
                          </div>
                          <div className="text-[11px] text-ppp-charcoal-500 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                            <StatusPill status={d.status} subStatus={d.sub_status} />
                            <span>{formatBidRange(d.bid_value_low_cents, d.bid_value_high_cents)}</span>
                          </div>
                        </div>
                      </div>
                      {/* Phase G: post-sale (in-progress / billing) deals can
                          carry change orders — link straight to the tab. */}
                      {isPostSaleProject(d) && (
                        <Link
                          href={`/commercial/accounts/${account.id}/change-orders/${d.id}`}
                          className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px]"
                        >
                          Change orders
                          <span aria-hidden>→</span>
                        </Link>
                      )}
                      {moveToOptions.length > 0 && (
                        <form action={quickFlipStatusAction} className="mt-2 flex items-center gap-1.5">
                          <input type="hidden" name="opp_id" value={d.id} />
                          <input type="hidden" name="return_href" value={flipReturnHref} />
                          <select
                            name="to_status"
                            defaultValue=""
                            required
                            aria-label={`Move ${d.title} to next stage`}
                            className={`${SELECT_CLS} flex-1 text-base sm:text-xs py-1.5 min-h-[44px] sm:min-h-[36px]`}
                            style={SELECT_BG_STYLE}
                          >
                            <option value="" disabled>Move to…</option>
                            {moveToOptions.map((col) => (
                              <option key={col.key} value={col.key}>
                                → {col.label}
                              </option>
                            ))}
                          </select>
                          <SubmitButton pendingLabel="…"
                            className="px-2.5 py-1.5 text-[11px] font-semibold rounded-md bg-cc-brand-600 text-white hover:bg-cc-brand-700 min-h-[44px] sm:min-h-[36px] touch-manipulation"
                          >
                            Go
                          </SubmitButton>
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
                      <StatusPill status={d.status} subStatus={d.sub_status} />
                      <span className="truncate flex-1">{derivedOppName(d, account.company_name)}</span>
                      {isPostSaleProject(d) && (
                        <Link
                          href={`/commercial/accounts/${account.id}/change-orders/${d.id}`}
                          className="shrink-0 text-[10.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800"
                          title="Change orders"
                        >
                          Change orders →
                        </Link>
                      )}
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
              No opportunities on this customer yet. Start one from the account page.
            </section>
          )}
        </div>
      </FocusTrapAside>
    </div>
  );
}
