import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  listEmployees,
  createEmployee,
  updateEmployee,
  setEmployeePin,
  employeeRoleLabel,
  workerTypeLabel,
  EMPLOYEE_ROLES,
  WORKER_TYPES,
  PAY_TYPES,
  type CommercialEmployee,
} from "@/lib/commercial/field-ops/employees";
import { currentCostRatesForEmployees, currentCostRate, setCostRate } from "@/lib/commercial/field-ops/rates";
import { INPUT_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";

/** Parse a loose "$25.50" / "25" cost-rate string to whole cents, or null when
 *  blank/invalid. Blank = "don't change the rate", never "set to $0". */
function parseCostRateToCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export const dynamic = "force-dynamic";

const BASE = "/commercial/field-ops/employees";

async function requireAdmin(): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  return user.id;
}

async function addEmployeeAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const result = await createEmployee({
    first_name: String(formData.get("first_name") ?? ""),
    last_name: String(formData.get("last_name") ?? ""),
    display_name: String(formData.get("display_name") ?? ""),
    worker_type: (String(formData.get("worker_type") ?? "w2") as CommercialEmployee["worker_type"]),
    role: (String(formData.get("role") ?? "painter") as CommercialEmployee["role"]),
    pay_type: (String(formData.get("pay_type") ?? "hourly") as CommercialEmployee["pay_type"]),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    preferred_language: (String(formData.get("preferred_language") ?? "en") as "en" | "es"),
    actor_user_id: userId,
  });
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  // Optional Clock Station PIN set at create time (only when 4 digits entered).
  const pin = String(formData.get("clock_pin") ?? "").trim();
  if (/^\d{4}$/.test(pin)) await setEmployeePin(result.employee.id, pin, userId);
  // Optional burdened cost rate ($/hr) — drives the auto crew-labor cost in job
  // P&L (Option A). Blank = set later on the Crew page.
  const newRateCents = parseCostRateToCents(String(formData.get("cost_rate") ?? ""));
  if (newRateCents != null) await setCostRate(result.employee.id, newRateCents, userId);
  // Instantly welcome them + start their schedule emails (fire-and-forget).
  if (result.employee.email) {
    const { sendWelcomeEmail } = await import("@/lib/commercial/field-ops/schedule-email-send");
    await sendWelcomeEmail(result.employee).catch(() => undefined);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=added`);
}

async function editEmployeeAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const result = await updateEmployee(
    id,
    {
      first_name: String(formData.get("first_name") ?? ""),
      last_name: String(formData.get("last_name") ?? ""),
      display_name: String(formData.get("display_name") ?? ""),
      worker_type: String(formData.get("worker_type") ?? "w2") as CommercialEmployee["worker_type"],
      role: String(formData.get("role") ?? "painter") as CommercialEmployee["role"],
      pay_type: String(formData.get("pay_type") ?? "hourly") as CommercialEmployee["pay_type"],
      phone: String(formData.get("phone") ?? ""),
      email: String(formData.get("email") ?? ""),
      preferred_language: String(formData.get("preferred_language") ?? "en") as "en" | "es",
    },
    userId
  );
  if (!result.ok) redirect(`${BASE}?error=${encodeURIComponent(result.error)}`);
  // Optional: set/replace the Clock Station PIN (only when 4 digits entered).
  const pin = String(formData.get("clock_pin") ?? "").trim();
  if (/^\d{4}$/.test(pin)) await setEmployeePin(id, pin, userId);
  // Burdened cost rate ($/hr) — only write when it actually changed, so we don't
  // churn a new effective-dated window on every unrelated Save.
  const newRateCents = parseCostRateToCents(String(formData.get("cost_rate") ?? ""));
  if (newRateCents != null) {
    const cur = await currentCostRate(id);
    if (cur !== newRateCents) {
      const rr = await setCostRate(id, newRateCents, userId);
      if (!rr.ok) redirect(`${BASE}?error=${encodeURIComponent(rr.error)}`);
    }
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=saved`);
}

async function toggleActiveAction(formData: FormData) {
  "use server";
  const userId = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "1";
  await updateEmployee(id, { active }, userId);
  revalidatePath(BASE);
  redirect(BASE);
}

export default async function FieldOpsEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const employees = await listEmployees({ includeInactive: true });
  const activeCount = employees.filter((e) => e.active).length;
  // Current burdened cost rate per employee (drives auto crew-labor P&L).
  const costRates = await currentCostRatesForEmployees(employees.map((e) => e.id));
  const rateDollars = (id: string): string => {
    const c = costRates.get(id);
    return c != null ? (c / 100).toFixed(2) : "";
  };
  // Active crew missing a cost rate → their hours cost $0 in job P&L.
  const missingRateCount = employees.filter((e) => e.active && !costRates.has(e.id)).length;

  return (
    <div className="pb-8 max-w-4xl">
      <div className="mb-5">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Crew</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">{activeCount} active · the people you schedule on the Calendar. Each gets a magic link to see their schedule and clock in/out.</p>
      </div>

      {sp.error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{sp.error}</div>}
      {sp.ok && <div className="mb-4 rounded-lg bg-ppp-green-50 border border-ppp-green-100 px-3 py-2 text-[12.5px] text-ppp-green-700">{sp.ok === "added" ? "Added." : "Saved."}</div>}
      {missingRateCount > 0 && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12.5px] text-amber-800">
          <span className="font-semibold">{missingRateCount} active {missingRateCount === 1 ? "crew member has" : "crew members have"} no cost rate.</span> Their approved hours cost $0 in job P&amp;L, so margins look better than they are. Set a burdened $/hr below (open a crew member → Cost rate).
        </div>
      )}

      {/* Add */}
      <form action={addEmployeeAction} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 mb-5 space-y-3">
        <h2 className="text-sm font-bold text-ppp-charcoal">Add a crew member</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block"><span className={LABEL_CLS}>First name *</span>
            <input name="first_name" required placeholder="Rob" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Last name</span>
            <input name="last_name" placeholder="Castellano" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Display name (shown on the schedule)</span>
            <input name="display_name" placeholder="Rob C (blank = auto)" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Role</span>
            <select name="role" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              {EMPLOYEE_ROLES.map((r) => <option key={r} value={r}>{employeeRoleLabel(r)}</option>)}
            </select></label>
          <label className="block"><span className={LABEL_CLS}>Type</span>
            <select name="worker_type" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              {WORKER_TYPES.map((t) => <option key={t} value={t}>{workerTypeLabel(t)}</option>)}
            </select></label>
          <label className="block"><span className={LABEL_CLS}>Pay type</span>
            <select name="pay_type" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              {PAY_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
          <label className="block"><span className={LABEL_CLS}>Cost rate $/hr <span className="font-normal text-ppp-charcoal-400">(burdened, optional)</span></span>
            <input name="cost_rate" inputMode="decimal" placeholder="e.g. 42.00" className={INPUT_CLS} />
            <span className="block text-[10.5px] text-ppp-charcoal-400 mt-1">Wage + taxes + overhead. Drives job-cost margin — not shown to the worker.</span></label>
          <label className="block"><span className={LABEL_CLS}>Phone</span>
            <input name="phone" type="tel" placeholder="(631) 555-0100" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Email (for their schedule)</span>
            <input name="email" type="email" placeholder="rob@…" className={INPUT_CLS} /></label>
          <label className="block"><span className={LABEL_CLS}>Schedule email language</span>
            <select name="preferred_language" className={SELECT_CLS} style={SELECT_BG_STYLE}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select></label>
          <label className="block"><span className={LABEL_CLS}>Clock Station PIN (4 digits, optional)</span>
            <input name="clock_pin" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="e.g. 1234" className={INPUT_CLS} /></label>
        </div>
        <PendingSubmitButton pendingLabel="Adding…" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] disabled:opacity-60 touch-manipulation">Add crew member</PendingSubmitButton>
      </form>

      {/* List */}
      {employees.length === 0 ? (
        <div className="text-center py-10 bg-surface border border-ppp-charcoal-100 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No crew yet</p>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1">Add your painters above — then schedule them on the Calendar.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {employees.map((e) => (
            <li key={e.id} className={`bg-surface border rounded-xl ${e.active ? "border-ppp-charcoal-100" : "border-ppp-charcoal-100 opacity-60"}`}>
              <details>
                <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none min-h-[52px]">
                  <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-cc-brand-50 text-cc-brand-700 text-[12px] font-bold shrink-0">{e.display_name.slice(0, 2).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold text-ppp-charcoal truncate">{e.display_name}{!e.active && <span className="ml-2 text-[10.5px] font-bold uppercase text-ppp-charcoal-400">inactive</span>}</div>
                    <div className="text-[11.5px] text-ppp-charcoal-500 truncate">{employeeRoleLabel(e.role)} · {workerTypeLabel(e.worker_type)}{e.email ? ` · ${e.email}` : " · no email"}</div>
                  </div>
                  {e.active && (
                    costRates.has(e.id) ? (
                      <span className="text-[11px] font-semibold text-ppp-charcoal-600 tabular-nums shrink-0">${rateDollars(e.id)}/hr</span>
                    ) : (
                      <span className="text-[10.5px] font-semibold text-amber-700 shrink-0">no rate</span>
                    )
                  )}
                  <span className="text-[11px] text-ppp-charcoal-400 shrink-0">Edit</span>
                </summary>
                <form action={editEmployeeAction} className="px-4 pb-4 pt-1 space-y-3 border-t border-ppp-charcoal-50">
                  <input type="hidden" name="id" value={e.id} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block"><span className={LABEL_CLS}>First name</span><input name="first_name" defaultValue={e.first_name} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Last name</span><input name="last_name" defaultValue={e.last_name ?? ""} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Display name</span><input name="display_name" defaultValue={e.display_name} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Role</span><select name="role" defaultValue={e.role} className={SELECT_CLS} style={SELECT_BG_STYLE}>{EMPLOYEE_ROLES.map((r) => <option key={r} value={r}>{employeeRoleLabel(r)}</option>)}</select></label>
                    <label className="block"><span className={LABEL_CLS}>Type</span><select name="worker_type" defaultValue={e.worker_type} className={SELECT_CLS} style={SELECT_BG_STYLE}>{WORKER_TYPES.map((t) => <option key={t} value={t}>{workerTypeLabel(t)}</option>)}</select></label>
                    <label className="block"><span className={LABEL_CLS}>Pay type</span><select name="pay_type" defaultValue={e.pay_type} className={SELECT_CLS} style={SELECT_BG_STYLE}>{PAY_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
                    <label className="block"><span className={LABEL_CLS}>Cost rate $/hr <span className="font-normal text-ppp-charcoal-400">(burdened)</span></span><input name="cost_rate" inputMode="decimal" defaultValue={rateDollars(e.id)} placeholder="not set" className={INPUT_CLS} /><span className="block text-[10.5px] text-ppp-charcoal-400 mt-1">Effective from today; past jobs keep the old rate.</span></label>
                    <label className="block"><span className={LABEL_CLS}>Phone</span><input name="phone" type="tel" defaultValue={e.phone ?? ""} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Email</span><input name="email" type="email" defaultValue={e.email ?? ""} className={INPUT_CLS} /></label>
                    <label className="block"><span className={LABEL_CLS}>Email language</span><select name="preferred_language" defaultValue={e.preferred_language} className={SELECT_CLS} style={SELECT_BG_STYLE}><option value="en">English</option><option value="es">Spanish</option></select></label>
                    <label className="block"><span className={LABEL_CLS}>Clock Station PIN (4 digits)</span><input name="clock_pin" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="set / replace" className={INPUT_CLS} /></label>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="submit" className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[12.5px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Save</button>
                  </div>
                </form>
                <form action={toggleActiveAction} className="px-4 pb-4">
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="active" value={e.active ? "0" : "1"} />
                  {e.active ? (
                    <ConfirmSubmitButton
                      message={`Deactivate ${e.display_name || `${e.first_name} ${e.last_name}`.trim() || "this crew member"}? They'll be removed from the scheduling picker and their clock-in magic link stops working.`}
                      pendingLabel="…"
                      className="inline-flex items-center px-3 min-h-[44px] rounded-lg border border-rose-200 text-[12px] font-semibold text-rose-600 hover:bg-rose-50 touch-manipulation"
                    >
                      Deactivate
                    </ConfirmSubmitButton>
                  ) : (
                    <button type="submit" className="inline-flex items-center px-3 min-h-[44px] rounded-lg border border-ppp-green-200 text-[12px] font-semibold text-ppp-green-700 hover:bg-ppp-green-50 touch-manipulation">Reactivate</button>
                  )}
                </form>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
