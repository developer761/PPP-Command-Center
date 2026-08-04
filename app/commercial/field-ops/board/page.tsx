import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { listJobs, updateJob, jobStatusLabel, divisionLabel, JOB_STATUSES, type JobStatus } from "@/lib/commercial/field-ops/jobs";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { JobStatusSelect } from "@/components/commercial/job-status-select";

export const dynamic = "force-dynamic";
const BASE = "/commercial/field-ops/board";

// Board columns (closed hidden by default; estimating folded into the first col view).
const COLUMNS: JobStatus[] = ["ready_to_schedule", "scheduled", "in_progress", "on_hold", "complete"];

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

async function moveJobAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as JobStatus;
  if (JOB_STATUSES.includes(status)) await updateJob(id, { status }, userId);
  revalidatePath(BASE);
  redirect(BASE);
}

export default async function JobBoardPage() {
  await requireAdmin();
  const jobs = await listJobs({ includeClosed: false });
  const byStatus = new Map<JobStatus, typeof jobs>();
  for (const s of COLUMNS) byStatus.set(s, []);
  // estimating jobs sit in the first (ready_to_schedule) column visually.
  for (const j of jobs) {
    const col = j.status === "estimating" ? "ready_to_schedule" : j.status;
    if (byStatus.has(col as JobStatus)) byStatus.get(col as JobStatus)!.push(j);
  }
  const statusOpts = JOB_STATUSES.map((s) => ({ value: s, label: jobStatusLabel(s) }));

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Job Board</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Every open job by stage. &ldquo;Ready to schedule&rdquo; is your backlog — the jobs waiting for a crew.</p>
      </div>

      {jobs.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No open jobs</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1"><Link href="/commercial/field-ops/jobs" className="font-semibold text-cc-brand-700 underline">Add a job</Link> to start scheduling.</p>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const items = byStatus.get(col) ?? [];
            return (
              <div key={col} className="shrink-0 w-[260px] bg-ppp-charcoal-50/50 rounded-xl border border-ppp-charcoal-100">
                <div className="px-3 py-2 flex items-center justify-between border-b border-ppp-charcoal-100">
                  <span className="text-[12px] font-bold text-ppp-charcoal">{jobStatusLabel(col)}</span>
                  <span className="text-[11px] font-bold text-ppp-charcoal-400 tabular-nums">{items.length}</span>
                </div>
                <div className="p-2 space-y-2 min-h-[80px]">
                  {items.length === 0 ? (
                    <p className="text-[11px] text-ppp-charcoal-400 text-center py-3">—</p>
                  ) : (
                    items.map((j) => (
                      <div key={j.id} className="bg-surface border border-ppp-charcoal-100 rounded-lg p-2.5">
                        <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">{j.name}{j.prevailing_wage && <span className="ml-1 text-[9px] font-bold text-amber-700">PW</span>}</div>
                        <div className="text-[10.5px] font-mono text-ppp-charcoal-500 truncate">{j.job_code}{j.division_tag ? ` · ${divisionLabel(j.division_tag)}` : ""}</div>
                        {(j.customer_name || j.site_city) && <div className="text-[10.5px] text-ppp-charcoal-500 truncate mt-0.5">{[j.customer_name, j.site_city].filter(Boolean).join(" · ")}</div>}
                        {(j.target_start || j.estimated_labor_hours) && (
                          <div className="text-[10px] text-ppp-charcoal-400 mt-1 flex items-center gap-2">
                            {j.target_start && <span>{fmtEtDate(j.target_start)}{j.target_end ? ` → ${fmtEtDate(j.target_end)}` : ""}</span>}
                            {j.estimated_labor_hours != null && <span>· {j.estimated_labor_hours}h est</span>}
                          </div>
                        )}
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <form action={moveJobAction}>
                            <input type="hidden" name="id" value={j.id} />
                            <JobStatusSelect value={j.status} options={statusOpts} />
                          </form>
                          <Link href={`/commercial/field-ops/schedule?week=${j.target_start ?? ""}`} className="text-[10.5px] font-semibold text-cc-brand-700 hover:underline shrink-0">Schedule</Link>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
