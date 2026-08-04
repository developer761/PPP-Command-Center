import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import {
  listScheduleRecipients,
  addScheduleRecipient,
  removeScheduleRecipient,
} from "@/lib/commercial/field-ops/schedule-emails";
import { listEmployees, updateEmployee } from "@/lib/commercial/field-ops/employees";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";
const BASE = "/commercial/settings/schedule-emails";

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial");
  return user.id;
}

async function addRecipientAction(formData: FormData) {
  "use server";
  await requireAdmin();
  const result = await addScheduleRecipient(String(formData.get("email") ?? ""), String(formData.get("label") ?? ""));
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(BASE);
  redirect(BASE);
}

async function removeRecipientAction(formData: FormData) {
  "use server";
  await requireAdmin();
  await removeScheduleRecipient(String(formData.get("id") ?? ""));
  revalidatePath(BASE);
  redirect(BASE);
}

async function toggleOptOutAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const optOut = String(formData.get("opt_out") ?? "") === "1";
  await updateEmployee(id, { schedule_email_opt_out: optOut }, userId);
  revalidatePath(BASE);
  redirect(BASE);
}

export default async function ScheduleEmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [recipients, employees] = await Promise.all([listScheduleRecipients(), listEmployees()]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
      <Link href="/commercial/settings/access" className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 min-h-[36px]">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
        Access
      </Link>
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal">Schedule Emails</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-2xl">Every crew member gets their own weekly schedule emailed to them by default. Turn it off per person here, and add office people who should get the full weekly schedule.</p>
      </header>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error}</div>}

      {/* Internal recipients */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 mb-5">
        <h2 className="text-sm font-bold text-ppp-charcoal">Office recipients — full weekly schedule</h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 mb-3">These addresses get the whole crew&rsquo;s schedule (all jobs), not just one person&rsquo;s.</p>
        <form action={addRecipientAction} className="flex flex-col sm:flex-row gap-2 mb-3">
          <input name="email" type="email" required placeholder="stephanie@tomcopainting.com" className={`${INPUT_CLS} flex-1`} />
          <input name="label" placeholder="Name (optional)" className={`${INPUT_CLS} sm:w-44`} />
          <button type="submit" className="inline-flex items-center justify-center px-4 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Add</button>
        </form>
        {recipients.length === 0 ? (
          <p className="text-[12.5px] text-ppp-charcoal-500">No office recipients yet.</p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {recipients.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0"><span className="text-[13px] font-medium text-ppp-charcoal">{r.label ? `${r.label} · ` : ""}</span><span className="text-[12.5px] text-ppp-charcoal-600">{r.email}</span></div>
                <form action={removeRecipientAction}><input type="hidden" name="id" value={r.id} /><button type="submit" className="text-[12px] font-semibold text-rose-600 hover:text-rose-700 min-h-[36px]">Remove</button></form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Per-employee opt-out */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
        <h2 className="text-sm font-bold text-ppp-charcoal">Crew — personal schedule email</h2>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 mb-3">On for everyone by default. Turn off for anyone who doesn&rsquo;t want it (they can still clock in from the Clock Station).</p>
        {employees.length === 0 ? (
          <p className="text-[12.5px] text-ppp-charcoal-500">No crew yet — <Link href="/commercial/field-ops/employees" className="font-semibold text-cc-brand-700 underline">add your crew</Link> first.</p>
        ) : (
          <ul className="divide-y divide-ppp-charcoal-100">
            {employees.map((e) => {
              const on = !e.schedule_email_opt_out;
              const noEmail = !e.email;
              return (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ppp-charcoal truncate">{e.display_name}</div>
                    <div className="text-[11.5px] text-ppp-charcoal-500 truncate">{noEmail ? <span className="text-amber-700">No email on file — add one to email them</span> : e.email}</div>
                  </div>
                  {noEmail ? (
                    <Link href="/commercial/field-ops/employees" className="text-[12px] font-semibold text-cc-brand-700 hover:underline shrink-0">Add email</Link>
                  ) : (
                    <form action={toggleOptOutAction} className="shrink-0">
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="opt_out" value={on ? "1" : "0"} />
                      <button type="submit" className={`inline-flex items-center gap-1.5 px-3 rounded-lg text-[12px] font-semibold min-h-[40px] ${on ? "bg-ppp-green-50 text-ppp-green-700 hover:bg-ppp-green-100" : "bg-ppp-charcoal-50 text-ppp-charcoal-500 hover:bg-ppp-charcoal-100"}`}>
                        {on ? "Email: on" : "Email: off"}
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
