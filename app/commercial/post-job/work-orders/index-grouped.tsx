/**
 * (helper) Work Orders index — grouped-by-account view on the shared
 * PostJobToolIndex, so it reads like the other Post-Contract queues. Status:
 * Not created / Draft / Sent to Field Ops.
 */
import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";
import { listAllWorkOrders } from "@/lib/commercial/work-orders/db";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

export async function WorkOrdersGroupedIndex() {
  const [projects, workOrders] = await Promise.all([
    listProjects({ includeClosed: true }),
    listAllWorkOrders(),
  ]);
  const byOpp = new Map<string, (typeof workOrders)[number]>();
  for (const w of workOrders) if (!byOpp.has(w.opportunity_id)) byOpp.set(w.opportunity_id, w);

  const created = projects.filter((p) => byOpp.has(p.opp.id)).length;
  const sent = projects.filter((p) => byOpp.get(p.opp.id)?.status === "sent").length;
  const drafts = created - sent;

  return (
    <PostJobToolIndex
      title="Work Orders"
      subtitle="The crew's marching-orders sheet — scope + room-finish schedule, autofilled from the accepted proposal."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>}
      projects={projects}
      emptyHint="A Work Order is created on a project. Win an opportunity and start one, and it'll show here."
      status={(p: ProjectRow): { label: string; tone: ToolStatusTone } => {
        const w = byOpp.get(p.opp.id);
        if (!w) return { label: "Not created", tone: "neutral" };
        if (w.status === "sent") return { label: "Sent to Field Ops", tone: "emerald" };
        return { label: "Draft", tone: "neutral" };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/work-order/${p.opp.id}?back=/commercial/post-job/work-orders`}
      accent="navy"
      kpis={
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Sent to Field Ops" value={String(sent)} tone={sent > 0 ? "emerald" : "neutral"} />
          <Tile label="Draft" value={String(drafts)} tone={drafts > 0 ? "amber" : "neutral"} />
          <Tile label="Created" value={String(created)} tone="neutral" />
          <Tile label="Not created" value={String(projects.length - created)} tone="neutral" />
        </div>
      }
    />
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "amber" | "neutral" }) {
  const cls = tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-black tabular-nums mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
