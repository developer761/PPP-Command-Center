/**
 * (helper) Closeout index — grouped-by-account view built on the shared
 * PostJobToolIndex, so it reads like Change Orders + AIA. Kept in its own file
 * so the route page stays a thin server component.
 */
import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";
import { listAllCloseoutPackages } from "@/lib/commercial/closeout/db";
import { CLOSEOUT_STATUS_META } from "@/lib/commercial/closeout/constants";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

const TONE_MAP: Record<"charcoal" | "ppp-blue" | "emerald" | "rose", ToolStatusTone> = {
  charcoal: "neutral",
  "ppp-blue": "brand",
  emerald: "emerald",
  rose: "neutral",
};

export async function CloseoutGroupedIndex() {
  const [projects, packages] = await Promise.all([
    listProjects({ includeClosed: true }),
    listAllCloseoutPackages(),
  ]);
  // packages ordered updatedAt DESC → first seen per opp is the latest.
  const latestByOpp = new Map<string, (typeof packages)[number]>();
  for (const p of packages) if (!latestByOpp.has(p.opportunityId)) latestByOpp.set(p.opportunityId, p);

  const withPkg = projects.filter((p) => latestByOpp.has(p.opp.id)).length;

  return (
    <PostJobToolIndex
      title="Closeout & Warranty"
      subtitle="The close-out package you hand the GC when a job wraps — transmittal + checklist + warranty letter."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>}
      projects={projects}
      emptyHint="A close-out package is created on a project (a Won deal). Win a deal and it'll show here."
      status={(p: ProjectRow): { label: string; tone: ToolStatusTone } => {
        const pkg = latestByOpp.get(p.opp.id);
        if (!pkg) return { label: "Not started", tone: "neutral" };
        const meta = CLOSEOUT_STATUS_META[pkg.status];
        const pct = pkg.progressPct != null ? ` · ${pkg.progressPct}%` : "";
        return { label: `${meta.label}${pct}`, tone: TONE_MAP[meta.tone] };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/closeout/${p.opp.id}?back=/commercial/post-job/closeout`}
      kpis={
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Projects with a package" value={String(withPkg)} tone="emerald" />
          <Tile label="No package yet" value={String(projects.length - withPkg)} tone="neutral" />
        </div>
      }
    />
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "neutral" }) {
  const cls = tone === "emerald" ? "text-emerald-700" : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-4 py-3 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-black tabular-nums mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
