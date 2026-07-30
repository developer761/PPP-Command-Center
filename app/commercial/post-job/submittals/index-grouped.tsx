/**
 * (helper) Submittals index — grouped-by-account view built on the shared
 * PostJobToolIndex, consistent with Change Orders / AIA / Closeout. Kept out of
 * the route page so that stays a thin server component.
 */
import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";
import { listAllSubmittals } from "@/lib/commercial/opportunities/submittals-index";
import { submittalStatusLabel, submittalStatusTone } from "@/lib/commercial/opportunities/submittal-constants";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

const TONE_MAP: Record<string, ToolStatusTone> = {
  emerald: "emerald",
  sky: "brand",
  amber: "amber",
  rose: "neutral",
  charcoal: "neutral",
};

export async function SubmittalsGroupedIndex() {
  const [projects, rows] = await Promise.all([
    listProjects({ includeClosed: true }),
    listAllSubmittals({}),
  ]);
  // rows ordered updatedAt DESC → first per opp is the latest; also count total.
  const latestByOpp = new Map<string, (typeof rows)[number]>();
  const countByOpp = new Map<string, number>();
  for (const r of rows) {
    if (!latestByOpp.has(r.opportunityId)) latestByOpp.set(r.opportunityId, r);
    countByOpp.set(r.opportunityId, (countByOpp.get(r.opportunityId) ?? 0) + 1);
  }
  const withSubmittals = projects.filter((p) => countByOpp.has(p.opp.id)).length;
  const awaiting = rows.filter((r) => r.status === "submitted" || r.status === "under_review").length;

  return (
    <PostJobToolIndex
      title="Submittals"
      subtitle="Shop drawings + product data you transmit to the GC — a Letter of Transmittal per package."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h5 M8 17h4" /></svg>}
      projects={projects}
      emptyHint="Submittals live on a project (a Won deal). Win a deal and it'll show here."
      status={(p: ProjectRow): { label: string; tone: ToolStatusTone } => {
        const latest = latestByOpp.get(p.opp.id);
        const count = countByOpp.get(p.opp.id) ?? 0;
        if (!latest) return { label: "Not started", tone: "neutral" };
        const tone = TONE_MAP[submittalStatusTone(latest.status)] ?? "neutral";
        const suffix = count > 1 ? ` · ${count}` : "";
        return { label: `${submittalStatusLabel(latest.status)}${suffix}`, tone };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/submittals/${p.opp.id}`}
      kpis={
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Projects with submittals" value={String(withSubmittals)} tone="emerald" />
          <Tile label="Awaiting GC response" value={String(awaiting)} tone={awaiting > 0 ? "amber" : "neutral"} />
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
