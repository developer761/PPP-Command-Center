import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { listEmployees } from "@/lib/commercial/field-ops/employees";
import { listJobs } from "@/lib/commercial/field-ops/jobs";

export const dynamic = "force-dynamic";

/**
 * R10 Field Ops hub - the landing for crew scheduling + labor. Card grid (the
 * hub pattern). Surfaces build out phase by phase; today: Crew (Admin CRUD).
 */
export default async function FieldOpsHubPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) redirect("/");
  await assertCommercialAccess(data.user.id);

  const [employees, jobs] = await Promise.all([listEmployees(), listJobs()]);
  const crewCount = employees.length;
  const jobCount = jobs.length;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Field Ops</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Crew scheduling, clock in/out, and payroll. Start by adding your crew.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link href="/commercial/field-ops/employees" className="group flex flex-col gap-2 p-5 rounded-xl bg-surface border border-ppp-charcoal-100 hover:border-cc-brand-300 hover:shadow-sm transition-all">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-cc-brand-50 text-cc-brand-700">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            </span>
            <span className="text-[15px] font-bold text-ppp-charcoal">Crew</span>
          </div>
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">Your painters + foremen — the columns on the Week Grid. {crewCount > 0 ? `${crewCount} on the roster.` : "Add your first crew member."}</p>
          <span className="mt-auto text-[12px] font-semibold text-cc-brand-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">Manage crew &rarr;</span>
        </Link>

        <Link href="/commercial/field-ops/jobs" className="group flex flex-col gap-2 p-5 rounded-xl bg-surface border border-ppp-charcoal-100 hover:border-cc-brand-300 hover:shadow-sm transition-all">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-cc-brand-50 text-cc-brand-700">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z" /><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>
            </span>
            <span className="text-[15px] font-bold text-ppp-charcoal">Jobs</span>
          </div>
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">What the crew works on — PPP, commercial, prevailing-wage, one-offs. {jobCount > 0 ? `${jobCount} open.` : "Add your first job."}</p>
          <span className="mt-auto text-[12px] font-semibold text-cc-brand-700 inline-flex items-center gap-1 group-hover:gap-2 transition-all">Manage jobs &rarr;</span>
        </Link>

        <div className="sm:col-span-2 flex flex-col gap-2 p-5 rounded-xl bg-ppp-charcoal-50/40 border border-dashed border-ppp-charcoal-200">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center h-10 w-10 rounded-lg bg-surface text-ppp-charcoal-400">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
            </span>
            <span className="text-[15px] font-bold text-ppp-charcoal-500">Week Grid · Clock in/out · Approvals · Payroll</span>
          </div>
          <p className="text-[13px] text-ppp-charcoal-500 leading-relaxed">Building next — the scheduling grid, the painter clock, approvals, and payroll export land here as we roll them out.</p>
        </div>
      </div>
    </div>
  );
}
