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
  createJob,
  updateJob,
  softDeleteJob,
  listDealOptionsForWorkOrder,
  getOpportunityAccountId,
  jobStatusLabel,
  divisionLabel,
  JOB_STATUSES,
  DIVISION_TAGS,
  type JobStatus,
  type DivisionTag,
} from "@/lib/commercial/field-ops/jobs";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS, TEXTAREA_CLS } from "@/lib/commercial/form-classnames";
import { DateField } from "@/components/commercial/date-field";
import { SearchableSelect } from "@/components/commercial/searchable-select";

export const dynamic = "force-dynamic";
const BASE = "/commercial/field-ops/jobs";

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

function num(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function addJobAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  // Connect to a deal (optional) - the same platform link a real WO has. Picking
  // one ties this work order to that account + deal.
  const opportunity_id = String(formData.get("opportunity_id") ?? "").trim() || null;
  const account_id = opportunity_id ? await getOpportunityAccountId(opportunity_id) : null;
  const result = await createJob({
    job_code: String(formData.get("job_code") ?? ""),
    name: String(formData.get("name") ?? ""),
    opportunity_id,
    account_id,
    customer_name: String(formData.get("customer_name") ?? ""),
    site_address: String(formData.get("site_address") ?? ""),
    site_city: String(formData.get("site_city") ?? ""),
    site_state: String(formData.get("site_state") ?? ""),
    site_zip: String(formData.get("site_zip") ?? ""),
    status: String(formData.get("status") ?? "ready_to_schedule") as JobStatus,
    estimated_labor_hours: num(formData.get("estimated_labor_hours")),
    target_start: String(formData.get("target_start") ?? ""),
    target_end: String(formData.get("target_end") ?? ""),
    prevailing_wage: formData.get("prevailing_wage") === "on",
    division_tag: (String(formData.get("division_tag") ?? "") || "commercial") as DivisionTag,
    notes: String(formData.get("notes") ?? ""),
    actor_user_id: userId,
  });
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=added`);
}

async function editJobAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const result = await updateJob(
    id,
    {
      job_code: String(formData.get("job_code") ?? ""),
      name: String(formData.get("name") ?? ""),
      customer_name: String(formData.get("customer_name") ?? ""),
      site_address: String(formData.get("site_address") ?? ""),
      site_city: String(formData.get("site_city") ?? ""),
      status: String(formData.get("status") ?? "ready_to_schedule") as JobStatus,
      estimated_labor_hours: num(formData.get("estimated_labor_hours")),
      target_start: String(formData.get("target_start") ?? ""),
      target_end: String(formData.get("target_end") ?? ""),
      prevailing_wage: formData.get("prevailing_wage") === "on",
      division_tag: (String(formData.get("division_tag") ?? "") || null) as DivisionTag | null,
      notes: String(formData.get("notes") ?? ""),
    },
    userId
  );
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(BASE);
  redirect(`${BASE}?ok=saved`);
}

async function deleteJobAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  await softDeleteJob(String(formData.get("id") ?? ""), userId);
  revalidatePath(BASE);
  redirect(BASE);
}

export default async function FieldOpsJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; closed?: string }>;
}) {
  const userId = await requireAdmin();
  const sp = await searchParams;
  // Backfill schedulable twins for any sent deal WOs before listing.
  await ensureJobsForSentWorkOrders(userId);
  const [jobs, dealOptions] = await Promise.all([listJobs({ includeClosed: sp.closed === "1" }), listDealOptionsForWorkOrder()]);

  return (
    <div className="pb-8 max-w-4xl">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Work Orders</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">What the crew gets scheduled on. Won commercial deals flow in here automatically when you <strong>Send to Field Ops</strong> from the deal. Add one here only for a <strong>PPP, prevailing-wage, or one-off</strong> work order that has no deal behind it.</p>
      </div>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error}</div>}
      {sp.ok && <div className="mb-4 rounded-lg bg-ppp-green-50 border border-ppp-green-100 px-3 py-2 text-[12.5px] text-ppp-green-700">{sp.ok === "added" ? "Work order added." : "Saved."}</div>}

      <form action={addJobAction} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 mb-5 space-y-3">
        <h2 className="text-sm font-bold text-ppp-charcoal">Add a work order</h2>
        {dealOptions.length > 0 && (
          <div>
            <span className={LABEL_CLS}>Connect to a deal (optional)</span>
            <SearchableSelect name="opportunity_id" options={dealOptions} placeholder="Search a deal / GC to link it" />
            <p className="text-[11px] text-ppp-charcoal-400 mt-1">Links this work order to that account + deal, like a real WO. Leave blank for PPP / prevailing-wage / one-off jobs.</p>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block sm:col-span-2"><span className={LABEL_CLS}>Name *</span><input name="name" required placeholder="Stark Enterprises — lobby & halls" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Customer</span><input name="customer_name" placeholder="GC / owner" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Division</span>
            <select name="division_tag" defaultValue="commercial" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              {DIVISION_TAGS.map((d) => <option key={d} value={d}>{divisionLabel(d)}</option>)}
            </select></label>
          <label className="block sm:col-span-2"><span className={LABEL_CLS}>Site address</span><input name="site_address" placeholder="Street" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>City</span><input name="site_city" className={INPUT_CLS} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className={LABEL_CLS}>State</span><input name="site_state" className={INPUT_CLS} /></label>
            <label className="block"><span className={LABEL_CLS}>Zip</span><input name="site_zip" className={INPUT_CLS} /></label>
          </div>
          <label className="block"><span className={LABEL_CLS}>Status</span>
            <select name="status" defaultValue="ready_to_schedule" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              {JOB_STATUSES.map((s) => <option key={s} value={s}>{jobStatusLabel(s)}</option>)}
            </select></label>
          <label className="block"><span className={LABEL_CLS}>Est. labor hours</span><input name="estimated_labor_hours" type="number" min="0" step="1" placeholder="0" className={INPUT_CLS} /></label>
          <div><span className={LABEL_CLS}>Target start</span><DateField name="target_start" placeholder="Pick a date" /></div>
          <div><span className={LABEL_CLS}>Target end</span><DateField name="target_end" placeholder="Pick a date" /></div>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ppp-charcoal-700"><input type="checkbox" name="prevailing_wage" className="h-4 w-4" /> Prevailing wage (PW)</label>
        <label className="block"><span className={LABEL_CLS}>Notes</span><textarea name="notes" rows={2} className={TEXTAREA_CLS} /></label>
        <button type="submit" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Add work order</button>
      </form>

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-ppp-charcoal">{jobs.length} {sp.closed === "1" ? "work order" : "open work order"}{jobs.length === 1 ? "" : "s"}</h2>
        <Link href={sp.closed === "1" ? BASE : `${BASE}?closed=1`} className="text-[12px] font-semibold text-cc-brand-700 hover:underline">{sp.closed === "1" ? "Hide closed" : "Show closed"}</Link>
      </div>

      {jobs.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No work orders yet</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Send a deal&rsquo;s work order to Field Ops, or add a one-off above — then schedule the crew onto it.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.id} className="bg-surface border border-ppp-charcoal-100 rounded-xl">
              <details>
                <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none min-h-[52px]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold text-ppp-charcoal truncate">{j.name} {j.prevailing_wage && <span className="ml-1 text-[10px] font-bold text-amber-700">PW</span>}</div>
                    <div className="text-[11.5px] text-ppp-charcoal-500 truncate font-mono">{j.job_code} · {jobStatusLabel(j.status)}{j.division_tag ? ` · ${divisionLabel(j.division_tag)}` : ""}{j.customer_name ? ` · ${j.customer_name}` : ""}</div>
                  </div>
                  <span className="text-[11px] text-ppp-charcoal-400 shrink-0">Edit</span>
                </summary>
                <form action={editJobAction} className="px-4 pb-4 pt-1 space-y-3 border-t border-ppp-charcoal-50">
                  <input type="hidden" name="id" value={j.id} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block"><span className={LABEL_CLS}>Code</span><input name="job_code" defaultValue={j.job_code} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Name</span><input name="name" defaultValue={j.name} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Customer</span><input name="customer_name" defaultValue={j.customer_name ?? ""} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Division</span><select name="division_tag" defaultValue={j.division_tag ?? ""} className={SELECT_CLS} style={SELECT_BG_STYLE}><option value="">—</option>{DIVISION_TAGS.map((d) => <option key={d} value={d}>{divisionLabel(d)}</option>)}</select></label>
                    <label className="block"><span className={LABEL_CLS}>City</span><input name="site_city" defaultValue={j.site_city ?? ""} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Status</span><select name="status" defaultValue={j.status} className={SELECT_CLS} style={SELECT_BG_STYLE}>{JOB_STATUSES.map((s) => <option key={s} value={s}>{jobStatusLabel(s)}</option>)}</select></label>
                    <label className="block"><span className={LABEL_CLS}>Est. labor hours</span><input name="estimated_labor_hours" type="number" min="0" step="1" defaultValue={j.estimated_labor_hours ?? ""} className={INPUT_CLS} /></label>
                    <label className="block sm:col-span-2"><span className={LABEL_CLS}>Site address</span><input name="site_address" defaultValue={j.site_address ?? ""} className={INPUT_CLS} /></label>
                    <div><span className={LABEL_CLS}>Target start</span><DateField name="target_start" defaultValue={j.target_start ?? ""} placeholder="Pick a date" /></div>
                    <div><span className={LABEL_CLS}>Target end</span><DateField name="target_end" defaultValue={j.target_end ?? ""} placeholder="Pick a date" /></div>
                  </div>
                  <label className="flex items-center gap-2 text-[13px] text-ppp-charcoal-700"><input type="checkbox" name="prevailing_wage" defaultChecked={j.prevailing_wage} className="h-4 w-4" /> Prevailing wage (PW)</label>
                  <label className="block"><span className={LABEL_CLS}>Notes</span><textarea name="notes" rows={2} defaultValue={j.notes ?? ""} className={TEXTAREA_CLS} /></label>
                  <button type="submit" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Save</button>
                </form>
                <form action={deleteJobAction} className="px-4 pb-4">
                  <input type="hidden" name="id" value={j.id} />
                  <button type="submit" className="text-[12px] font-semibold text-rose-600 hover:text-rose-700">Delete work order</button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
