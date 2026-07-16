/**
 * Global proposals board — Phase F.6 revamp (Karan 2026-07-15).
 *
 * Every revision on every deal, organized in status-tinted columns that
 * mirror the /commercial/opportunities kanban. Alex glances at the
 * board and sees at once which proposals are Draft (still working) /
 * Pending Approval (waiting on Katie) / Sent (waiting on GC), and the
 * decided ones cluster to the right.
 *
 * URL: /commercial/proposals[?status=<status>]
 *
 * Karan asks:
 *   1. Build proposals straight from this page (no more "go to accounts
 *      first" detour) — via <NewProposalPicker> top-right that lets you
 *      pick account → deal → jump into the editor.
 *   2. Color-organize the UI like the opportunity page.
 *   3. Keep everything visible on the account page too (Proposals sub-
 *      tab under Deals, in a sibling file).
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { commercialDb } from "@/lib/commercial/db";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import {
  listCommercialOpportunities,
  derivedOppName,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import {
  PROPOSAL_STATUSES,
  PROPOSAL_ELIGIBLE_OPP_STATUSES,
  proposalStatusLabel,
  type ProposalStatus,
} from "@/lib/commercial/proposals/constants";
import NewProposalPicker from "@/components/commercial/new-proposal-picker";
import {
  ProposalsKanbanDnDProvider,
  ProposalDnDColumn,
  ProposalDnDCard,
} from "@/components/commercial/proposals-kanban-dnd";
import { reconcileDealStatesFromProposals } from "@/lib/commercial/proposals/db";

export const dynamic = "force-dynamic";

type ProposalRow = {
  id: string;
  revision_number: number;
  status: string;
  total_cents: number;
  sent_at: string | null;
  updated_at: string;
  opportunity_id: string;
  header_json: { gc_company?: string; project_name?: string } | null;
  opportunity: {
    id: string;
    title: string | null;
    client_name: string | null;
    location_short: string | null;
    account_id: string;
    deleted_at: string | null;
    account: { id: string; company_name: string; deleted_at: string | null } | null;
  } | null;
};

// ─────────────── column layout ───────────────

// Two active-lane columns + Won + a compact "Closed" cluster on the
// right. Mirrors the shape of /commercial/opportunities Kanban.
const ACTIVE_COLUMNS: ProposalStatus[] = ["draft", "pending_approval", "sent"];
// Karan 2026-07-16: dropped "superseded" (Replaced by newer) — we only
// render the CURRENT (highest-revision) proposal per deal on this page,
// so superseded rows never surface here. Keeping the column would
// forever show "0 —" and pretend it does something.
const CLOSED_TERMINAL: ProposalStatus[] = ["lost", "expired"];

// Karan 2026-07-16 (round 2): dropped MINI_KANBAN_COLUMN_LABEL — the
// account-page Proposals tab uses `proposalStatusLabel` for its status
// pills, and Karan asked for the two surfaces to say the same thing.
// Kanban columns now use `proposalStatusLabel(status)` too. The mini-
// kanban already only shows the CURRENT proposal per deal, so "Draft"
// implicitly means "the current proposal for this deal is in Draft"
// — no rename needed to make that clear.

type ColumnTone = {
  col: string; // container bg + border
  head: string; // header bg + border
  count: string; // count-pill bg + text
  accentBar: string; // 3px top accent on each card
};

/** Karan 2026-07-15 palette clean-up: every column is a white card with
 *  a single colored accent stripe at the top. The prior tinted-background
 *  variant (amber/pink/emerald/rose columns side by side) read as loud +
 *  disjointed; a row of white cards with color-coded spines reads like a
 *  proper GHL-style board. Tone stays semantic (rose = bad, emerald =
 *  won, blue = active, gray = neutral) but only in the 3px stripe + the
 *  count pill so the eye can scan the board at a glance. */
function toneForStatus(status: ProposalStatus): ColumnTone {
  const shared = {
    col: "bg-white border-ppp-charcoal-100",
    head: "bg-white border-ppp-charcoal-100",
  };
  switch (status) {
    case "draft":
      return {
        ...shared,
        count: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border border-ppp-charcoal-100",
        accentBar: "bg-slate-400",
      };
    case "pending_approval":
      return {
        ...shared,
        count: "bg-amber-50 text-amber-800 border border-amber-100",
        accentBar: "bg-amber-400",
      };
    case "sent":
      return {
        ...shared,
        count: "bg-cc-brand-50 text-cc-brand-800 border border-cc-brand-100",
        accentBar: "bg-cc-brand-500",
      };
    case "won":
      return {
        ...shared,
        count: "bg-emerald-50 text-emerald-800 border border-emerald-100",
        accentBar: "bg-emerald-500",
      };
    case "lost":
      return {
        ...shared,
        count: "bg-rose-50 text-rose-800 border border-rose-100",
        accentBar: "bg-rose-400",
      };
    case "expired":
      return {
        ...shared,
        count: "bg-amber-50 text-amber-700 border border-amber-100",
        accentBar: "bg-amber-500",
      };
    case "superseded":
    default:
      return {
        ...shared,
        count: "bg-ppp-charcoal-50 text-ppp-charcoal-500 border border-ppp-charcoal-100",
        accentBar: "bg-slate-300",
      };
  }
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

// ─────────────── page ───────────────

export default async function ProposalsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; view?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");

  const sp = await searchParams;
  const activeStatus =
    sp.status && (PROPOSAL_STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as ProposalStatus)
      : null;
  // Karan 2026-07-15: view=list gives a grouped-by-account list view
  // for when the kanban gets unmanageable with 50+ proposals. Default
  // remains kanban.
  const viewMode: "kanban" | "list" = sp.view === "list" ? "list" : "kanban";

  // Karan 2026-07-15: self-heal any deal↔proposal drift on load. Cheap
  // idempotent scan — for each non-terminal proposal, verify the
  // parent deal is in the derived column and fix if not. Existing rows
  // that pre-dated the auto-cascade get reconciled the first time the
  // user visits this page. Guarded so a delivery-phase deal never
  // gets yanked backward. See reconcileDealStatesFromProposals() docs.
  await reconcileDealStatesFromProposals().catch((err) => {
    console.warn("[proposals-page] reconcile failed:", err);
  });

  const sb = commercialDb();
  let query = sb
    .from("commercial_proposals")
    .select(
      `id, revision_number, status, total_cents, sent_at, updated_at, opportunity_id, header_json,
       opportunity:commercial_opportunities!inner(
         id, title, client_name, location_short, account_id, deleted_at,
         account:commercial_accounts!inner(id, company_name, deleted_at)
       )`
    )
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(300);
  if (activeStatus) query = query.eq("status", activeStatus);

  const [{ data }, accountsForPicker, oppsForPicker] = await Promise.all([
    query,
    listCommercialAccounts({}),
    listCommercialOpportunities({}),
  ]);

  const rows = ((data as unknown as ProposalRow[]) ?? []).filter((r) => {
    if (!r.opportunity || r.opportunity.deleted_at) return false;
    const acct = r.opportunity.account;
    return acct && !acct.deleted_at;
  });

  // Karan 2026-07-16: KPIs + chip counts must reflect CURRENT-ONLY
  // proposals, matching what the kanban actually renders. Prior version
  // counted every revision (so "Draft · 5" would show 5 total drafts
  // across all deals + revisions, but the kanban only rendered the
  // current draft per deal). Filter to the highest-revision proposal
  // per deal first, then bucket by status.
  const currentByDeal = new Map<string, ProposalRow>();
  for (const r of rows) {
    const key = r.opportunity?.id ?? r.opportunity_id;
    const existing = currentByDeal.get(key);
    if (!existing) {
      currentByDeal.set(key, r);
      continue;
    }
    // Tie-break on updated_at desc if revisions match (shouldn't).
    if (
      r.revision_number > existing.revision_number ||
      (r.revision_number === existing.revision_number &&
        r.updated_at > existing.updated_at)
    ) {
      currentByDeal.set(key, r);
    }
  }
  const currentRows = Array.from(currentByDeal.values());

  // Group current-only rows by status for the kanban columns +
  // chip counts. `rows` (all revisions) stays available for list-
  // view sub-tabs that need the full history.
  const byStatus = new Map<string, ProposalRow[]>();
  for (const r of currentRows) {
    const list = byStatus.get(r.status) ?? [];
    list.push(r);
    byStatus.set(r.status, list);
  }

  // Picker data — only Pre-Sale-open opps get "pickable" so Alex
  // can't start a proposal on a lost/no-bid deal. Source list is
  // PROPOSAL_ELIGIBLE_OPP_STATUSES so /commercial/proposals and the
  // account detail Proposals sub-tab stay in sync.
  const eligibleOppStatusSet = new Set(PROPOSAL_ELIGIBLE_OPP_STATUSES);
  const accountsById = new Map(accountsForPicker.map((a) => [a.id, a] as const));
  const pickerAccounts = accountsForPicker.map((a) => ({
    id: a.id,
    company_name: a.company_name,
  }));
  const pickerDeals = oppsForPicker
    .filter((o: CommercialOpportunity) => eligibleOppStatusSet.has(o.status))
    .map((o: CommercialOpportunity) => ({
      id: o.id,
      account_id: o.account_id,
      display_name:
        derivedOppName(o, accountsById.get(o.account_id)?.company_name ?? null) ||
        "(untitled deal)",
      status: o.status,
    }));

  // KPIs — computed from current-only rows (one per deal) so numbers
  // line up with what the kanban actually shows.
  const openCount = currentRows.filter((r) => !["superseded", "won", "lost", "expired"].includes(r.status)).length;
  const sentCount = currentRows.filter((r) => r.status === "sent").length;
  const wonCount = currentRows.filter((r) => r.status === "won").length;
  const outstandingCents = currentRows
    .filter((r) => r.status === "sent" || r.status === "pending_approval")
    .reduce((sum, r) => sum + r.total_cents, 0);

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700 mb-1.5">
            Proposal builder
          </div>
          <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">
            Proposals
          </h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1">
            Every revision on every deal, grouped by status. Click a card to open the editor.
            {" "}<span className="text-emerald-700 font-medium">Drag Sent cards into Won or Lost</span> to close out a bid.
            {" "}Dropped a card by mistake? Drag it back to Sent to reopen — the parent deal reopens too.
          </p>
        </div>
        <NewProposalPicker
          accounts={pickerAccounts}
          deals={pickerDeals}
          buttonLabel="+ New proposal"
        />
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Open" value={openCount.toString()} tone="charcoal" />
        <StatTile label="Sent · awaiting reply" value={sentCount.toString()} tone="brand" />
        <StatTile label="Won" value={wonCount.toString()} tone="emerald" />
        <StatTile label="Outstanding total" value={formatDollars(outstandingCents)} tone="brand" />
      </div>

      {/* View mode + status filter chips — same-URL swap */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusChip
            href={`/commercial/proposals${viewMode === "list" ? "?view=list" : ""}`}
            active={!activeStatus}
            label="All"
          />
          {PROPOSAL_STATUSES.filter((s) => s !== "superseded").map((s) => {
            const count = byStatus.get(s)?.length ?? 0;
            const suffix = viewMode === "list" ? `&view=list` : "";
            return (
              <StatusChip
                key={s}
                href={`/commercial/proposals?status=${s}${suffix}`}
                active={activeStatus === s}
                label={`${proposalStatusLabel(s)}${count > 0 ? ` · ${count}` : ""}`}
              />
            );
          })}
        </div>
        {/* Karan 2026-07-15: view toggle. Kanban is default; List
            is for high-volume days when 50 cards scrolling sideways
            is unreadable. */}
        <div className="inline-flex rounded-lg border border-ppp-charcoal-200 bg-white overflow-hidden text-[12px] font-semibold shrink-0">
          <Link
            href={`/commercial/proposals${activeStatus ? `?status=${activeStatus}` : ""}`}
            className={`px-3 py-1.5 inline-flex items-center gap-1.5 min-h-[36px] ${
              viewMode === "kanban"
                ? "bg-cc-brand-600 text-white"
                : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="12" rx="1" />
            </svg>
            Kanban
          </Link>
          <Link
            href={`/commercial/proposals?view=list${activeStatus ? `&status=${activeStatus}` : ""}`}
            className={`px-3 py-1.5 inline-flex items-center gap-1.5 min-h-[36px] border-l border-ppp-charcoal-200 ${
              viewMode === "list"
                ? "bg-cc-brand-600 text-white border-l-cc-brand-700"
                : "text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="4" cy="6" r="1" fill="currentColor" />
              <circle cx="4" cy="12" r="1" fill="currentColor" />
              <circle cx="4" cy="18" r="1" fill="currentColor" />
            </svg>
            List
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white border border-dashed border-ppp-charcoal-200 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal mb-1">
            No proposals yet{activeStatus ? ` in "${proposalStatusLabel(activeStatus)}"` : ""}.
          </p>
          <p className="text-[13px] text-ppp-charcoal-500 max-w-md mx-auto">
            Click <strong>+ New proposal</strong> above to pick a customer + deal and start the first revision.
          </p>
        </div>
      ) : viewMode === "list" ? (
        <ProposalsListView rows={rows} />
      ) : (
        <ProposalsKanbanDnDProvider>
          <AccountMiniKanbans rows={rows} />
        </ProposalsKanbanDnDProvider>
      )}

      <p className="text-[11px] text-ppp-charcoal-400">
        Showing most-recent 300 · {rows.length} row{rows.length === 1 ? "" : "s"} · updated newest first
      </p>
    </div>
  );
}

// ─────────────── column + card ───────────────

function ProposalColumn({
  status,
  rows,
  tone,
  width,
  compact = false,
  labelOverride,
}: {
  status: ProposalStatus;
  rows: ProposalRow[];
  tone: ColumnTone;
  width: string;
  compact?: boolean;
  labelOverride?: string;
}) {
  const total = rows.reduce((acc, r) => acc + r.total_cents, 0);
  return (
    <div
      className={`${width} border rounded-xl overflow-hidden flex flex-col shadow-sm ${tone.col}`}
    >
      {/* Karan 2026-07-15: colored accent stripe at the top of the
          column — the only tinted element on an otherwise-white board. */}
      <div className={`h-1 ${tone.accentBar}`} aria-hidden />
      <div className={`${compact ? "px-2 py-1.5" : "px-3 py-2"} border-b ${tone.head}`}>
        <div className="flex items-center justify-between gap-2">
          <span
            className={
              compact
                ? "text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal"
                : "text-[12px] font-bold text-ppp-charcoal"
            }
          >
            {labelOverride ?? proposalStatusLabel(status)}
          </span>
          <span
            className={`inline-flex items-center justify-center rounded-full font-semibold ${
              compact
                ? "min-w-[20px] h-4 px-1 text-[10px]"
                : "min-w-[24px] h-5 px-1.5 text-[11px]"
            } ${tone.count}`}
          >
            {rows.length}
          </span>
        </div>
        {!compact && total > 0 && (
          <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 tabular-nums">
            {formatDollars(total)} across {rows.length}
          </div>
        )}
      </div>
      {/* Karan 2026-07-15: max-h clamped to ~4 cards in compact mode
          (mini-kanban) or ~10 cards in full mode (legacy flat kanban).
          Prior 70vh caused a 500px-tall column per account row, which
          made the whole page feel like a scroll-hell — cards should
          feel tight against the account overline. */}
      <ul
        className={`p-1.5 space-y-1.5 overflow-y-auto min-h-[80px] ${
          compact ? "max-h-[260px]" : "max-h-[70vh]"
        }`}
      >
        {rows.length === 0 ? (
          <li className="text-[11px] text-ppp-charcoal-400 italic text-center py-4">
            {compact ? "—" : "No proposals here"}
          </li>
        ) : (
          renderRowsGroupedByAccount(rows, tone.accentBar, compact)
        )}
      </ul>
    </div>
  );
}

/** Karan 2026-07-15 (round 2): the per-account mini-kanban rework
 *  made the inline "Customer · N" cluster label redundant — every
 *  card inside a mini-kanban is already scoped to one account by
 *  construction. Just render the cards. */
function renderRowsGroupedByAccount(
  rows: ProposalRow[],
  accentBar: string,
  compact: boolean
): ReactNode[] {
  // Karan 2026-07-15 v3: rows arriving here are now already scoped to
  // ONE deal (the parent DealMiniKanban splits by deal), so no more
  // per-deal color coding needed inside a column. Just sort revs desc
  // so R11 shows above R10 above R9.
  const sorted = [...rows].sort((a, b) => b.revision_number - a.revision_number);
  return sorted.map((r) => (
    <ProposalDnDCard key={r.id} proposalId={r.id} sourceStatus={r.status}>
      <ProposalCard row={r} accentBar={accentBar} compact={compact} />
    </ProposalDnDCard>
  ));
}

function ProposalCard({
  row,
  accentBar,
  compact = false,
}: {
  row: ProposalRow;
  accentBar: string;
  compact?: boolean;
}) {
  const oppTitle =
    row.opportunity?.title?.trim() ||
    row.opportunity?.client_name?.trim() ||
    row.header_json?.project_name?.trim() ||
    "(untitled deal)";
  const gc =
    row.header_json?.gc_company?.trim() ||
    row.opportunity?.account?.company_name ||
    "(missing customer)";
  // Karan 2026-07-15: user's custom name for this specific revision —
  // "R11 · Warehouse Repaint" instead of just "R11". Editable on the
  // proposal editor as the "Project name" field on the header block.
  // Falls back to nothing if user hasn't named it — R# stays enough
  // to identify.
  const customName = row.header_json?.project_name?.trim() ?? "";
  const acctId = row.opportunity?.account_id ?? "";
  const dealId = row.opportunity?.id ?? row.opportunity_id;
  const editorHref = `/commercial/accounts/${acctId}/deals/${dealId}/proposal/${row.id}`;

  return (
    <li className="group bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      <div className={`h-1 ${accentBar}`} aria-hidden />
      {/* Karan 2026-07-16 (round 2): PDF icon is now INLINE next to
          the total in the header row. Absolute positioning kept
          overlapping the $-number no matter where we put it (compact
          cards are single-line, so top-right + bottom-right both
          landed on the total). Inline flex means no overlap ever, at
          the cost of always-visible chrome — that's the right trade. */}
      <div className={`flex items-baseline justify-between gap-2 ${compact ? "px-2 py-1.5" : "px-3 py-2.5"}`}>
        <Link
          href={editorHref}
          className="min-w-0 flex-1 flex items-baseline gap-1.5 hover:text-cc-brand-700"
        >
          <span
            className="text-[12.5px] font-bold text-ppp-charcoal truncate"
            title={customName || oppTitle}
          >
            {customName || oppTitle}
          </span>
          <span className="text-[10px] font-semibold text-ppp-charcoal-400 tabular-nums shrink-0">
            R{row.revision_number}
          </span>
        </Link>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[12px] font-semibold text-ppp-charcoal-800 tabular-nums">
            {formatDollars(row.total_cents)}
          </span>
          <a
            href={`/api/commercial/proposals/${row.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center w-5 h-5 rounded text-ppp-charcoal-400 hover:text-cc-brand-700 hover:bg-cc-brand-50"
            title="Open the customer PDF in a new tab"
            aria-label={`Open PDF for revision ${row.revision_number}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </a>
        </div>
      </div>
      {/* Captions row — deal title (custom-name mode), GC, sent date.
          Wrapped in its own Link so the whole caption block is
          clickable but doesn't nest an <a> inside another <a>. */}
      {(compact ? customName : true) && (
        <Link
          href={editorHref}
          className={`block hover:bg-ppp-charcoal-50 ${
            compact ? "px-2 pb-1.5" : "px-3 pb-2.5"
          }`}
        >
          {compact ? (
            customName && (
              <div
                className="text-[10.5px] text-ppp-charcoal-400 truncate"
                title={oppTitle}
              >
                {oppTitle}
              </div>
            )
          ) : (
            <>
              <div
                className="text-[12px] font-semibold text-ppp-charcoal truncate"
                title={gc}
              >
                {gc}
              </div>
              {customName && (
                <div
                  className="text-[11px] text-ppp-charcoal-500 truncate mt-0.5"
                  title={oppTitle}
                >
                  {oppTitle}
                </div>
              )}
              {row.sent_at && (
                <div className="text-[10px] text-ppp-charcoal-500 mt-1">
                  sent {formatShortDate(row.sent_at)}
                </div>
              )}
            </>
          )}
        </Link>
      )}
    </li>
  );
}

/** Karan 2026-07-15: matched the opportunities/dashboard KpiCard
 *  grammar. White card, colored left stripe, corner glow, big value.
 *  Consistent tile shape across every Commercial CC surface. */
function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "brand" | "emerald" | "charcoal" | "amber";
}) {
  const toneMap: Record<string, { border: string; glow: string; stripe: string }> = {
    brand: {
      border: "border-cc-brand-100",
      glow: "bg-cc-brand-100/60",
      stripe: "bg-gradient-to-b from-cc-brand-600 to-cc-brand-500",
    },
    emerald: {
      border: "border-emerald-100",
      glow: "bg-emerald-100/60",
      stripe: "bg-gradient-to-b from-emerald-600 to-emerald-500",
    },
    amber: {
      border: "border-amber-100",
      glow: "bg-amber-100/60",
      stripe: "bg-gradient-to-b from-amber-500 to-amber-400",
    },
    charcoal: {
      border: "border-ppp-charcoal-100",
      glow: "bg-ppp-charcoal-100/60",
      stripe: "bg-gradient-to-b from-ppp-charcoal-400 to-ppp-charcoal-300",
    },
  };
  const t = toneMap[tone] ?? toneMap.charcoal;
  return (
    <div
      className={`relative bg-white border ${t.border} rounded-xl px-4 py-3.5 overflow-hidden shadow-sm`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${t.stripe}`} />
      <span
        aria-hidden
        className={`absolute -top-8 -right-8 h-24 w-24 rounded-full blur-2xl ${t.glow}`}
      />
      <div className="relative">
        <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          {label}
        </div>
        <div className="text-2xl sm:text-3xl font-black text-ppp-charcoal mt-1 leading-tight tabular-nums">
          {value}
        </div>
      </div>
    </div>
  );
}

function StatusChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  const cls = active
    ? "bg-ppp-charcoal-900 text-white border-ppp-charcoal-900"
    : "bg-white text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50";
  return (
    <Link
      href={href}
      className={`inline-flex items-center px-3 py-1.5 rounded-full border text-[11px] font-semibold min-h-[32px] ${cls}`}
    >
      {label}
    </Link>
  );
}

// ─────────────── Shared account-color hue (Karan 2026-07-15) ───────────────
// Matches the /commercial/opportunities customer-board pattern —
// djb2 hash → HSL that skips the blue band so no account's border
// color collides with the cc-brand red used for section chrome.
// Consistent hue across kanban + list view so an account "reads"
// the same in either mode.
function hueForAccountId(accountId: string | null): number {
  const key = accountId || "__no_account__";
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  let hue = h % 300;
  if (hue >= 200) hue = (hue + 60) % 360;
  return hue;
}

function accountColorStyles(accountId: string | null): {
  border: { borderLeftColor: string };
  headerBg: { backgroundColor: string };
  avatar: { backgroundColor: string; color: string };
} {
  const hue = hueForAccountId(accountId);
  return {
    border: { borderLeftColor: `hsl(${hue}, 62%, 55%)` },
    headerBg: { backgroundColor: `hsl(${hue}, 62%, 96%)` },
    avatar: {
      backgroundColor: `hsl(${hue}, 55%, 88%)`,
      color: `hsl(${hue}, 55%, 28%)`,
    },
  };
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

// ─────────────── Per-account → per-deal mini-kanbans (Karan 2026-07-15 v3) ───────────────
// Structure Karan asked for:
//   Account collapsible section
//     └─ Deal A: its own mini-kanban strip
//     └─ Deal B: its own mini-kanban strip
//     ...
// Each account has one section; inside, each deal on that account gets
// its OWN mini-kanban so proposal revisions on different deals never
// cluster together. Removes the earlier "one shared kanban per account
// with color-separated cards" pattern that got confusing at 2+ deals.
//
// DnD context wraps the whole thing so any card can drag anywhere.

function AccountMiniKanbans({ rows }: { rows: ProposalRow[] }) {
  type DealBucket = {
    dealId: string;
    dealTitle: string;
    dealStatus: string;
    dealSubStatus: string | null;
    rows: ProposalRow[];
    byStatus: Map<string, ProposalRow[]>;
    openCount: number;
    outstandingCents: number;
    wonCents: number;
    // Karan 2026-07-16: total historical revisions for this deal — we
    // only render the current (highest revision) in the kanban, but
    // the header shows "· N older revisions" so history is discoverable.
    totalRevs: number;
  };
  type AcctBucket = {
    accountId: string;
    accountName: string;
    deals: Map<string, DealBucket>;
    totalRows: number;
    openCount: number;
    outstandingCents: number;
    wonCents: number;
  };
  const byAccount = new Map<string, AcctBucket>();
  // Karan 2026-07-16: FIRST-PASS — group all rows by deal so we can find
  // the "current" (highest revision_number) for each deal. The kanban
  // should show ONE card per deal (the current revision), NOT every
  // historical R1/R2/R3 revision — those live on the account page.
  // Match Option A cascade semantics: current = highest revision, period.
  type DealScratch = { dealId: string; rows: ProposalRow[] };
  const dealScratch = new Map<string, DealScratch>();
  for (const r of rows) {
    const dealId = r.opportunity?.id ?? "__nodeal__";
    let s = dealScratch.get(dealId);
    if (!s) {
      s = { dealId, rows: [] };
      dealScratch.set(dealId, s);
    }
    s.rows.push(r);
  }
  // SECOND-PASS — for each deal, pick the current (highest revision)
  // and build the account/deal buckets using ONLY that row.
  for (const scratch of dealScratch.values()) {
    // Pick highest revision_number as "current". Ties (shouldn't happen
    // — DB uniqueness on opportunity_id + revision_number) fall back to
    // most-recently-updated.
    const current = [...scratch.rows].sort((a, b) => {
      if (b.revision_number !== a.revision_number) {
        return b.revision_number - a.revision_number;
      }
      return b.updated_at.localeCompare(a.updated_at);
    })[0];
    if (!current) continue;
    const totalRevs = scratch.rows.length;

    const acctId = current.opportunity?.account?.id ?? "__none__";
    const acctName = current.opportunity?.account?.company_name ?? "(no customer)";
    const dealTitle =
      current.opportunity?.title?.trim() ||
      current.opportunity?.client_name?.trim() ||
      current.header_json?.project_name?.trim() ||
      "(untitled deal)";
    let acct = byAccount.get(acctId);
    if (!acct) {
      acct = {
        accountId: acctId,
        accountName: acctName,
        deals: new Map(),
        totalRows: 0,
        openCount: 0,
        outstandingCents: 0,
        wonCents: 0,
      };
      byAccount.set(acctId, acct);
    }
    // Total rev COUNT keeps history-awareness in the header
    // ("R7 · current · 6 older revisions"), but only the current
    // revision renders in the kanban columns.
    const deal: DealBucket = {
      dealId: scratch.dealId,
      dealTitle,
      dealStatus: "",
      dealSubStatus: null,
      rows: [current],
      byStatus: new Map([[current.status, [current]]]),
      openCount: 0,
      outstandingCents: 0,
      wonCents: 0,
      totalRevs,
    };
    if (!["superseded", "won", "lost", "expired"].includes(current.status)) {
      deal.openCount = 1;
      acct.openCount += 1;
    }
    if (current.status === "sent" || current.status === "pending_approval") {
      deal.outstandingCents = current.total_cents;
      acct.outstandingCents += current.total_cents;
    }
    if (current.status === "won") {
      deal.wonCents = current.total_cents;
      acct.wonCents += current.total_cents;
    }
    acct.deals.set(scratch.dealId, deal);
    acct.totalRows += 1;
  }
  const accts = Array.from(byAccount.values()).sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.accountName.localeCompare(b.accountName);
  });

  return (
    <div className="space-y-3">
      {accts.map((acct) => {
        const colors = accountColorStyles(acct.accountId);
        const dealList = Array.from(acct.deals.values()).sort(
          (a, b) => b.openCount - a.openCount || a.dealTitle.localeCompare(b.dealTitle)
        );
        return (
          <details
            key={acct.accountId}
            open
            className="group border border-ppp-charcoal-200 bg-white rounded-xl overflow-hidden border-l-4"
            style={colors.border}
          >
            <summary
              className="cursor-pointer px-4 py-3 hover:bg-ppp-charcoal-50/60 flex items-center justify-between gap-3 flex-wrap list-none [&::-webkit-details-marker]:hidden"
              style={colors.headerBg}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="shrink-0 w-9 h-9 rounded-full inline-flex items-center justify-center text-[12px] font-bold"
                  style={colors.avatar}
                  aria-hidden
                >
                  {initialsFor(acct.accountName)}
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/commercial/accounts/${acct.accountId}?tab=proposals`}
                    className="text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-700 truncate"
                  >
                    {acct.accountName}
                  </Link>
                  <div className="text-[11px] text-ppp-charcoal-500 tabular-nums">
                    {acct.deals.size} deal{acct.deals.size === 1 ? "" : "s"} · {acct.totalRows} proposal{acct.totalRows === 1 ? "" : "s"}
                    {acct.openCount > 0 && <> · {acct.openCount} open</>}
                    {acct.outstandingCents > 0 && (
                      <> · {formatDollars(acct.outstandingCents)} outstanding</>
                    )}
                    {acct.wonCents > 0 && (
                      <> · <span className="text-emerald-700">{formatDollars(acct.wonCents)} won</span></>
                    )}
                  </div>
                </div>
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
                className="shrink-0 text-ppp-charcoal-400 transition-transform group-open:rotate-180"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <div className="border-t border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100">
              {dealList.map((deal) => (
                <DealMiniKanban
                  key={deal.dealId}
                  deal={deal}
                  accountId={acct.accountId}
                />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** One deal's mini-kanban strip. Rendered inside the account
 *  collapsible section. Each deal has its own header (title + stats +
 *  quick-add-revision link) and its own kanban row. Cards inside are
 *  scoped to this deal, so no more cross-deal color confusion. */
function DealMiniKanban({
  deal,
  accountId,
}: {
  deal: {
    dealId: string;
    dealTitle: string;
    rows: ProposalRow[];
    byStatus: Map<string, ProposalRow[]>;
    openCount: number;
    outstandingCents: number;
    wonCents: number;
    totalRevs: number;
  };
  accountId: string;
}) {
  const dealHref = `/commercial/accounts/${accountId}?tab=deals&sub=opportunities#deal-row-${deal.dealId}`;
  // Karan 2026-07-16: header now says "current · N older" instead of
  // "N revs" — makes it explicit that older revisions are on the account
  // Proposals tab, not clogging the kanban.
  const olderCount = Math.max(0, deal.totalRevs - 1);
  return (
    <div className="bg-white">
      <div className="px-3 sm:px-4 pt-3 pb-1.5 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex items-center gap-2">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-ppp-charcoal-400" />
          <Link
            href={dealHref}
            className="text-[12.5px] font-bold text-ppp-charcoal hover:text-cc-brand-700 truncate"
            title={`Jump to ${deal.dealTitle} on the pipeline`}
          >
            {deal.dealTitle}
          </Link>
          <span className="text-[10.5px] text-ppp-charcoal-500 tabular-nums">
            · current
            {olderCount > 0 && (
              <>
                {" "}
                ·{" "}
                <Link
                  href={`/commercial/accounts/${accountId}?tab=proposals#deal-${deal.dealId}`}
                  className="text-ppp-charcoal-500 hover:text-cc-brand-700 underline underline-offset-2 decoration-dotted"
                  title={`See ${olderCount} older revision${olderCount === 1 ? "" : "s"} on the account Proposals tab`}
                >
                  {olderCount} older
                </Link>
              </>
            )}
            {deal.outstandingCents > 0 && <> · {formatDollars(deal.outstandingCents)} out</>}
            {deal.wonCents > 0 && (
              <> · <span className="text-emerald-700 font-semibold">{formatDollars(deal.wonCents)} won</span></>
            )}
          </span>
        </div>
        <Link
          href={`/commercial/accounts/${accountId}/deals/${deal.dealId}/proposal/new?bump=${deal.rows[0]?.id ?? ""}`}
          className="text-[10.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 shrink-0"
          title="Bump R+1: copies the current revision forward for edits"
        >
          + New revision
        </Link>
      </div>
      <div className="p-2 sm:p-3 pt-2">
        <div className="flex gap-2 items-stretch">
          {ACTIVE_COLUMNS.map((status) => (
            <ProposalDnDColumn key={status} status={status}>
              <ProposalColumn
                status={status}
                rows={deal.byStatus.get(status) ?? []}
                tone={toneForStatus(status)}
                width="flex-1 min-w-[120px]"
                compact
              />
            </ProposalDnDColumn>
          ))}
          <ProposalDnDColumn key="won" status="won">
            <ProposalColumn
              status="won"
              rows={deal.byStatus.get("won") ?? []}
              tone={toneForStatus("won")}
              width="flex-1 min-w-[120px]"
              compact
            />
          </ProposalDnDColumn>
          <div className="flex-1 min-w-[120px] border rounded-xl overflow-hidden flex flex-col bg-white border-ppp-charcoal-100">
            <div className="px-2 py-1.5 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-ppp-charcoal uppercase tracking-wide">
                  Closed
                </span>
                <span className="inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full bg-white text-ppp-charcoal-700 text-[10px] font-semibold border border-ppp-charcoal-100">
                  {CLOSED_TERMINAL.reduce(
                    (acc, s) => acc + (deal.byStatus.get(s)?.length ?? 0),
                    0
                  )}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1 p-1.5">
              {CLOSED_TERMINAL.map((status) => (
                <ProposalDnDColumn key={status} status={status}>
                  <ProposalColumn
                    status={status}
                    rows={deal.byStatus.get(status) ?? []}
                    tone={toneForStatus(status)}
                    width="w-full"
                    compact
                      />
                </ProposalDnDColumn>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────── List view (Karan 2026-07-15) ───────────────
// Groups proposals by account. Each account is a <details> card
// with color-coded left border (same hue helper as the mini-kanbans)
// so an account reads the same across both views. Collapsed by
// default beyond the first 3 to keep scroll manageable at 50+ rows.

const LIST_STATUS_PILL: Record<string, string> = {
  draft: "bg-ppp-charcoal-100 text-ppp-charcoal-700 border-ppp-charcoal-200",
  pending_approval: "bg-amber-50 text-amber-800 border-amber-200",
  sent: "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200",
  won: "bg-emerald-50 text-emerald-800 border-emerald-200",
  lost: "bg-rose-50 text-rose-800 border-rose-200",
  expired: "bg-rose-50 text-rose-800 border-rose-200",
  superseded: "bg-slate-50 text-slate-600 border-slate-200",
};

function ProposalsListView({ rows }: { rows: ProposalRow[] }) {
  // Group by account, then by deal within the account.
  type AcctBucket = {
    account_id: string;
    company_name: string;
    outstandingCents: number;
    wonCents: number;
    deals: Map<string, { deal: ProposalRow["opportunity"]; rows: ProposalRow[] }>;
  };
  const byAccount = new Map<string, AcctBucket>();
  for (const r of rows) {
    if (!r.opportunity?.account) continue;
    const acctId = r.opportunity.account.id;
    let bucket = byAccount.get(acctId);
    if (!bucket) {
      bucket = {
        account_id: acctId,
        company_name: r.opportunity.account.company_name,
        outstandingCents: 0,
        wonCents: 0,
        deals: new Map(),
      };
      byAccount.set(acctId, bucket);
    }
    if (r.status === "sent" || r.status === "pending_approval") {
      bucket.outstandingCents += r.total_cents;
    }
    if (r.status === "won") bucket.wonCents += r.total_cents;
    const dealKey = r.opportunity.id;
    let dealBucket = bucket.deals.get(dealKey);
    if (!dealBucket) {
      dealBucket = { deal: r.opportunity, rows: [] };
      bucket.deals.set(dealKey, dealBucket);
    }
    dealBucket.rows.push(r);
  }
  // Sort proposals within each deal by revision_number desc, then sort
  // deals within each account by most-recent activity, then sort
  // accounts by count of proposals desc (busy customers on top).
  for (const acct of byAccount.values()) {
    for (const deal of acct.deals.values()) {
      deal.rows.sort((a, b) => b.revision_number - a.revision_number);
    }
  }
  const sortedAccounts = Array.from(byAccount.values()).sort((a, b) => {
    const aTotal = Array.from(a.deals.values()).reduce((s, d) => s + d.rows.length, 0);
    const bTotal = Array.from(b.deals.values()).reduce((s, d) => s + d.rows.length, 0);
    if (aTotal !== bTotal) return bTotal - aTotal;
    return a.company_name.localeCompare(b.company_name);
  });

  return (
    <div className="space-y-3">
      {sortedAccounts.map((acct, idx) => {
        const totalProposals = Array.from(acct.deals.values()).reduce(
          (s, d) => s + d.rows.length,
          0
        );
        const colors = accountColorStyles(acct.account_id);
        // Default open the first 3; rest collapsed so 50+ accounts
        // don't produce a wall of scroll on page load. User can
        // expand any individual account by clicking its header.
        const defaultOpen = idx < 3;
        return (
          <details
            key={acct.account_id}
            open={defaultOpen}
            className="group bg-white border border-ppp-charcoal-200 rounded-xl overflow-hidden border-l-4"
            style={colors.border}
          >
            {/* Account header — clickable to collapse/expand */}
            <summary
              className="cursor-pointer px-4 py-2.5 hover:bg-ppp-charcoal-50/60 flex items-center justify-between gap-3 flex-wrap list-none [&::-webkit-details-marker]:hidden"
              style={colors.headerBg}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="shrink-0 w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold"
                  style={colors.avatar}
                  aria-hidden
                >
                  {initialsFor(acct.company_name)}
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/commercial/accounts/${acct.account_id}?tab=proposals`}
                    className="text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-700 truncate"
                  >
                    {acct.company_name}
                  </Link>
                  <div className="text-[11px] text-ppp-charcoal-500 tabular-nums">
                    {totalProposals} proposal{totalProposals === 1 ? "" : "s"} across{" "}
                    {acct.deals.size} deal{acct.deals.size === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap text-[11px] tabular-nums shrink-0">
                {acct.outstandingCents > 0 && (
                  <span className="text-cc-brand-800">
                    {formatDollars(acct.outstandingCents)} outstanding
                  </span>
                )}
                {acct.wonCents > 0 && (
                  <span className="text-emerald-700">
                    {formatDollars(acct.wonCents)} won
                  </span>
                )}
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
                  className="shrink-0 text-ppp-charcoal-400 transition-transform group-open:rotate-180"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </summary>
            {/* Deals within this account — each deal group gets its own
                left border tint (djb2 hue keyed by deal id) so a
                two-deal account reads as two visually distinct blocks
                even though they share the account section chrome. */}
            <div className="border-t border-ppp-charcoal-100 space-y-0.5 p-1">
              {Array.from(acct.deals.values()).map((dealBucket) => {
                if (!dealBucket.deal) return null;
                const dealTitle =
                  dealBucket.deal.title?.trim() ||
                  dealBucket.deal.client_name?.trim() ||
                  dealBucket.deal.location_short?.trim() ||
                  "(untitled deal)";
                const dealHue = hueForAccountId(dealBucket.deal.id);
                const dealBorderStyle = {
                  borderLeftColor: `hsl(${dealHue}, 62%, 55%)`,
                };
                const dealTintStyle = {
                  backgroundColor: `hsl(${dealHue}, 62%, 97%)`,
                };
                return (
                  <div
                    key={dealBucket.deal.id}
                    className="border-l-4 rounded-r-md overflow-hidden bg-white"
                    style={dealBorderStyle}
                  >
                    <div
                      className="px-4 py-2 text-[12px] font-bold text-ppp-charcoal border-b border-ppp-charcoal-100 flex items-center justify-between gap-2"
                      style={dealTintStyle}
                    >
                      <span className="truncate">{dealTitle}</span>
                      <span className="text-ppp-charcoal-500 font-normal shrink-0">
                        {dealBucket.rows.length} revision
                        {dealBucket.rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="divide-y divide-ppp-charcoal-100">
                      {dealBucket.rows.map((r) => {
                        const editorHref = `/commercial/accounts/${acct.account_id}/deals/${dealBucket.deal!.id}/proposal/${r.id}`;
                        const customName = r.header_json?.project_name?.trim();
                        return (
                          <li
                            key={r.id}
                            className="flex items-stretch hover:bg-ppp-charcoal-50/60"
                          >
                            <Link
                              href={editorHref}
                              className="flex items-center gap-3 px-4 py-2.5 min-h-[48px] flex-1 min-w-0"
                            >
                              <span className="text-[13px] font-bold text-ppp-charcoal tabular-nums shrink-0 w-8">
                                R{r.revision_number}
                              </span>
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${
                                  LIST_STATUS_PILL[r.status] ??
                                  "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200"
                                }`}
                              >
                                {proposalStatusLabel(r.status)}
                              </span>
                              {customName && (
                                <span
                                  className="text-[12px] font-semibold text-ppp-charcoal-800 truncate"
                                  title={customName}
                                >
                                  {customName}
                                </span>
                              )}
                              {r.header_json?.gc_company && !customName && (
                                <span className="text-[11.5px] text-ppp-charcoal-600 truncate">
                                  GC: {r.header_json.gc_company}
                                </span>
                              )}
                              {r.sent_at && (
                                <span className="text-[10.5px] text-ppp-charcoal-500 shrink-0 ml-auto">
                                  sent {formatShortDate(r.sent_at)}
                                </span>
                              )}
                              <span className="text-[13px] font-semibold text-ppp-charcoal-800 tabular-nums shrink-0 ml-2 w-20 text-right">
                                {formatDollars(r.total_cents)}
                              </span>
                            </Link>
                            <a
                              href={`/api/commercial/proposals/${r.id}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-3 text-[11px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 hover:bg-white border-l border-ppp-charcoal-100 shrink-0"
                              title="Open the customer PDF in a new tab"
                              aria-label={`Open PDF for revision ${r.revision_number}`}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden
                              >
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                              </svg>
                              <span className="hidden sm:inline">PDF</span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}
