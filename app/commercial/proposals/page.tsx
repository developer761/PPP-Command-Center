/**
 * Global proposals list — Phase F.4 sidebar destination.
 *
 * Shows every non-superseded, non-soft-deleted proposal across all deals.
 * Alex uses this as an at-a-glance "what's out the door and awaiting a
 * response" surface. Each row links back to the deal-scoped editor.
 *
 * URL: /commercial/proposals[?status=<status>]
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { commercialDb } from "@/lib/commercial/db";
import {
  PROPOSAL_STATUSES,
  proposalStatusLabel,
  type ProposalStatus,
} from "@/lib/commercial/proposals/constants";

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
    account_id: string;
    account: { id: string; company_name: string } | null;
  } | null;
};

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function statusPillCls(status: string): string {
  switch (status) {
    case "sent":
      return "bg-cc-brand-50 text-cc-brand-800 border-cc-brand-200";
    case "won":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "lost":
    case "expired":
      return "bg-rose-50 text-rose-800 border-rose-200";
    case "pending_approval":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "superseded":
      return "bg-ppp-charcoal-50 text-ppp-charcoal-500 border-ppp-charcoal-200";
    default:
      return "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200";
  }
}

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
         id, title, client_name, account_id,
         account:commercial_accounts!inner(id, company_name, deleted_at)
       )`
    )
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (activeStatus) query = query.eq("status", activeStatus);

  const { data } = await query;
  const rows = ((data as unknown as ProposalRow[]) ?? []).filter((r) => {
    // Skip proposals whose parent opp or account is soft-deleted (the
    // FK join succeeds but the row is a data leak otherwise).
    const acct = r.opportunity?.account as unknown as
      | { deleted_at?: string | null }
      | null;
    return acct && !acct.deleted_at;
  });

  const openCount = rows.filter((r) => !["superseded", "won", "lost", "expired"].includes(r.status)).length;
  const sentCount = rows.filter((r) => r.status === "sent").length;
  const pendingApprovalCount = rows.filter((r) => r.status === "pending_approval").length;
  const totalOutstandingCents = rows
    .filter((r) => r.status === "sent" || r.status === "pending_approval")
    .reduce((sum, r) => sum + r.total_cents, 0);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700 mb-1.5">
            Proposal builder
          </div>
          <h1 className="text-xl font-bold tracking-tight text-ppp-charcoal">
            Proposals
          </h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1">
            Every revision on every deal, newest first.
          </p>
        </div>
        <Link
          href="/commercial/accounts"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ppp-charcoal-200 bg-white text-ppp-charcoal-700 text-sm font-semibold hover:bg-ppp-charcoal-50 min-h-[40px]"
        >
          Pick a deal to start a proposal →
        </Link>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Open" value={openCount.toString()} tone="brand" />
        <StatTile label="Sent" value={sentCount.toString()} tone="brand" />
        <StatTile label="Pending approval" value={pendingApprovalCount.toString()} tone="amber" />
        <StatTile label="Outstanding total" value={formatDollars(totalOutstandingCents)} tone="charcoal" />
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusChip href="/commercial/proposals" active={!activeStatus} label="All" />
        {PROPOSAL_STATUSES.map((s) => (
          <StatusChip
            key={s}
            href={`/commercial/proposals?status=${s}`}
            active={activeStatus === s}
            label={proposalStatusLabel(s)}
          />
        ))}
      </div>

      {/* Table / empty state */}
      {rows.length === 0 ? (
        <div className="bg-white border border-dashed border-ppp-charcoal-200 rounded-xl p-8 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal mb-1">
            No proposals yet{activeStatus ? ` in "${proposalStatusLabel(activeStatus)}"` : ""}.
          </p>
          <p className="text-[13px] text-ppp-charcoal-500 max-w-md mx-auto">
            Open a deal on an account and click <em>Start proposal</em> to build the first revision.
          </p>
        </div>
      ) : (
        <ul className="bg-white border border-ppp-charcoal-100 rounded-xl divide-y divide-ppp-charcoal-100 overflow-hidden">
          {rows.map((r) => {
            const oppTitle =
              r.opportunity?.title?.trim() ||
              r.opportunity?.client_name?.trim() ||
              r.header_json?.project_name?.trim() ||
              "(untitled deal)";
            const acctName = r.opportunity?.account?.company_name ?? "(missing customer)";
            const acctId = r.opportunity?.account_id ?? "";
            const dealId = r.opportunity?.id ?? r.opportunity_id;
            const editorHref = `/commercial/accounts/${acctId}/deals/${dealId}/proposal/${r.id}`;
            return (
              <li key={r.id} className="flex items-stretch hover:bg-ppp-charcoal-50">
                <Link
                  href={editorHref}
                  className="flex items-center gap-3 px-4 py-3 min-h-[56px] flex-1 min-w-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-ppp-charcoal">R{r.revision_number}</span>
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${statusPillCls(r.status)}`}>
                        {proposalStatusLabel(r.status)}
                      </span>
                      <span className="text-[13px] text-ppp-charcoal-800 font-medium truncate">
                        {oppTitle}
                      </span>
                    </div>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 truncate">
                      {acctName}
                      {r.sent_at && (
                        <>
                          {" · "}
                          sent {new Date(r.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}
                        </>
                      )}
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-ppp-charcoal-800 tabular-nums shrink-0">
                    {formatDollars(r.total_cents)}
                  </span>
                </Link>
                <a
                  href={`/api/commercial/proposals/${r.id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-3 text-[11px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 hover:bg-white border-l border-ppp-charcoal-100 shrink-0"
                  title="Open the customer PDF in a new tab"
                  aria-label={`Open PDF for revision ${r.revision_number}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="hidden sm:inline">PDF</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] text-ppp-charcoal-400">
        Showing most-recent 200 · {rows.length} row{rows.length === 1 ? "" : "s"} · updated newest first
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "brand" | "amber" | "charcoal";
}) {
  const bg =
    tone === "brand"
      ? "bg-cc-brand-50 border-cc-brand-200 text-cc-brand-800"
      : tone === "amber"
        ? "bg-amber-50 border-amber-200 text-amber-800"
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
