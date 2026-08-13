import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { SubmitButton } from "@/components/commercial/submit-button";
import { getRatingLabels, updateRatingLabel } from "@/lib/commercial/accounts/rating-labels";
import { RATING_CODES, isRatingCode } from "@/lib/commercial/accounts/rating-codes";

/**
 * What A / B / C mean — Settings → Ratings. Admin-only.
 *
 * Stephanie 2026-08-13: *"Rating system? Can we personalize these..."*
 *
 * The letters themselves are NOT editable, and that is the design rather than
 * a shortcut. Renaming a code would mean re-grading every account that already
 * holds it, and would break the accounts filter, the A-first sort and the CSV
 * export — all for a cosmetic change. What actually stops the field being used
 * is that nobody knows what B means, so what is editable is the MEANING, which
 * then prints next to the letter everywhere it appears.
 *
 * Mobile: single column, every control ≥44px.
 */

export const dynamic = "force-dynamic";

const BASE = "/commercial/settings/ratings";

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

async function saveAction(formData: FormData) {
  "use server";
  const user = await requireAdmin();
  const code = String(formData.get("code") ?? "");
  if (!isRatingCode(code)) redirect(BASE);
  const res = await updateRatingLabel({
    code,
    label: String(formData.get("label") ?? ""),
    description: String(formData.get("description") ?? ""),
    actorUserId: user.id,
  });
  if (!res.ok) redirect(`${BASE}?error=${encodeURIComponent(res.error)}`);
  // The pills render on the accounts list and every account page.
  revalidatePath("/commercial/accounts");
  revalidatePath(BASE);
  redirect(`${BASE}?saved=${code}`);
}

export default async function RatingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const labels = await getRatingLabels();

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div>
        <Link
          href="/commercial/settings"
          className="text-[12.5px] text-ppp-charcoal-500 hover:text-ppp-charcoal-800 inline-flex items-center min-h-[44px]"
        >
          ← Settings
        </Link>
        <h1 className="text-xl font-bold text-ppp-charcoal">Account ratings</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1 leading-relaxed">
          A, B and C appear on every account. Say what they mean here and the meaning shows
          alongside the letter everywhere it is used — so the grade is worth reading rather than
          being a letter only its author understands.
        </p>
      </div>

      {sp.error && (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-900">
          {sp.error}
        </div>
      )}
      {sp.saved && !sp.error && (
        <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-900">
          <strong className="font-semibold">Saved.</strong> Rating {sp.saved} now reads
          &ldquo;{labels[sp.saved as "A" | "B" | "C"]?.label}&rdquo; across the platform.
        </div>
      )}

      {RATING_CODES.map((code) => (
        <form
          key={code}
          action={saveAction}
          className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3 shadow-sm"
        >
          <input type="hidden" name="code" value={code} />
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center h-8 w-8 rounded-lg text-[13px] font-bold border ${
                code === "A"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : code === "B"
                  ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"
                  : "bg-amber-50 text-amber-700 border-amber-200"
              }`}
            >
              {code}
            </span>
            <span className="text-[12px] text-ppp-charcoal-500">
              The letter itself doesn&rsquo;t change — renaming it would re-grade every account
              already marked {code}.
            </span>
          </div>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
              What it means
            </span>
            <input
              type="text"
              name="label"
              maxLength={60}
              required
              defaultValue={labels[code].label}
              className="mt-1 w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-[14px] min-h-[44px]"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
              When to use it <span className="font-normal normal-case tracking-normal text-ppp-charcoal-400">· optional</span>
            </span>
            <textarea
              name="description"
              maxLength={300}
              rows={2}
              defaultValue={labels[code].description ?? ""}
              placeholder="e.g. Pays on time, runs clean jobs — bid everything they send."
              className="mt-1 w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-[14px]"
            />
            <span className="block text-[11.5px] text-ppp-charcoal-500 mt-1">
              Shown on hover wherever the rating appears, so whoever grades the next account uses
              the same rule as the last one.
            </span>
          </label>

          <SubmitButton
            pendingLabel="Saving…"
            className="inline-flex items-center px-4 min-h-[44px] rounded-lg bg-ppp-charcoal-800 text-surface text-[13px] font-semibold hover:bg-ppp-navy-900"
          >
            Save {code}
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}
