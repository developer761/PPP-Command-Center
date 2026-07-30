/**
 * Change Orders — cross-account index (sidebar tab). Every project grouped by
 * account with its change-order status; tap one to open that project's change
 * orders. Same data (`listProjects`) as the Projects tab + account, so the
 * pending-CO counts always agree.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { listProjects } from "@/lib/commercial/projects/db";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

export const dynamic = "force-dynamic";

export default async function ChangeOrdersIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const projects = await listProjects({ includeClosed: true });
  const totalPending = projects.reduce((s, p) => s + p.pendingCoCount, 0);
  const totalPendingCents = projects.reduce((s, p) => s + p.pendingCoCents, 0);
  const totalNet = projects.reduce((s, p) => s + p.netApprovedCoCents, 0);
  const projectsWithCos = projects.filter((p) => p.pendingCoCount > 0 || p.netApprovedCoCents !== 0).length;

  return (
    <PostJobToolIndex
      title="Change Orders"
      subtitle="Scope added or deducted mid-job — approved change orders adjust the contract sum."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5" /></svg>}
      projects={projects}
      emptyHint="Change orders live on a project (a Won deal). Win a deal and it'll show here."
      status={(p): { label: string; tone: ToolStatusTone } => {
        if (p.pendingCoCount > 0) return { label: `${p.pendingCoCount} pending`, tone: "amber" };
        if (p.netApprovedCoCents !== 0) return { label: `${p.netApprovedCoCents < 0 ? "−" : "+"}${formatCentsCompact(Math.abs(p.netApprovedCoCents))}`, tone: "emerald" };
        return { label: "No COs", tone: "neutral" };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/change-orders/${p.opp.id}?back=/commercial/post-job/change-orders`}
      kpis={
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Pending change orders" value={String(totalPending)} tone={totalPending > 0 ? "amber" : "neutral"} />
          <Tile label="Pending value" value={formatCentsCompact(totalPendingCents)} tone={totalPendingCents > 0 ? "amber" : "neutral"} />
          <Tile label="Net approved (all projects)" value={`${totalNet < 0 ? "−" : ""}${formatCentsCompact(Math.abs(totalNet))}`} tone={totalNet < 0 ? "rose" : "emerald"} />
          <Tile label="Projects with COs" value={String(projectsWithCos)} tone="neutral" />
        </div>
      }
    />
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "amber" | "emerald" | "rose" | "neutral" }) {
  const cls = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-black tabular-nums mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
