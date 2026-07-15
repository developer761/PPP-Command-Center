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
  proposalStatusLabel,
  type ProposalStatus,
} from "@/lib/commercial/proposals/constants";
import NewProposalPicker from "@/components/commercial/new-proposal-picker";

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
  searchParams: Promise<{ status?: string }>;
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

  // Picker data — only open opps get "pickable" so Alex can't start a
  // proposal on a lost/no-bid deal.
  const OPEN_OPP_STATUSES = new Set([
    "solicitation",
    "qualifying",
    "estimating",
    "proposal",
    "follow_up",
  ]);
  const pickerAccounts = accountsForPicker.map((a) => ({
    id: a.id,
    company_name: a.company_name,
  }));
  const pickerDeals = oppsForPicker
    .filter((o: CommercialOpportunity) => OPEN_OPP_STATUSES.has(o.status))
    .map((o: CommercialOpportunity) => ({
      id: o.id,
      account_id: o.account_id,
      display_name: derivedOppName(
        o,
        accountsForPicker.find((a) => a.id === o.account_id)?.company_name ?? null
      ),
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
            Every revision on every deal, grouped by status. Drop into any card to open the editor.
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

      {/* Optional status filter chips — same-URL swap */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip href="/commercial/proposals" active={!activeStatus} label="All" />
        {PROPOSAL_STATUSES.map((s) => {
          const count = byStatus.get(s)?.length ?? 0;
          return (
            <StatusChip
              key={s}
              href={`/commercial/proposals?status=${s}`}
              active={activeStatus === s}
              label={`${proposalStatusLabel(s)}${count > 0 ? ` · ${count}` : ""}`}
            />
          );
        })}
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
      ) : (
        <div className="overflow-x-auto -mx-3 sm:-mx-6 px-3 sm:px-6 pb-2">
          <div className="flex gap-3 min-w-max items-stretch">
            {/* Active columns — Draft → Pending → Sent */}
            {ACTIVE_COLUMNS.map((status) => (
              <ProposalColumn
                key={status}
                status={status}
                rows={byStatus.get(status) ?? []}
                tone={toneForStatus(status)}
                width="w-64 sm:w-72"
              />
            ))}

            {/* Won — the moment Alex cares about */}
            <ProposalColumn
              key="won"
              status="won"
              rows={byStatus.get("won") ?? []}
              tone={toneForStatus("won")}
              width="w-64 sm:w-72"
            />

            {/* Closed cluster — Lost / Expired / Superseded stack narrow */}
            <div className="shrink-0 border rounded-xl overflow-hidden flex flex-col bg-white border-ppp-charcoal-100">
              <div className="px-3 py-2 border-b border-ppp-charcoal-100 bg-ppp-charcoal-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-bold text-ppp-charcoal uppercase tracking-wide">
                    Closed
                  </span>
                  <span className="inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full bg-white text-ppp-charcoal-700 text-[11px] font-semibold border border-ppp-charcoal-100">
                    {CLOSED_TERMINAL.reduce((acc, s) => acc + (byStatus.get(s)?.length ?? 0), 0)}
                  </span>
                </div>
                <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                  Not-awarded / newer revision replaced them
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 p-2">
                {CLOSED_TERMINAL.map((status) => (
                  <ProposalColumn
                    key={status}
                    status={status}
                    rows={byStatus.get(status) ?? []}
                    tone={toneForStatus(status)}
                    width="w-full sm:w-44 lg:w-48"
                    compact
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
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
    <div className={`${width} shrink-0 border rounded-xl overflow-hidden flex flex-col ${tone.col}`}>
      <div className={`px-3 py-2 border-b ${tone.head}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[${compact ? "11px" : "12px"}] font-bold ${compact ? "uppercase tracking-wide" : "text-ppp-charcoal"}`}>
            {proposalStatusLabel(status)}
          </span>
          <span className={`inline-flex items-center justify-center min-w-[${compact ? "20px" : "24px"}] h-${compact ? "4" : "5"} px-1.5 rounded-full ${tone.count} text-[${compact ? "10px" : "11px"}] font-semibold`}>
            {rows.length}
          </span>
        </div>
        {!compact && total > 0 && (
          <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 tabular-nums">
            {formatDollars(total)} across {rows.length}
          </div>
        )}
      </div>
      <ul className="p-2 space-y-2 overflow-y-auto max-h-[70vh] min-h-[100px]">
        {rows.length === 0 ? (
          <li className="text-[11px] text-ppp-charcoal-400 italic text-center py-6">
            {compact ? "—" : "No proposals here"}
          </li>
        ) : (
          rows.map((r) => (
            <ProposalCard key={r.id} row={r} accentBar={tone.accentBar} />
          ))
        )}
      </ul>
    </div>
  );
}

function ProposalCard({ row, accentBar }: { row: ProposalRow; accentBar: string }) {
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
    <li className="relative bg-white border border-ppp-charcoal-100 rounded-lg overflow-hidden hover:shadow-md transition-shadow">
      <div className={`h-1 ${accentBar}`} aria-hidden />
      <Link href={editorHref} className="block px-3 py-2.5 hover:bg-ppp-charcoal-50">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-[13px] font-bold text-ppp-charcoal tabular-nums">
            R{row.revision_number}
          </span>
          <span className="text-[13px] font-semibold text-ppp-charcoal-800 tabular-nums shrink-0">
            {formatDollars(row.total_cents)}
          </span>
        </div>
        <div className="text-[12px] font-semibold text-ppp-charcoal truncate" title={gc}>
          {gc}
        </div>
        <div className="text-[11px] text-ppp-charcoal-500 truncate mt-0.5" title={oppTitle}>
          {oppTitle}
        </div>
        {row.sent_at && (
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
