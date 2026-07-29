/**
 * Submittals — the cross-account index (2026-07-28). Every live letter of
 * transmittal across every GC, awaiting-response floated to the top, each row a
 * jump into that submittal's detail. Submittals are created + edited per-deal
 * (on the opportunity's Submittals tab); this is the read/triage queue.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { listAllSubmittals, summarizeSubmittals, type SubmittalIndexRow } from "@/lib/commercial/opportunities/submittals-index";
import { submittalStatusLabel } from "@/lib/commercial/opportunities/submittal-constants";
import { KpiTile } from "@/components/commercial/kpi-tile";

type SP = Promise<{ q?: string; status?: string }>;

const STATUS_FILTERS = [
  { key: "", label: "Active" },
  { key: "submitted", label: "Submitted" },
  { key: "under_review", label: "Under review" },
  { key: "approved", label: "Approved" },
  { key: "revise_and_resubmit", label: "Revise" },
  { key: "all", label: "All" },
] as const;

function statusTone(status: string): string {
  switch (status) {
    case "approved":
    case "approved_as_noted":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "submitted":
    case "under_review":
      return "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200";
    case "revise_and_resubmit":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "rejected":
    case "voided":
      return "bg-rose-50 text-rose-700 border-rose-200";
    case "draft":
      return "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200";
    default:
      return "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200";
  }
}

export default async function SubmittalsIndexPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const search = typeof sp.q === "string" ? sp.q : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const rows = await listAllSubmittals({ search, status });
  const summary = summarizeSubmittals(rows);

  const qs = (next: Record<string, string>) => {
    const p = new URLSearchParams();
    if (next.q ?? search) p.set("q", next.q ?? search);
    const st = next.status ?? status;
    if (st) p.set("status", st);
    const s = p.toString();
    return `/commercial/post-job/submittals${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Submittals</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-1">Every letter of transmittal across all GCs — what&rsquo;s waiting on a response sits up top.</p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile label="Total submittals" value={String(summary.total)} sub="all live packages" tone="navy" icon={<IconDoc />} />
        <KpiTile label="Awaiting response" value={String(summary.awaiting)} sub={summary.awaiting > 0 ? "ball in the GC's court" : "all responded"} tone={summary.awaiting > 0 ? "blue" : "neutral"} icon={<IconClock />} />
        <KpiTile label="Approved" value={String(summary.approved)} sub="cleared to build" tone={summary.approved > 0 ? "emerald" : "neutral"} icon={<IconCheck />} />
        <KpiTile label="Revise & resubmit" value={String(summary.revised)} sub={summary.revised > 0 ? "needs another pass" : "none"} tone={summary.revised > 0 ? "amber" : "neutral"} icon={<IconRefresh />} />
      </div>

      {/* Filters */}
      <form className="flex items-center gap-2 flex-wrap" action="/commercial/post-job/submittals">
        <div className="relative flex-1 min-w-[200px]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input name="q" defaultValue={search} placeholder="Search submittals, GC, subject…" className="w-full pl-9 pr-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]" />
        </div>
        {status && <input type="hidden" name="status" value={status} />}
        <button type="submit" className="px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation">Search</button>
      </form>

      {/* Status chips */}
      <div className="-mx-1 overflow-x-auto overscroll-x-contain">
        <div className="flex items-center gap-1.5 px-1 min-w-max">
          {STATUS_FILTERS.map((f) => {
            const on = f.key === status;
            return (
              <Link
                key={f.key || "active"}
                href={qs({ status: f.key })}
                aria-current={on ? "page" : undefined}
                className={`inline-flex items-center px-3 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap min-h-[44px] transition-colors ${on ? "bg-cc-brand-600 text-white" : "bg-surface border border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800"}`}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <span aria-hidden className="mx-auto mb-3 inline-flex items-center justify-center h-12 w-12 rounded-full bg-ppp-charcoal-100 text-ppp-charcoal-400">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4" /></svg>
          </span>
          <p className="text-sm font-semibold text-ppp-charcoal">{search || status ? "No submittals match" : "No submittals yet"}</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Submittals are created on a deal&rsquo;s Submittals tab. They show up here across every GC.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <SubmittalRow key={r.id} r={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubmittalRow({ r }: { r: SubmittalIndexRow }) {
  const href = `/commercial/opportunities/${r.opportunityId}/submittals/${r.id}`;
  return (
    <li className="relative bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden hover:border-cc-brand-200 hover:shadow-sm transition-all">
      {r.awaiting && <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-ppp-blue-500" />}
      <Link href={href} className="block pl-4 pr-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[10px] text-ppp-navy-600">Submittal #{r.submittalNumber}{r.revisionNumber > 0 ? ` · R${r.revisionNumber}` : ""}</span>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9.5px] font-bold uppercase tracking-wide ${statusTone(r.status)}`}>
                {submittalStatusLabel(r.status)}
              </span>
            </div>
            <div className="text-[14px] font-bold text-ppp-charcoal leading-snug break-words mt-0.5">{r.reSubject || r.oppName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500 min-w-0">
              <span className="truncate font-medium">{r.accountName || r.oppName}</span>
              {r.toCompany && (
                <>
                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                  <span className="truncate">To {r.toCompany}</span>
                </>
              )}
              {r.itemCount > 0 && (
                <>
                  <span aria-hidden className="text-ppp-charcoal-300">·</span>
                  <span className="tabular-nums">{r.itemCount} item{r.itemCount === 1 ? "" : "s"}</span>
                </>
              )}
            </div>
          </div>
          <span aria-hidden className="text-ppp-charcoal-300 shrink-0 mt-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </span>
        </div>
      </Link>
    </li>
  );
}

function IconDoc() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h4" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 3" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5" />
    </svg>
  );
}
