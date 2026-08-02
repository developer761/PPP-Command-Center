/**
 * AIA Billing — cross-account index (sidebar tab). Every project grouped by
 * account with its latest AIA application + status; tap one to open that
 * project's G702/G703 billing. Same data (`listProjects`) as the Projects tab
 * + account, so the latest-app status always agrees.
 */
import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { listProjects } from "@/lib/commercial/projects/db";
import { AIA_STATUS_META } from "@/lib/commercial/aia/constants";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { PostJobToolIndex, type ToolStatusTone } from "@/components/commercial/post-job-tool-index";

export const dynamic = "force-dynamic";

export default async function AiaIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const projects = await listProjects({ includeClosed: true });
  const started = projects.filter((p) => p.latestAppNumber != null).length;
  const notStarted = projects.length - started;
  const awaitingPayment = projects.filter((p) => p.latestAppStatus === "submitted").length;
  const retainageHeldCents = projects.reduce((s, p) => s + p.retainageHeldCents, 0);

  return (
    <PostJobToolIndex
      title="AIA Billing"
      subtitle="G702 / G703 progress billing certificates — one application per billing period, per project."
      icon={<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6" /></svg>}
      projects={projects}
      emptyHint="AIA billing lives on a project (a Won opportunity). Win an opportunity and it'll show here."
      status={(p): { label: string; tone: ToolStatusTone } => {
        if (p.latestAppNumber == null) return { label: "Not started", tone: "neutral" };
        const meta = p.latestAppStatus ? AIA_STATUS_META[p.latestAppStatus] : null;
        const tone: ToolStatusTone = p.latestAppStatus === "paid" ? "emerald" : p.latestAppStatus === "submitted" ? "brand" : "amber";
        return { label: `App ${p.latestAppNumber} · ${meta ? meta.label : ""}`.trim(), tone };
      }}
      hrefFor={(p) => `/commercial/accounts/${p.accountId}/aia/${p.opp.id}?back=/commercial/post-job/aia`}
      accent="navy"
      rowMeta={(p) => (p.contractToDateCents > 0 ? <span className="tabular-nums">{formatCentsCompact(p.contractToDateCents)} contract</span> : null)}
      kpis={
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile label="Projects billing" value={String(started)} tone="emerald" />
          <Tile label="Not started" value={String(notStarted)} tone="neutral" />
          <Tile label="Awaiting payment" value={String(awaitingPayment)} tone={awaitingPayment > 0 ? "amber" : "neutral"} />
          <Tile label="Retainage held" value={formatCentsCompact(retainageHeldCents)} tone="neutral" />
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
