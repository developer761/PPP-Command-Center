import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import {
  getDigestSettings,
  setDigestSettings,
  sendDigest,
  type DigestCadence,
} from "@/lib/commercial/reports/alex-digest";
import { receivablesRecipients } from "@/lib/commercial/reports/receivables-email";

/**
 * Settings › Recurring Reports.
 *
 * Karan 2026-09-17: "put this in settings, make a new tab for it and call it
 * Recurring Reports."
 *
 * It sat on the Accounting overview, between two blocks of figures, which is
 * the wrong shelf twice over: it is a SETTING, not a number, and it is
 * something you touch once and then leave alone — so every day it was taking
 * space on the page Mary works in, from a control nobody was going to press.
 *
 * Still built, scheduled, and OFF. Karan, when it was built: "we need to get
 * everything 100 percent perfect before we do so" — the hold is the feature.
 * Preview mails it to whoever pressed it; nothing reaches Alex until a switch
 * here is deliberately flipped.
 */

export const dynamic = "force-dynamic";
// Just the page name — the /commercial layout's template adds the suffix.
export const metadata = { title: "Recurring reports" };

const BASE = "/commercial/settings/recurring-reports";

const CADENCES: { key: DigestCadence; label: string; when: string }[] = [
  { key: "daily", label: "Daily", when: "Every morning" },
  { key: "weekly", label: "Weekly", when: "Monday mornings" },
  { key: "monthly", label: "Monthly", when: "The 1st" },
];


/**
 * Admin only — this decides what lands in the CEO's inbox and how often.
 *
 * The page carried the same `assertCommercialAccess` as a read-only screen, so
 * anyone with Commercial access could flip the digest on or change its
 * cadence. The Settings index is admin-gated, so nobody would find it by
 * clicking — but "you can only get there if you know the URL" is not a
 * permission, and this is the first non-admin login (Kim, estimating) where
 * that distinction stops being theoretical.
 *
 * Deliberately NOT applied to Settings › Operating company, which is open on
 * purpose (Karan 2026-07-31, so Brendan can set his own signature).
 */
async function requireSettingsAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const { getProfileByUserId } = await import("@/lib/auth/profile");
  const { isAdminEmail } = await import("@/lib/auth/admin");
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");
  return user;
}

async function toggleDigestAction(formData: FormData) {
  "use server";
  const user = await requireSettingsAdmin();
  const cadence = String(formData.get("cadence") ?? "") as DigestCadence;
  if (!["daily", "weekly", "monthly"].includes(cadence)) return;
  await setDigestSettings({ [cadence]: String(formData.get("on")) === "1" }, user.id);
  revalidatePath(BASE);
}

/**
 * Preview it — addressed to WHOEVER PRESSED THIS, never to Alex.
 *
 * The whole point of the hold: you read the exact email he would get, in your
 * own inbox, before anything is switched on. A preview that went to him would
 * defeat the thing it exists for.
 */
async function previewDigestAction(formData: FormData) {
  "use server";
  const user = await requireSettingsAdmin();
  if (!user.email) redirect("/");
  const raw = String(formData.get("cadence") ?? "daily");
  const cadence = (["daily", "weekly", "monthly"].includes(raw) ? raw : "daily") as DigestCadence;
  const res = await sendDigest(cadence, [user.email]);
  revalidatePath(BASE);
  redirect(
    res.ok ? `${BASE}?preview=${encodeURIComponent(user.email)}` : `${BASE}?error=${encodeURIComponent(res.error)}`
  );
}

export default async function RecurringReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSettingsAdmin();

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const previewedTo = one(sp.preview);
  const error = one(sp.error);

  const digest = await getDigestSettings();
  const recipients = receivablesRecipients();
  const anyOn = digest.daily || digest.weekly || digest.monthly;

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-6 py-6 space-y-5">
      <div>
        <Link
          href="/commercial/settings"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] sm:min-h-[32px] -ml-1 px-1"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Settings
        </Link>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none mt-1">
          Recurring Reports
        </h1>
        <p className="text-[12.5px] text-ppp-charcoal-500 mt-1.5 max-w-2xl leading-relaxed">
          The whole picture in Alex&rsquo;s inbox on a schedule — is the company making money, what is owed, what came
          in, what is still to bill, and the AR sheet in full.
        </p>
      </div>

      {previewedTo && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Preview sent to <strong>{previewedTo}</strong> — that is the exact email Alex would get.
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 break-words">
          {error}
        </div>
      )}

      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p className="text-[12.5px] text-ppp-charcoal-600 max-w-lg leading-relaxed">
            <strong className="text-ppp-charcoal">
              {anyOn ? `Sending to ${recipients.join(", ")}.` : "Nothing is being sent."}
            </strong>{" "}
            Read one yourself before switching anything on — the preview goes to you, not to him.
          </p>
          <form action={previewDigestAction} className="shrink-0">
            <input type="hidden" name="cadence" value="weekly" />
            <PendingSubmitButton
              pendingLabel="Sending…"
              className="inline-flex items-center min-h-[40px] px-3.5 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-ppp-charcoal hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors"
            >
              Preview it to me
            </PendingSubmitButton>
          </form>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {CADENCES.map((c) => {
            const on = digest[c.key];
            return (
              <form key={c.key} action={toggleDigestAction}>
                <input type="hidden" name="cadence" value={c.key} />
                <input type="hidden" name="on" value={on ? "0" : "1"} />
                <PendingSubmitButton
                  pendingLabel="…"
                  className={`w-full inline-flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg border text-left min-h-[56px] transition-colors ${
                    on
                      ? "bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
                      : "bg-surface border-ppp-charcoal-200 hover:border-cc-brand-300"
                  }`}
                >
                  <span className="min-w-0">
                    <span className={`block text-[13px] font-bold ${on ? "text-emerald-800" : "text-ppp-charcoal"}`}>
                      {c.label}
                    </span>
                    <span className="block text-[11px] text-ppp-charcoal-500">
                      {on ? `On · ${c.when.toLowerCase()}` : c.when}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={`shrink-0 inline-flex items-center w-9 h-5 rounded-full px-0.5 ${
                      on ? "bg-emerald-600 justify-end" : "bg-ppp-charcoal-200 justify-start"
                    }`}
                  >
                    <span className="w-4 h-4 rounded-full bg-white" />
                  </span>
                </PendingSubmitButton>
              </form>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-ppp-charcoal-100 bg-surface p-4 sm:p-5">
        <h2 className="text-[13px] font-bold text-ppp-charcoal mb-2">What each email carries</h2>
        <ul className="text-[12.5px] text-ppp-charcoal-600 space-y-1.5 leading-relaxed">
          <li>
            <strong className="text-ppp-charcoal">Are we making money?</strong> — net profit, margin, gross revenue and
            job costs, whole company.
          </li>
          <li>
            <strong className="text-ppp-charcoal">What we are owed</strong> — outstanding, collectible now, past due,
            retention held.
          </li>
          <li>
            <strong className="text-ppp-charcoal">The period</strong> — money in and out, what has not been deposited,
            sales tax, reimbursements.
          </li>
          <li>
            <strong className="text-ppp-charcoal">The AR sheet</strong> — every certified line waiting to be paid,
            grouped by job, retention on its own line.
          </li>
        </ul>
        <p className="text-[11.5px] text-ppp-charcoal-400 mt-3 leading-relaxed">
          Only one email goes out on a day where two cadences land together, so the 1st of a Monday does not arrive
          twice.
        </p>
      </section>
    </div>
  );
}
