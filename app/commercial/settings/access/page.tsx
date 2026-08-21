import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { listManagedUsers } from "@/lib/auth/user-management";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { normalizeEmail } from "@/lib/auth/admin";
import CommercialAccessManager from "@/components/commercial/commercial-access-manager";
import { isCrewOnlyUser } from "@/lib/commercial/crew-access";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import {
  listScheduleRecipients,
  addScheduleRecipient,
  removeScheduleRecipient,
} from "@/lib/commercial/field-ops/schedule-emails";
import { listEmployees, updateEmployee } from "@/lib/commercial/field-ops/employees";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { SubmitButton } from "@/components/commercial/submit-button";
import { UUID_RE } from "@/lib/commercial/uuid";

const ACCESS = "/commercial/settings/access";

async function requireAccessAdmin(): Promise<string> {
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
  await requireAccessAdmin();
  const res = await addScheduleRecipient(String(formData.get("email") ?? ""), String(formData.get("label") ?? ""));
  revalidatePath(ACCESS);
  redirect(res.ok ? ACCESS : `${ACCESS}?se_error=${encodeURIComponent(res.error)}`);
}

async function removeRecipientAction(formData: FormData) {
  "use server";
  await requireAccessAdmin();
  const res = await removeScheduleRecipient(String(formData.get("id") ?? ""));
  revalidatePath(ACCESS);
  redirect(res.ok ? ACCESS : `${ACCESS}?se_error=${encodeURIComponent(res.error)}`);
}

/** Grant / revoke the Crew role — the scoped self-service login. */
async function toggleCrewAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial");
  const targetId = String(formData.get("user_id") ?? "");
  if (!targetId) redirect("/commercial/settings/access");
  // An admin can't be made crew-only — isCrewOnlyUser already ignores the role
  // when other roles exist, but blocking it here keeps the UI honest instead of
  // showing a toggle that does nothing.
  const { setCrewRole } = await import("@/lib/commercial/crew-access");
  const makeCrew = String(formData.get("make_crew") ?? "") === "1";
  const res = await setCrewRole(targetId, makeCrew, user.id);
  revalidatePath("/commercial/settings/access");
  redirect(
    res.ok
      ? "/commercial/settings/access"
      : `/commercial/settings/access?se_error=${encodeURIComponent(res.error)}`
  );
}

/**
 * Turn email notifications on or off for one person.
 *
 * Karan 2026-08-18: "Brendan should receive emails for approvals and stuff …
 * and even me, Katie, Stephanie … if we have it on they receive email
 * notifications for everything basically."
 *
 * The bell is always the source of truth; email has been opt-in since
 * 2026-07-27 and there was no way to turn it on for somebody else — so the
 * people who most need to be told (the approver, the owner) were bell-only
 * unless they went and configured it themselves, which nobody had.
 *
 * ON writes their profile email into commercial_user_email_prefs and enables
 * it, so every commercial notification they'd get in the bell also emails.
 * OFF leaves the address saved and just disables delivery, so turning it back
 * on doesn't lose the address.
 */
async function toggleUserEmailAction(formData: FormData) {
  "use server";
  await requireAccessAdmin();
  const userId = String(formData.get("user_id") ?? "");
  const enable = String(formData.get("enable") ?? "") === "1";
  const email = String(formData.get("email") ?? "").trim();
  if (!UUID_RE.test(userId)) redirect("/commercial/settings/access");
  const { saveUserNotifyEmail, setUserEmailEnabled, getUserEmailPref } = await import(
    "@/lib/commercial/email-prefs/db"
  );
  if (enable) {
    const existing = await getUserEmailPref(userId);
    // Re-enable a saved address if there is one; otherwise seed it from their
    // login email, which is the address they already receive everything at.
    const res = existing?.email
      ? await setUserEmailEnabled({ userId, enabled: true })
      : await saveUserNotifyEmail({ userId, email });
    if (!("ok" in res) || !res.ok) {
      redirect(
        "/commercial/settings/access?se_error=" +
          encodeURIComponent("Couldn't turn on email notifications — check the address on their profile.")
      );
    }
  } else {
    const off = await setUserEmailEnabled({ userId, enabled: false });
    // Turning email ON already reports failure; turning it OFF didn't, so a
    // failed opt-out looked identical to a successful one — and the person
    // keeps getting mail they just told the platform to stop sending.
    if (!off.ok) {
      redirect(
        "/commercial/settings/access?se_error=" +
          encodeURIComponent(off.error ?? "Couldn't turn off email notifications. Please try again.")
      );
    }
  }
  revalidatePath("/commercial/settings/access");
}

async function toggleOptOutAction(formData: FormData) {
  "use server";
  const userId = await requireAccessAdmin();
  const res = await updateEmployee(String(formData.get("id") ?? ""), { schedule_email_opt_out: String(formData.get("opt_out") ?? "") === "1" }, userId);
  revalidatePath(ACCESS);
  // `se_error` is what this page reads — its siblings all use it. `?error=`
  // rendered nothing, so a failed toggle looked like it worked.
  if (!res.ok) redirect(`${ACCESS}?se_error=${encodeURIComponent(res.error ?? "Could not change that setting.")}`);
  redirect(ACCESS);
}

/**
 * Commercial Settings → Access.
 *
 * Admin-only. Provisions Commercial-ONLY email+password logins (Tomco crew,
 * estimators, testers) — the mirror of the residential Settings → Access, but
 * every account created here gets Commercial access and NOT Command Center
 * access. "Added from the Commercial side → Commercial only." Someone who needs
 * BOTH platforms (Karan / Katie / Alex) is granted manually.
 *
 * Commercial has a single access level (no sub-roles) — if you have Commercial
 * access you see everything. So there's no role picker here, unlike the PPP side.
 */

export const dynamic = "force-dynamic";

export default async function CommercialAccessPage({ searchParams }: { searchParams: Promise<{ se_error?: string }> }) {
  const seError = (await searchParams).se_error;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  // Provisioning is admin-only (true platform admins), even though Commercial
  // itself is single-level. A Commercial tester is NOT an admin and never lands
  // here — the layout already let them into /commercial; this is the extra gate.
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial/settings/operating-company");

  // Only accounts that actually have Commercial access. Both-platform admins
  // (managed on the PPP Access page) are shown too so the list is honest about
  // who can reach Commercial.
  const users = (await listManagedUsers()).filter((u) => u.has_new_platform_access);
  // Which of them currently get emails, so the button can show real state
  // rather than a toggle that always reads the same.
  const { getUserEmailPref } = await import("@/lib/commercial/email-prefs/db");
  const emailOnUserIds = new Set(
    (
      await Promise.all(
        users.map(async (u) => ((await getUserEmailPref(u.user_id))?.enabled ? u.user_id : null))
      )
    ).filter(Boolean) as string[]
  );
  // R1d: who can approve proposals (besides admins, who always can). Stored on
  // the operating-company singleton; toggled per-user below.
  const oc = await getOperatingCompany();
  const approverEmails = (oc.approver_emails ?? []).map((e) => normalizeEmail(e));
  const receiverEmails = (oc.receiver_emails ?? []).map((e) => normalizeEmail(e));
  // R10: schedule-email settings, inline (no separate click-through).
  const [scheduleRecipients, crew] = await Promise.all([listScheduleRecipients(), listEmployees()]);
  // Who currently holds the Crew role (scoped self-service login).
  const crewRoleUserIds = new Set(
    (await Promise.all(
      users.map(async (u) => ((await isCrewOnlyUser(u.user_id)) ? u.user_id : null))
    )).filter((v): v is string => !!v)
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 animate-fade-up">
      <Link
        href="/commercial/settings"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 min-h-[44px] sm:min-h-[36px]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Settings
      </Link>
      <header className="mb-5">
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal">Access</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-2xl">
          Give someone a Commercial login — email + password, no Google needed.
          Accounts made here can reach the Commercial Command Center only, not PPP
          Command Center. Anyone who needs both is set up separately.
        </p>
      </header>

      {/* Roles key.
          Karan 2026-08-21: this was ~150 words of explanation standing between
          the heading and anything you could actually do — a lecture before the
          page. Every one of those sentences is now the tooltip on the toggle it
          describes, where it is read at the moment it matters. What survives
          here is the one thing that is NOT visible from a toggle: that a
          proposal is blocked until an approver approves it. */}
      <details className="bg-ppp-charcoal-50/60 border border-ppp-charcoal-100 rounded-xl mb-5">
        <summary className="list-none cursor-pointer px-4 py-2.5 text-[12.5px] font-semibold text-ppp-charcoal-700 min-h-[44px] flex items-center gap-2">
          <span className="text-cc-brand-700">Admin · Approver · Receiver — what they mean</span>
        </summary>
        <dl className="px-4 pb-4 space-y-2">
          <div>
            <dt className="text-[13px] font-semibold text-ppp-charcoal inline">Admin</dt>
            <dd className="text-[12.5px] text-ppp-charcoal-500 inline"> — everything, including provisioning logins. Admins can always approve proposals, so the Approver toggle is for people who are not admins.</dd>
          </div>
          <div>
            <dt className="text-[13px] font-semibold text-ppp-charcoal inline">Approver</dt>
            <dd className="text-[12.5px] text-ppp-charcoal-500 inline"> — <strong>a proposal cannot be emailed to a GC until an approver approves it.</strong> Every approver is alerted the moment approval is requested.</dd>
          </div>
          <div>
            <dt className="text-[13px] font-semibold text-ppp-charcoal inline">Receiver</dt>
            <dd className="text-[12.5px] text-ppp-charcoal-500 inline"> — watches without approving: pinged when a proposal is approved or sent back.</dd>
          </div>
        </dl>
      </details>

      <CommercialAccessManager
        initialUsers={users}
        currentUserId={user.id}
        initialApproverEmails={approverEmails}
        initialReceiverEmails={receiverEmails}
        crewUserIds={[...crewRoleUserIds]}
        emailOnUserIds={[...emailOnUserIds]}
        toggleCrewAction={toggleCrewAction}
        toggleUserEmailAction={toggleUserEmailAction}
      />

      {/* The standalone "Crew logins" list lived here and has been removed.
          Karan 2026-08-21: "the whole access page is so messy, unorganized,
          confusing".

          It re-listed every person a second time to show two controls — the
          crew restriction and the notification-email switch — and for admins,
          who are the majority here, the crew half printed the dead sentence
          "Admin — always unrestricted". Both controls now sit on the person's
          own row above, where everything else about them already was, and the
          crew one only renders where it can actually apply.

          The notification-email switch being in a section titled "Crew logins"
          was the worst of it: that is the switch deciding who gets emailed, and
          it was filed under a heading nobody with that question would open. */}

      {/* R10: schedule emails — inline, right here on Access. */}
      <section className="mt-8">
        <div className="mb-3">
          <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
          <h2 className="text-xl font-bold tracking-tight text-ppp-charcoal">Schedule Emails</h2>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-2xl">Every crew member gets their own weekly schedule emailed to them by default — turn it off per person below. Add office people who should get the full weekly schedule for all crews.</p>
          {seError && <div className="mt-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[12.5px] text-rose-700">{seError}</div>}
        </div>

        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 mb-4">
          <h3 className="text-[13px] font-bold text-ppp-charcoal">Office recipients — full weekly schedule</h3>
          <form action={addRecipientAction} className="flex flex-col sm:flex-row gap-2 my-3">
            <input name="email" type="email" required placeholder="stephanie@tomcopainting.com" className={`${INPUT_CLS} flex-1`} />
            <input name="label" placeholder="Name (optional)" className={`${INPUT_CLS} sm:w-44`} />
            <SubmitButton
              className="inline-flex items-center justify-center px-4 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
            >Add</SubmitButton>
          </form>
          {scheduleRecipients.length === 0 ? (
            <p className="text-[12.5px] text-ppp-charcoal-500">No office recipients yet.</p>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {scheduleRecipients.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0"><span className="text-[13px] font-medium text-ppp-charcoal">{r.label ? `${r.label} · ` : ""}</span><span className="text-[12.5px] text-ppp-charcoal-600">{r.email}</span></div>
                  <form action={removeRecipientAction}><input type="hidden" name="id" value={r.id} /><SubmitButton
                                                                                                       className="inline-flex items-center px-2 rounded-lg text-base sm:text-[12px] font-semibold text-rose-600 hover:bg-rose-50 min-h-[44px] touch-manipulation"
                                                                                                     >Remove</SubmitButton></form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
          <h3 className="text-[13px] font-bold text-ppp-charcoal">Crew — personal schedule email</h3>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5 mb-3">On for everyone by default.</p>
          {crew.length === 0 ? (
            <p className="text-[12.5px] text-ppp-charcoal-500">No crew yet — <Link href="/commercial/field-ops/employees" className="font-semibold text-cc-brand-700 underline">add your crew</Link> first.</p>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {crew.map((e) => {
                const on = !e.schedule_email_opt_out;
                const noEmail = !e.email;
                return (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ppp-charcoal truncate">{e.display_name}</div>
                      <div className="text-[11.5px] text-ppp-charcoal-500 truncate">{noEmail ? <span className="text-amber-700">No email on file</span> : e.email}</div>
                    </div>
                    {noEmail ? (
                      <Link href="/commercial/field-ops/employees" className="text-[12px] font-semibold text-cc-brand-700 hover:underline shrink-0">Add email</Link>
                    ) : (
                      <form action={toggleOptOutAction} className="shrink-0">
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="opt_out" value={on ? "1" : "0"} />
                        <SubmitButton
                          className={`inline-flex items-center px-3 rounded-lg text-[12px] font-semibold min-h-[44px] touch-manipulation ${on ? "bg-ppp-green-50 text-ppp-green-700 hover:bg-ppp-green-100" : "bg-ppp-charcoal-50 text-ppp-charcoal-500 hover:bg-ppp-charcoal-100"}`}
                        >{on ? "Email: on" : "Email: off"}</SubmitButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
