import { redirect } from "next/navigation";
import Link from "next/link";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getCommercialSetting, setCommercialSetting } from "@/lib/commercial/settings";
import {
  CLOCK_OVERRIDE_PIN_KEY,
  DEFAULT_CLOCK_OVERRIDE_PIN,
  CLOCK_WINDOW_MINUTES,
} from "@/lib/commercial/field-ops/clock-window";
import { SubmitButton } from "@/components/commercial/submit-button";

/**
 * Field-operations settings — admin-only. Today it holds one tunable: the
 * clock-in override PIN. Crew can't clock in until CLOCK_WINDOW_MINUTES before
 * their scheduled start (stops early/accidental punches); Alex enters this PIN
 * on the field page to clock someone in early for the legitimate case.
 * (Karan 2026-08-14.)
 */

export const dynamic = "force-dynamic";
const BASE = "/commercial/settings/field-ops";

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");
  return user;
}

async function savePinAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const raw = String(formData.get("pin") ?? "").trim();
  if (!/^\d{4,8}$/.test(raw)) {
    redirect(`${BASE}?error=${encodeURIComponent("PIN must be 4–8 digits.")}`);
  }
  await setCommercialSetting(CLOCK_OVERRIDE_PIN_KEY, raw, user.id);
  redirect(`${BASE}?ok=saved`);
}

export default async function FieldOpsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const pin = await getCommercialSetting<string>(CLOCK_OVERRIDE_PIN_KEY, DEFAULT_CLOCK_OVERRIDE_PIN);

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <Link
        href="/commercial/settings"
        className="inline-flex items-center gap-1 text-[13px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 min-h-[44px]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        Settings
      </Link>

      <div>
        <h1 className="text-xl font-bold text-ppp-charcoal">Field operations</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-0.5">Clock-in rules for the crew magic-link.</p>
      </div>

      {sp.ok === "saved" && (
        <div role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2.5 text-sm text-emerald-800">Saved.</div>
      )}
      {sp.error && (
        <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-2.5 text-sm text-rose-800">{sp.error}</div>
      )}

      <section className="rounded-xl border border-ppp-charcoal-100 bg-surface p-5">
        <h2 className="text-[14px] font-bold text-ppp-charcoal">Clock-in override PIN</h2>
        <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 mb-3">
          Crew can&rsquo;t clock in until <strong>{CLOCK_WINDOW_MINUTES} minutes</strong> before their scheduled
          start — it stops early or accidental punches on a job that hasn&rsquo;t begun. To clock someone in
          early for a real reason, enter this PIN on their field page.
        </p>
        <form action={savePinAction} className="flex items-end gap-2 flex-wrap">
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-ppp-charcoal-500 mb-1">PIN (4–8 digits)</span>
            <input
              name="pin"
              defaultValue={pin}
              inputMode="numeric"
              pattern="\d*"
              maxLength={8}
              required
              className="w-40 rounded-lg border border-ppp-charcoal-200 px-3 py-2 min-h-[44px] text-[16px] tabular-nums focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600"
            />
          </label>
          <SubmitButton className="inline-flex items-center px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 min-h-[44px]">
            Save PIN
          </SubmitButton>
        </form>
      </section>
    </div>
  );
}
