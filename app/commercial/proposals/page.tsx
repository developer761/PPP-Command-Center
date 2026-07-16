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
const CLOSED_TERMINAL: ProposalStatus[] = ["lost", "expired", "superseded"];

type ColumnTone = {
  col: string; // container bg + border
  head: string; // header bg + border
  count: string; // count-pill bg + text
  accentBar: string; // 3px top accent on each card
};

function toneForStatus(status: ProposalStatus): ColumnTone {
  switch (status) {
    case "draft":
      return {
        col: "bg-ppp-charcoal-50/60 border-ppp-charcoal-100",
        head: "bg-white border-ppp-charcoal-100",
        count: "bg-ppp-charcoal-100 text-ppp-charcoal-700",
        accentBar: "bg-ppp-charcoal-300",
      };
    case "pending_approval":
      return {
        col: "bg-amber-50/40 border-amber-200",
        head: "bg-amber-50 border-amber-200",
        count: "bg-amber-100 text-amber-800",
        accentBar: "bg-amber-400",
      };
    case "sent":
      return {
        col: "bg-cc-brand-50/40 border-cc-brand-200",
        head: "bg-cc-brand-50 border-cc-brand-200",
        count: "bg-cc-brand-100 text-cc-brand-800",
        accentBar: "bg-cc-brand-500",
      };
    case "won":
      return {
        col: "bg-emerald-50/40 border-emerald-200",
        head: "bg-emerald-50 border-emerald-200",
        count: "bg-emerald-100 text-emerald-800",
        accentBar: "bg-emerald-500",
      };
    case "lost":
      return {
        col: "bg-rose-50/40 border-rose-200",
        head: "bg-rose-100 border-rose-200 text-rose-800",
        count: "bg-white/70 text-rose-800",
        accentBar: "bg-rose-400",
      };
    case "expired":
      return {
        col: "bg-amber-50/50 border-amber-200",
        head: "bg-amber-100 border-amber-200 text-amber-800",
        count: "bg-white/70 text-amber-800",
        accentBar: "bg-amber-500",
      };
    case "superseded":
    default:
      return {
        col: "bg-slate-50 border-slate-200",
        head: "bg-slate-100 border-slate-200 text-slate-700",
        count: "bg-white/70 text-slate-700",
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

  // Group rows by status for the kanban columns.
  const byStatus = new Map<string, ProposalRow[]>();
  for (const r of rows) {
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

  // KPIs
  const openCount = rows.filter((r) => !["superseded", "won", "lost", "expired"].includes(r.status)).length;
  const sentCount = rows.filter((r) => r.status === "sent").length;
  const wonCount = rows.filter((r) => r.status === "won").length;
  const outstandingCents = rows
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
          {PROPOSAL_STATUSES.map((s) => {
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
}: {
  status: ProposalStatus;
  rows: ProposalRow[];
  tone: ColumnTone;
  width: string;
  compact?: boolean;
}) {
  const total = rows.reduce((acc, r) => acc + r.total_cents, 0);
  return (
    <div
      className={`${width} border rounded-xl overflow-hidden flex flex-col ${tone.col}`}
    >
      <div className={`${compact ? "px-2 py-1.5" : "px-3 py-2"} border-b ${tone.head}`}>
        <div className="flex items-center justify-between gap-2">
          <span
            className={
              compact
                ? "text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal"
                : "text-[12px] font-bold text-ppp-charcoal"
            }
          >
            {proposalStatusLabel(status)}
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
  return rows.map((r) => (
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
  const acctId = row.opportunity?.account_id ?? "";
  const dealId = row.opportunity?.id ?? row.opportunity_id;
  const editorHref = `/commercial/accounts/${acctId}/deals/${dealId}/proposal/${row.id}`;

  return (
    <li className="group relative bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      <div className={`h-1 ${accentBar}`} aria-hidden />
      {/* Karan 2026-07-15: compact mode collapses the GC line (redundant
          inside a per-account row) and shrinks padding so cards feel
          tight — the mini-kanban row is already scoped to one account,
          so the company name every row was pure noise. */}
      <Link
        href={editorHref}
        className={`block hover:bg-ppp-charcoal-50 ${
          compact ? "px-2 py-1.5" : "px-3 py-2.5"
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-bold text-ppp-charcoal tabular-nums">
            R{row.revision_number}
          </span>
          <span className="text-[12px] font-semibold text-ppp-charcoal-800 tabular-nums shrink-0">
            {formatDollars(row.total_cents)}
          </span>
        </div>
        {compact ? (
          <div
            className="text-[11px] text-ppp-charcoal-600 truncate mt-0.5"
            title={oppTitle}
          >
            {oppTitle}
          </div>
        ) : (
          <>
            <div
              className="text-[12px] font-semibold text-ppp-charcoal truncate mt-1"
              title={gc}
            >
              {gc}
            </div>
            <div
              className="text-[11px] text-ppp-charcoal-500 truncate mt-0.5"
              title={oppTitle}
            >
              {oppTitle}
            </div>
          </>
        )}
        {row.sent_at && !compact && (
          <div className="text-[10px] text-ppp-charcoal-500 mt-1">
            sent {formatShortDate(row.sent_at)}
          </div>
        )}
      </Link>
      <a
        href={`/api/commercial/proposals/${row.id}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-2 right-2 inline-flex items-center justify-center w-7 h-7 rounded-md bg-white/90 hover:bg-cc-brand-50 border border-ppp-charcoal-200 text-ppp-charcoal-500 hover:text-cc-brand-700 opacity-0 group-hover:opacity-100 focus:opacity-100"
        title="Open the customer PDF in a new tab"
        aria-label={`Open PDF for revision ${row.revision_number}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </a>
    </li>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "brand" | "emerald" | "charcoal";
}) {
  const bg =
    tone === "brand"
      ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-800"
      : tone === "emerald"
        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
        : "bg-white border-ppp-charcoal-200 text-ppp-charcoal-800";
  return (
    <div className={`border rounded-xl px-4 py-3 ${bg}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{label}</div>
      <div className="text-lg font-bold tabular-nums mt-1">{value}</div>
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

// ─────────────── Per-account mini-kanban boards (Karan 2026-07-15) ───────────────
// Replaces the flat single kanban that mixed all accounts together.
// Each account gets its own collapsible <details> card with a mini-
// kanban strip inside (Draft → Pending → Sent → Won + Closed cluster).
// Scales cleanly to 50+ proposals — Alex collapses accounts he isn't
// working on and expands the one he's focused on. Color-coded left
// border per account (deterministic hue from account_id) matches the
// opportunities customer-board grammar so the same customer reads
// visually consistent across surfaces.
//
// DnD context wraps the whole thing so any card can be dragged
// within its own account's mini-kanban (Sent → Won / Sent → Lost /
// Won → Sent reopen).

function AccountMiniKanbans({ rows }: { rows: ProposalRow[] }) {
  type Bucket = {
    accountId: string;
    accountName: string;
    rows: ProposalRow[];
    byStatus: Map<string, ProposalRow[]>;
    openCount: number;
    outstandingCents: number;
    wonCents: number;
  };
  const byAccount = new Map<string, Bucket>();
  for (const r of rows) {
    const acctId = r.opportunity?.account?.id ?? "__none__";
    const acctName = r.opportunity?.account?.company_name ?? "(no customer)";
    let bucket = byAccount.get(acctId);
    if (!bucket) {
      bucket = {
        accountId: acctId,
        accountName: acctName,
        rows: [],
        byStatus: new Map(),
        openCount: 0,
        outstandingCents: 0,
        wonCents: 0,
      };
      byAccount.set(acctId, bucket);
    }
    bucket.rows.push(r);
    const list = bucket.byStatus.get(r.status) ?? [];
    list.push(r);
    bucket.byStatus.set(r.status, list);
    if (!["superseded", "won", "lost", "expired"].includes(r.status)) bucket.openCount += 1;
    if (r.status === "sent" || r.status === "pending_approval") {
      bucket.outstandingCents += r.total_cents;
    }
    if (r.status === "won") bucket.wonCents += r.total_cents;
  }
  const buckets = Array.from(byAccount.values()).sort((a, b) => {
    // Busy customers first — sort by open count desc, then alpha.
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.accountName.localeCompare(b.accountName);
  });

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => {
        const colors = accountColorStyles(bucket.accountId);
        return (
          <details
            key={bucket.accountId}
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
                  className="shrink-0 w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-bold"
                  style={colors.avatar}
                  aria-hidden
                >
                  {initialsFor(bucket.accountName)}
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/commercial/accounts/${bucket.accountId}?tab=proposals`}
                    className="text-[14px] font-bold text-ppp-charcoal hover:text-cc-brand-700 truncate"
                  >
                    {bucket.accountName}
                  </Link>
                  <div className="text-[11px] text-ppp-charcoal-500 tabular-nums">
                    {bucket.rows.length} proposal{bucket.rows.length === 1 ? "" : "s"}
                    {bucket.openCount > 0 && <> · {bucket.openCount} open</>}
                    {bucket.outstandingCents > 0 && (
                      <> · {formatDollars(bucket.outstandingCents)} outstanding</>
                    )}
                    {bucket.wonCents > 0 && (
                      <> · <span className="text-emerald-700">{formatDollars(bucket.wonCents)} won</span></>
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
            {/* Karan 2026-07-15 rework: columns now flex-1 across the
                container width instead of fixed 240px — no horizontal
                scroll, uses the whole row. Compact mode kills the total
                subtitle in each column header (redundant inside a per-
                account row) and slims the pills. Max-height clamped so
                the tallest column doesn't blow up the row. */}
            <div className="border-t border-ppp-charcoal-100 p-2 sm:p-3">
              <div className="flex gap-2 items-stretch">
                {ACTIVE_COLUMNS.map((status) => (
                  <ProposalDnDColumn key={status} status={status}>
                    <ProposalColumn
                      status={status}
                      rows={bucket.byStatus.get(status) ?? []}
                      tone={toneForStatus(status)}
                      width="flex-1 min-w-[130px]"
                      compact
                    />
                  </ProposalDnDColumn>
                ))}
                <ProposalDnDColumn key="won" status="won">
                  <ProposalColumn
                    status="won"
                    rows={bucket.byStatus.get("won") ?? []}
                    tone={toneForStatus("won")}
                    width="flex-1 min-w-[130px]"
                    compact
                  />
                </ProposalDnDColumn>
                {/* Closed cluster — Lost is a valid drop target
                    (routes to debrief). Expired / Replaced are read-
                    only auto-computed states, not manual outcomes. */}
                <div className="flex-1 min-w-[130px] border rounded-xl overflow-hidden flex flex-col bg-white border-ppp-charcoal-100">
                  <div className="px-2 py-1.5 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-ppp-charcoal uppercase tracking-wide">
                        Closed
                      </span>
                      <span className="inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full bg-white text-ppp-charcoal-700 text-[10px] font-semibold border border-ppp-charcoal-100">
                        {CLOSED_TERMINAL.reduce(
                          (acc, s) => acc + (bucket.byStatus.get(s)?.length ?? 0),
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
                          rows={bucket.byStatus.get(status) ?? []}
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
          </details>
        );
      })}
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
            {/* Deals within this account — each with its own inner header */}
            <div className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
              {Array.from(acct.deals.values()).map((dealBucket) => {
                if (!dealBucket.deal) return null;
                const dealTitle =
                  dealBucket.deal.title?.trim() ||
                  dealBucket.deal.client_name?.trim() ||
                  dealBucket.deal.location_short?.trim() ||
                  "(untitled deal)";
                return (
                  <div key={dealBucket.deal.id}>
                    <div className="px-4 py-1.5 bg-white text-[11px] font-semibold text-ppp-charcoal-600 uppercase tracking-wide border-b border-ppp-charcoal-100">
                      {dealTitle}
                      <span className="ml-2 text-ppp-charcoal-400 font-normal normal-case tracking-normal">
                        · {dealBucket.rows.length} revision
                        {dealBucket.rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="divide-y divide-ppp-charcoal-100">
                      {dealBucket.rows.map((r) => {
                        const editorHref = `/commercial/accounts/${acct.account_id}/deals/${dealBucket.deal!.id}/proposal/${r.id}`;
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
                              {r.header_json?.gc_company && (
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
