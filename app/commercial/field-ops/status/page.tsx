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
  updateJob,
  jobStatusLabel,
  divisionLabel,
  JOB_STATUSES,
  type JobStatus,
  type CommercialJob,
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
  // Status flows through to the Calendar + Work Orders tab + the deal, so
  // revalidate broadly. A rejected value (e.g. migration 118 not applied yet)
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
  await ensureJobsForSentWorkOrders(userId);
  const jobs = await listJobs({ includeClosed: true });

  const byStatus = new Map<JobStatus, CommercialJob[]>();
  for (const s of JOB_STATUSES) byStatus.set(s, []);
  for (const j of jobs) byStatus.get(j.status)?.push(j);

  return (
    <div className="pb-8">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Status</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Move every work order through its stages. Changing a status here updates it everywhere — the Calendar (shown next to the crew) and the deal it&rsquo;s linked to.</p>
      </div>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error} — this status may need migration 118 applied.</div>}

      {jobs.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No work orders yet</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Add one on the <Link href="/commercial/field-ops/jobs" className="font-semibold text-cc-brand-700 hover:underline">Work Orders</Link> tab, then move it through its stages here.</p>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0">
          {JOB_STATUSES.map((s) => {
            const col = byStatus.get(s) ?? [];
            return (
              <section key={s} className="shrink-0 w-[248px] bg-ppp-charcoal-25/60 border border-ppp-charcoal-100 rounded-xl">
                <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                  <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_ACCENT[s]}`} />
                  <h2 className="text-[12.5px] font-bold text-ppp-charcoal">{jobStatusLabel(s)}</h2>
                  <span className="ml-auto text-[11px] font-semibold text-ppp-charcoal-400 tabular-nums">{col.length}</span>
                </div>
                <div className="px-2.5 pb-2.5 space-y-2 min-h-[40px]">
                  {col.length === 0 ? (
                    <p className="text-[11px] text-ppp-charcoal-300 px-1 py-2">—</p>
                  ) : (
                    col.map((j) => (
                      <div key={j.id} className="bg-surface border border-ppp-charcoal-100 rounded-lg p-2.5">
                        <div className="flex items-start gap-1.5">
                          <p className="text-[12.5px] font-semibold text-ppp-charcoal leading-snug flex-1 min-w-0 break-words">{j.name}</p>
                          {j.prevailing_wage && <span className="shrink-0 text-[9px] font-bold bg-ppp-charcoal-100 text-ppp-navy rounded px-1 py-0.5">PW</span>}
                        </div>
                        <p className="text-[10.5px] text-ppp-charcoal-500 font-mono truncate mt-0.5">{j.job_code}</p>
                        {(j.customer_name || j.division_tag) && (
                          <p className="text-[10.5px] text-ppp-charcoal-400 truncate">{[j.customer_name, j.division_tag ? divisionLabel(j.division_tag) : null].filter(Boolean).join(" · ")}</p>
                        )}
                        {typeof j.estimated_labor_hours === "number" && j.estimated_labor_hours > 0 && (
                          <p className="text-[10.5px] text-ppp-charcoal-400 mt-0.5">Est. {j.estimated_labor_hours}h</p>
                        )}
                        <form action={moveStatusAction} className="mt-2">
                          <input type="hidden" name="id" value={j.id} />
                          <StatusMoveSelect current={j.status} />
                        </form>
                      </div>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
