import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listJobs,
  ensureJobsForSentWorkOrders,
  cleanOrphanedJobs,
  updateJob,
  jobStatusLabel,
  divisionLabel,
  JOB_STATUSES,
  type JobStatus,
} from "@/lib/commercial/field-ops/jobs";
import { StatusMoveSelect } from "@/components/commercial/status-move-select";

export const dynamic = "force-dynamic";
const BASE = "/commercial/field-ops/status";

// Column accent per status — matches the semantic palette used across the app
// (brand=to-do, amber=in-flight, emerald=done, rose=blocked, charcoal=closed).
const STATUS_ACCENT: Record<JobStatus, string> = {
  estimating: "bg-ppp-charcoal-300",
  ready_to_schedule: "bg-cc-brand-500",
  scheduled: "bg-cc-brand-600",
  in_progress: "bg-amber-500",
  almost_done: "bg-teal-500",
  complete: "bg-emerald-500",
  closed: "bg-ppp-charcoal-400",
  on_hold: "bg-rose-500",
};

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");
  return user.id;
}

async function moveStatusAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as JobStatus;
  if (!id || !JOB_STATUSES.includes(status)) return;
  const res = await updateJob(id, { status }, userId);
  // Status flows through to the Calendar + Work Orders tab (it's a Field-Ops
  // axis, distinct from the deal WO's draft/sent axis), so revalidate those.
  // A rejected value (e.g. migration 118 not applied yet)
  // surfaces as ?error so the board doesn't silently swallow it.
  revalidatePath(BASE);
  revalidatePath("/commercial/field-ops/calendar");
  revalidatePath("/commercial/field-ops/jobs");
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
}

export default async function FieldOpsStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await requireAdmin();
  const sp = await searchParams;
  await Promise.all([ensureJobsForSentWorkOrders(userId), cleanOrphanedJobs(userId)]);
  const jobs = await listJobs({ includeClosed: true });

  // One flat list, ordered by pipeline stage (estimating → … → closed) then name,
  // so same-stage work orders cluster without the horizontal-scroll board Karan
  // didn't want. Each row carries an inline status control.
  const rank = new Map<JobStatus, number>(JOB_STATUSES.map((s, i) => [s, i]));
  const ordered = [...jobs].sort((a, b) => {
    const ra = rank.get(a.status) ?? 99;
    const rb = rank.get(b.status) ?? 99;
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });

  return (
    <div className="pb-8 max-w-3xl">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Status</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Every work order and the stage it&rsquo;s at. Change a status here and it updates across Field Ops — the Work Orders tab and the Calendar (shown next to the crew). Scheduling a crew onto a work order moves it to <strong>Scheduled</strong> automatically.</p>
      </div>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error} — this status may need migration 118 applied.</div>}

      {ordered.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No work orders yet</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Add one on the <Link href="/commercial/field-ops/jobs" className="font-semibold text-cc-brand-700 hover:underline">Work Orders</Link> tab, then move it through its stages here.</p>
        </div>
      ) : (
        <>
          <h2 className="text-sm font-bold text-ppp-charcoal mb-2">{ordered.length} work order{ordered.length === 1 ? "" : "s"}</h2>
          <ul className="space-y-2">
            {ordered.map((j) => (
              <li key={j.id} className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-3 flex items-center gap-3">
                <span aria-hidden className={`shrink-0 inline-block h-2.5 w-2.5 rounded-full ${STATUS_ACCENT[j.status]}`} title={jobStatusLabel(j.status)} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold text-ppp-charcoal leading-snug flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{j.name}</span>
                    {j.prevailing_wage && <span className="shrink-0 text-[9px] font-bold bg-ppp-charcoal-100 text-ppp-navy rounded px-1 py-0.5">PW</span>}
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 truncate">
                    <span className="font-mono">{j.job_code}</span>
                    {j.customer_name ? ` · ${j.customer_name}` : ""}
                    {j.division_tag ? ` · ${divisionLabel(j.division_tag)}` : ""}
                    {typeof j.estimated_labor_hours === "number" && j.estimated_labor_hours > 0 ? ` · Est. ${j.estimated_labor_hours}h` : ""}
                  </div>
                </div>
                <form action={moveStatusAction} className="shrink-0 w-[168px]">
                  <input type="hidden" name="id" value={j.id} />
                  <StatusMoveSelect current={j.status} />
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
